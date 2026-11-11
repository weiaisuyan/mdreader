import { release as readOsRelease } from 'node:os'
import koffi from 'koffi'

/**
 * Windows 窗口样式位修补。
 *
 * ## 为什么需要这个
 *
 * 应用想要「系统原生动画」就必须保留 `WS_CAPTION`（见 electron/electron#751：
 * 无边框窗口要动画需要 WS_POPUP | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_CAPTION）。
 * 但 `frame: true` 会一并带回 `WS_THICKFRAME` —— 系统据此在窗口外沿画一圈可调边框，
 * 实测内容区比窗口外框小 14×8px（左右各 7px、上下各 4px）。
 *
 * 渲染层的青色边框是绝对定位 div，只能画在**内容区**内，于是窗口上沿那条边框
 * 离外框还有 4px，肉眼看不见；只有最大化时系统不画可调边框，它才露出来。
 *
 * `thickFrame: false` 能去掉可调边框让内容铺满，但 Electron 同时会把 `WS_CAPTION`
 * 一起去掉（窗口退化成 WS_POPUP），动画又没了。
 *
 * 所以这里在窗口创建后手动把 `WS_CAPTION` 补回去：
 *   · `thickFrame: false` → 没有可调边框，内容铺满整个窗口，边框四边可见；
 *   · 手工补 `WS_CAPTION` → 最小化/最大化/任务栏点击的系统动画照常工作。
 *
 * 只加 CAPTION、不加 THICKFRAME，所以不会把可调边框带回来。
 */

const GWL_STYLE = -16
const WS_CAPTION = 0x00C00000 // WS_BORDER | WS_DLGFRAME

// SetWindowPos 标志
const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOZORDER = 0x0004
const SWP_NOACTIVATE = 0x0010
const SWP_FRAMECHANGED = 0x0020 // 让系统重新计算非客户区，样式才会真正生效

// DWM 窗口属性（Windows 11 / build 22000 起提供）
const DWMWA_WINDOW_CORNER_PREFERENCE = 33
const DWMWA_BORDER_COLOR = 34
const DWMWCP_DONOTROUND = 1
const DWMWCP_ROUND = 2
// DWMWA_COLOR_NONE：让 DWM 不画自己那条 1px 边框（0xFFFFFFFE）
const DWMWA_COLOR_NONE = 0xFFFFFFFE
const WINDOWS_11_FIRST_BUILD = 22000

let user32 = null
let fns = null
let dwmapi = null
let dwmFns = null

/**
 * 惰性加载 user32 与所需函数。
 *
 * 只在 Windows 上调用；加载失败时整个能力降级为「什么都不做」，
 * 绝不能因为补样式失败而让窗口建不出来。
 *
 * @returns {boolean} 是否可用
 */
function ensureApi() {
  if (fns) {
    return true
  }
  if (process.platform !== 'win32') {
    return false
  }
  try {
    user32 = koffi.load('user32.dll')
    fns = {
      GetWindowLongPtrW: user32.func(
        'intptr_t __stdcall GetWindowLongPtrW(intptr_t hWnd, int nIndex)',
      ),
      SetWindowLongPtrW: user32.func(
        'intptr_t __stdcall SetWindowLongPtrW(intptr_t hWnd, int nIndex, intptr_t dwNewLong)',
      ),
      SetWindowPos: user32.func(
        'bool __stdcall SetWindowPos(intptr_t hWnd, intptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags)',
      ),
      IsZoomed: user32.func('bool __stdcall IsZoomed(intptr_t hWnd)'),
    }
    return true
  } catch (error) {
    console.warn('[windowStyle] user32 加载失败，跳过样式修补:', error?.message)
    fns = null
    return false
  }
}

/**
 * 从 Electron 的 native handle 里取出 HWND 数值。
 *
 * `getNativeWindowHandle()` 返回的是平台原生句柄的 Buffer；x64 下是 8 字节小端。
 * HWND 的高位在实际系统里恒为 0，转成 Number 不会丢精度。
 *
 * @param {Buffer} buffer native handle
 * @returns {number | null} HWND；无效时返回 null
 */
