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

let user32 = null
let fns = null

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

export default {
  ensureWindowCaptionStyle,
  isNativeWindowZoomed,
}
