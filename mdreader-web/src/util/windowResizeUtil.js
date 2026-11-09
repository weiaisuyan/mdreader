import channelUtil from '@/util/channel/channelUtil.js'

/**
 * 窗口边缘缩放。
 *
 * 圆角窗口要求主进程用 `transparent: true`，而 Windows 上的透明窗口会**丢掉系统自带的
 * 边缘拖拽缩放**（鼠标移到边缘没有缩放光标、拖不动）。所以边缘热区和缩放换算都由渲染层
 * 自己实现，拖动时把期望的屏幕矩形交给主进程 `setBounds` 落地。
 *
 * 只用 `screenX/screenY/outerWidth/outerHeight` 这套标准 API：
 * 它在透明窗口下同样可用，也不需要额外的主进程查询通道。
 */

/** 边缘热区厚度（px）：太薄不好点，太厚会挡住内容里的滚动条拖动 */
export const RESIZE_EDGE_SIZE = 5

/** 可缩放方向：n/s/e/w 四条边 + 四个角 */
export const RESIZE_DIRECTIONS = Object.freeze([
  'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw',
])

const CURSOR_BY_DIRECTION = Object.freeze({
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
})

/**
 * 某个方向对应的鼠标样式。
 *
 * @param {string} direction 缩放方向
 * @returns {string} CSS cursor 值
 */
export function resolveResizeCursor(direction) {
  return CURSOR_BY_DIRECTION[direction] || 'default'
}

/**
 * 某个方向的边缘热区定位样式。
 *
 * @param {string} direction 缩放方向
 * @param {number} [size] 热区厚度
 * @returns {object} 绝对定位样式
 */
export function resolveResizeZoneStyle(direction, size = RESIZE_EDGE_SIZE) {
  const style = { position: 'absolute', zIndex: 40 }
  if (direction.includes('n')) {
    Object.assign(style, { top: 0, left: 0, right: 0, height: `${size}px` })
  }
  if (direction.includes('s')) {
    Object.assign(style, { bottom: 0, left: 0, right: 0, height: `${size}px` })
  }
  if (direction.includes('w')) {
    Object.assign(style, { left: 0, top: 0, bottom: 0, width: `${size}px` })
  }
  if (direction.includes('e')) {
    Object.assign(style, { right: 0, top: 0, bottom: 0, width: `${size}px` })
  }
  // 四个角要压过四条边，否则角落只能单向缩放
  if (direction.length === 2) {
    style.zIndex = 41
    style.width = `${size * 2}px`
    style.height = `${size * 2}px`
    style.top = direction.includes('n') ? 0 : 'auto'
    style.bottom = direction.includes('s') ? 0 : 'auto'
    style.left = direction.includes('w') ? 0 : 'auto'
    style.right = direction.includes('e') ? 0 : 'auto'
  }
  return style
}

/**
 * 按拖动位移算出新的窗口矩形。
 *
 * 抽成纯函数便于单测：给定起始矩形、方向、位移，返回目标矩形（宽高不会变成负数）。
 *
 * @param {{ x: number, y: number, width: number, height: number }} start 起始矩形
 * @param {string} direction 缩放方向
 * @param {number} deltaX 水平位移
 * @param {number} deltaY 垂直位移
 * @returns {{ x: number, y: number, width: number, height: number }} 目标矩形
 */
export function resolveResizedBounds(start, direction, deltaX, deltaY) {
  let { x, y, width, height } = start

  if (direction.includes('e')) {
    width = start.width + deltaX
  }
  if (direction.includes('s')) {
    height = start.height + deltaY
  }
  if (direction.includes('w')) {
    width = start.width - deltaX
    x = start.x + deltaX
  }
  if (direction.includes('n')) {
    height = start.height - deltaY
    y = start.y + deltaY
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  }
}

/**
 * 当前这次缩放的收尾函数。
 *
 * 与分隔条拖拽同一个坑：`pointermove` 监听挂在 window 上，若某次拖拽没收到
 * `pointerup`（在窗口外松手、事件被吞、脚本合成事件 pointerId 相同），
 * 监听器会永久残留；下次拖拽时**多个旧处理器同时发 resize 请求**，
 * 窗口就会一次跳几百像素——用户看到的「不是按比例缩放」。
 * 所以每次开始前先把上一轮清干净。
 */
let activeResizeCleanup = null

/**
 * 开始一次边缘缩放。
 *
 * 拖动期间逐帧把目标矩形发给主进程；主进程自己会守住最小宽高，
 * 这里不重复实现同一套下限，避免两处规则漂移。
 *
 * @param {string} direction 缩放方向
 * @param {PointerEvent} event pointerdown 事件
 * @returns {void}
 */
export function startWindowResize(direction, event) {
  if (event?.button !== 0) {
    return
  }
  event.preventDefault?.()

  if (typeof activeResizeCleanup === 'function') {
    activeResizeCleanup()
  }

  const start = {
    x: Math.round(window.screenX),
    y: Math.round(window.screenY),
    width: Math.round(window.outerWidth),
    height: Math.round(window.outerHeight),
  }
  // 位移以「指针自己的屏幕坐标」为准（screenX = 窗口 screenX + clientX，
  // 窗口移动时两者互相抵消，得到的是指针真实的屏幕位置，不会被窗口位移污染）。
  const startPointerScreenX = event.screenX
  const startPointerScreenY = event.screenY
  const pointerId = event.pointerId

  function handlePointerMove(moveEvent) {
    if (moveEvent.pointerId !== pointerId) {
      return
    }
    const bounds = resolveResizedBounds(
      start,
      direction,
      moveEvent.screenX - startPointerScreenX,
      moveEvent.screenY - startPointerScreenY,
    )
    channelUtil.send({ event: 'resize-window', data: bounds }).catch(() => {})
  }

  function cleanup() {
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', cleanup)
    window.removeEventListener('pointercancel', cleanup)
    window.removeEventListener('blur', cleanup)
    if (activeResizeCleanup === cleanup) {
      activeResizeCleanup = null
    }
  }

  activeResizeCleanup = cleanup
  window.addEventListener('pointermove', handlePointerMove)
  window.addEventListener('pointerup', cleanup)
  window.addEventListener('pointercancel', cleanup)
  window.addEventListener('blur', cleanup)
}