function readHwnd(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return null
  }
  if (buffer.length >= 8) {
    const value = buffer.readBigUInt64LE(0)
    // 超过安全整数范围说明不是正常 HWND，直接放弃
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null
    }
    return Number(value)
  }
  return buffer.readUInt32LE(0)
}

/**
 * 把 `WS_CAPTION` 补回窗口样式。
 *
 * 已经带有 CAPTION 时直接返回，不重复触发 `SetWindowPos`。
 *
 * @param {import('electron').BrowserWindow} win 目标窗口
 * @returns {boolean} 是否发生了修改
 */
export function ensureWindowCaptionStyle(win) {
  if (!win || win.isDestroyed?.() === true) {
    return false
  }
  if (!ensureApi()) {
    return false
  }

  let hwnd = null
  try {
    hwnd = readHwnd(win.getNativeWindowHandle())
  } catch (error) {
    console.warn('[windowStyle] 读取 HWND 失败:', error?.message)
    return false
  }
  if (hwnd === null) {
    return false
  }

  try {
    const style = Number(fns.GetWindowLongPtrW(hwnd, GWL_STYLE))
    if ((style & WS_CAPTION) === WS_CAPTION) {
      return false
    }
    const nextStyle = style | WS_CAPTION
    fns.SetWindowLongPtrW(hwnd, GWL_STYLE, nextStyle)
    // 改完样式位必须让系统重算非客户区，否则新样式在视觉和行为上都不生效
    fns.SetWindowPos(
      hwnd,
      0,
      0,
      0,
      0,
      0,
      SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
    )
    return true
  } catch (error) {
    console.warn('[windowStyle] 设置 WS_CAPTION 失败:', error?.message)
    return false
  }
}

/**
 * 窗口当前是否最大化。
 *
 * @param {import('electron').BrowserWindow} win 目标窗口
 * @returns {boolean}
 */
export function isNativeWindowZoomed(win) {
  if (!win || win.isDestroyed?.() === true || !ensureApi()) {
    return false
  }
  try {
    const hwnd = readHwnd(win.getNativeWindowHandle())
    if (hwnd === null) {
      return false
    }
    return fns.IsZoomed(hwnd) === true
  } catch {
    return false
  }
}

/**
 * 读取 Windows build 号（os.release() 形如 `10.0.22631`，第三段才是 build）。
 *
 * Windows 11 从 build 22000 起才有 DWM 圆角属性；
 * Windows 10 上调用会返回 E_INVALIDARG，所以先判版本、直接跳过。
 *
 * @returns {number} build 号；无法解析时返回 0
 */
function resolveWindowsBuildNumber() {
  const segments = String(readOsRelease() ?? '').split('.')
  const build = Number(segments[2])
  return Number.isFinite(build) ? build : 0
}

/**
 * 惰性加载 dwmapi。
 *
 * 失败一律降级为「什么都不做」：圆角只是观感，不能因为它让窗口建不出来。
 *
 * @returns {boolean} 是否可用
 */
function ensureDwmApi() {
  if (dwmFns) {
    return true
  }
  if (process.platform !== 'win32') {
    return false
  }
  if (resolveWindowsBuildNumber() < WINDOWS_11_FIRST_BUILD) {
    return false
  }
  try {
    dwmapi = koffi.load('dwmapi.dll')
    dwmFns = {
      DwmSetWindowAttribute: dwmapi.func(
        'long __stdcall DwmSetWindowAttribute(intptr_t hwnd, uint dwAttribute, void *pvAttribute, uint cbAttribute)',
      ),
    }
    return true
  } catch (error) {
    console.warn('[windowStyle] dwmapi 加载失败，跳过原生圆角:', error?.message)
    dwmFns = null
    return false
  }
}

/**
 * 把 32 位整数值包成 DWM 需要的属性缓冲区。
 *
 * @param {number} value 待写入的 int32
 * @returns {Buffer} 4 字节小端缓冲
 */
function createInt32AttributeBuffer(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeInt32LE(value, 0)
  return buffer
}

/**
 * 把 32 位无符号整数值包成 DWM 需要的属性缓冲区。
 *
 * `DWMWA_COLOR_NONE` 等于 0xFFFFFFFE，超出 int32 正数范围，
 * 必须用 `writeUInt32LE` 才能原样写进去。
 *
 * @param {number} value 待写入的 uint32
 * @returns {Buffer} 4 字节小端缓冲
 */
function createUint32AttributeBuffer(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0, 0)
  return buffer
}

/**
 * 打开/关闭窗口的原生圆角（Windows 11 DWM）。
 *
 * ## 为什么需要这个
 *
 * 主进程用 `thickFrame: false` 拿掉可调边框、再手工补 `WS_CAPTION`，
 * 结果窗口**没有 `WS_THICKFRAME`**，DWM 不给它上圆角 —— 窗口轮廓是直角。
 * 渲染层只能在内容区里画一圈 8px 圆角的青色边框，于是四个角外面各留一块
 * 方形的窗口底色，看起来就像「圆角边框压在直角上」（用户反馈的现象）。
 *
 * 用 `DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND` 让 DWM 自己按 8px 裁圆，
 * 方形角被裁掉，渲染层那圈 8px 圆角边框正好落在系统圆角之内。
 *
 * 最大化时不需要（DWM 会忽略），全屏同理；调用方按需传 `rounded: false`。
 *
 * @param {import('electron').BrowserWindow} win 目标窗口
 * @param {{ rounded?: boolean }} [options] rounded=false 时显式关掉圆角
 * @returns {boolean} 是否设置成功
 */
export function applyNativeRoundedCorners(win, options = {}) {
  const { rounded = true } = options
  if (!win || win.isDestroyed?.() === true || !ensureDwmApi()) {
    return false
  }

  let hwnd = null
  try {
    hwnd = readHwnd(win.getNativeWindowHandle())
  } catch (error) {
    console.warn('[windowStyle] 设置原生圆角时读取 HWND 失败:', error?.message)
    return false
  }
  if (hwnd === null) {
    return false
  }

  try {
    const preferenceBuffer = createInt32AttributeBuffer(rounded ? DWMWCP_ROUND : DWMWCP_DONOTROUND)
    const hresult = dwmFns.DwmSetWindowAttribute(
      hwnd,
      DWMWA_WINDOW_CORNER_PREFERENCE,
      preferenceBuffer,
      4,
    )
    // S_OK = 0；负值（如 E_INVALIDARG）表示系统不支持该属性，降级即可
    if (hresult !== 0) {
      console.warn('[windowStyle] DwmSetWindowAttribute(圆角偏好) 返回非 0:', hresult)
      return false
    }
    return true
  } catch (error) {
    console.warn('[windowStyle] 设置原生圆角失败:', error?.message)
    return false
  }
}

/**
 * 一次性设置窗口的原生外框观感：8px 圆角 + 去掉系统自绘边框。
 *
 * ## 为什么还要去掉系统边框
 *
 * 只设置圆角还不够。Windows 11 的 DWM 会在窗口最外沿自己画一条 1px 边框，
 * 颜色随「窗口是否激活 / 是否被拖动」变化，并且正好压在渲染层青色边框所在的那 1~2px 上：
 *   · 窗口激活时它可能接近透明，青色边框看得见；
 *   · 窗口失活 / 拖动 / 切换屏幕后它变成浅灰，把青色边框盖住 ——
 *     用户看到的就是「某些边的青色边框消失了」。
 *
 * `DWMWA_BORDER_COLOR = DWMWA_COLOR_NONE` 让 DWM 不再画这条边，
 * 外框只剩渲染层那一圈，颜色和粗细就不再随窗口状态漂移。
 *
 * 两条属性都是幂等的，可以在 move / resize / maximize / focus 之后重复调用，
 * 保证状态切换后观感不跑偏。
 *
 * @param {import('electron').BrowserWindow} win 目标窗口
 * @param {{ rounded?: boolean, hideSystemBorder?: boolean }} [options]
 * @returns {boolean} 是否全部设置成功（任一失败返回 false，但能设的都已设）
 */
export function applyNativeFrameAppearance(win, options = {}) {
  const { rounded = true, hideSystemBorder = true } = options
  if (!win || win.isDestroyed?.() === true || !ensureDwmApi()) {
    return false
  }
  // 测试替身或非真实窗口没有原生句柄方法，直接跳过（不打印噪音日志）。
  if (typeof win.getNativeWindowHandle !== 'function') {
    return false
  }

  let hwnd = null
  try {
    hwnd = readHwnd(win.getNativeWindowHandle())
  } catch (error) {
    console.warn('[windowStyle] 设置原生外框时读取 HWND 失败:', error?.message)
    return false
  }
  if (hwnd === null) {
    return false
  }

  let ok = true
  try {
    const preferenceBuffer = createInt32AttributeBuffer(rounded ? DWMWCP_ROUND : DWMWCP_DONOTROUND)
    const cornerResult = dwmFns.DwmSetWindowAttribute(
      hwnd,
      DWMWA_WINDOW_CORNER_PREFERENCE,
      preferenceBuffer,
      4,
    )
    if (cornerResult !== 0) {
      console.warn('[windowStyle] DwmSetWindowAttribute(圆角偏好) 返回非 0:', cornerResult)
      ok = false
    }

    if (hideSystemBorder) {
      const borderBuffer = createUint32AttributeBuffer(DWMWA_COLOR_NONE)
      const borderResult = dwmFns.DwmSetWindowAttribute(
        hwnd,
        DWMWA_BORDER_COLOR,
        borderBuffer,
        4,
      )
      if (borderResult !== 0) {
        console.warn('[windowStyle] DwmSetWindowAttribute(隐藏系统边框) 返回非 0:', borderResult)
        ok = false
      }
    }
    return ok
  } catch (error) {
    console.warn('[windowStyle] 设置原生外框失败:', error?.message)
    return false
  }
}

/**
 * 设置窗口的原生边框颜色（Windows 11 DWM）。
 *
 * `colorRef` 用 COLORREF（0x00BBGGRR，注意是 BGR 顺序）；传 null 恢复系统默认。
 * 目前仅作为可选能力保留：它给的是系统绘制的 1px 边线，
 * 与渲染层那圈 8px 圆角边框重叠时会变成双线，故默认不调用。
 *
 * @param {import('electron').BrowserWindow} win 目标窗口
 * @param {number | null} colorRef COLORREF 值
 * @returns {boolean} 是否设置成功
 */
export function applyNativeWindowBorderColor(win, colorRef) {
  if (!win || win.isDestroyed?.() === true || !ensureDwmApi()) {
    return false
  }

  let hwnd = null
  try {
    hwnd = readHwnd(win.getNativeWindowHandle())
  } catch {
    return false
  }
  if (hwnd === null) {
    return false
  }

  try {
    // DWMWA_COLOR_DEFAULT = 0xFFFFFFFF 表示恢复默认
    const value = colorRef === null || colorRef === undefined ? -1 : Number(colorRef)
    const colorBuffer = createInt32AttributeBuffer(value)
    const hresult = dwmFns.DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, colorBuffer, 4)
    return hresult === 0
  } catch {
    return false
  }
}

export default {
  ensureWindowCaptionStyle,
  isNativeWindowZoomed,
  applyNativeRoundedCorners,
  applyNativeFrameAppearance,
  applyNativeWindowBorderColor,
}
