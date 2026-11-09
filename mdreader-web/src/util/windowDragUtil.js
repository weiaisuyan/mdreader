import channelUtil from '@/util/channel/channelUtil.js'

/**
 * 窗口拖动 + 双击最大化（渲染层驱动）。
 *
 * 为什么不用 `-webkit-app-region: drag`：
 * 圆角窗口必须 `transparent: true`，而 Windows 的透明窗口会丢掉系统自带的标题栏拖动
 * **和双击最大化**；更麻烦的是 drag 区域会吞掉所有鼠标事件，网页根本收不到 doubleclick，
 * 想自己补双击都补不了。所以这里改成纯 JS 拖动：
 * 指针按下 → 逐帧发 `move-window`，主进程 setPosition。
 *
 * 代价是拖动不如原生顺滑（每帧一次 IPC），换来的是双击最大化、拖动窗口、拖放文件
 * 三种交互能在同一块区域共存。
 */

/** 判定为「原地双击」的时间窗（ms） */
const DOUBLE_CLICK_INTERVAL_MS = 350
/** 判定为「原地双击」的位移上限（px）：手抖几像素仍算同一位置 */
const DOUBLE_CLICK_SLOP_PX = 6

let lastPointerDownAt = 0
let lastPointerDownX = 0
let lastPointerDownY = 0

/**
 * 这个事件是否发生在「可拖动窗口」的区域上。
 *
 * 规则：命中最近的可拖标记元素，且沿途没有 no-drag 标记。
 * 这样按钮、标签、输入框这些交互元素天然不会触发拖窗口。
 *
 * @param {Element | null} target 事件目标
 * @returns {boolean} 是否属于窗口拖动区
 */
export function isWindowDragArea(target) {
  if (!target || typeof target.closest !== 'function') {
    return false
  }
  const dragElement = target.closest('.electron-drag')
  if (!dragElement) {
    return false
  }
  // 交互元素（按钮/标签/输入）自己会标 no-drag，它们内部不算拖动区
  const noDragElement = target.closest('.electron-no-drag')
  return !noDragElement || !dragElement.contains(noDragElement)
}

/**
 * 安装窗口拖动与双击最大化。
 *
 * 只装一次；返回卸载函数便于单测与热更新。
 *
 * @param {{ isMaximized?: () => boolean }} [options] 读取当前是否最大化的回调
 * @returns {() => void} 卸载函数
 */
export function installWindowDragHandler(options = {}) {
  if (typeof window === 'undefined') {
    return () => {}
  }

  const isMaximized = typeof options.isMaximized === 'function'
    ? options.isMaximized
    : () => false

  let dragPointerId = null
  let startPointerScreenX = 0
  let startPointerScreenY = 0
  let movedDistance = 0

  function handlePointerMove(moveEvent) {
    if (dragPointerId === null || moveEvent.pointerId !== dragPointerId) {
      return
    }
    // ⚠️ **一个坐标都不传**。
    //
    // 历史：这个函数曾经发绝对坐标 `{x, y}`，也发过相对位移 `{dx, dy}`，
    // 还在主进程按 scaleFactor 换算、攒亚像素余量、事后 setSize 纠回 —— 全部失败。
    // 根因是两套坐标系不同源：渲染层的 screenX 是 CSS 像素，主进程 setBounds 收 DIP，
    // 透明圆角窗口还有边框偏移，150% DPI 下怎么换算都会让窗口宽度跟着 +dx
    // （实测 dx=1 连发，x +1 的同时宽也 +1，右边缘钉死、左边缘外扩）。
    //
    // 现在只发「动了一下」这个信号，位置由主进程用 screen.getCursorScreenPoint()
    // 自己读（与 setBounds 同一坐标系），尺寸用按下时的快照锁死。
    movedDistance = Math.max(
      movedDistance,
      Math.abs(moveEvent.screenX - startPointerScreenX) + Math.abs(moveEvent.screenY - startPointerScreenY),
    )

    channelUtil.send({ event: 'move-window', data: { phase: 'move' } }).catch(() => {})
  }

  function cleanupDrag() {
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', cleanupDrag)
    window.removeEventListener('pointercancel', cleanupDrag)
    window.removeEventListener('blur', cleanupDrag)
    // 通知主进程「拖动结束」，清掉尺寸快照
    if (dragPointerId !== null) {
      channelUtil.send({ event: 'move-window', data: { phase: 'end' } }).catch(() => {})
    }
    dragPointerId = null
  }

  function handlePointerDown(event) {
    if (event.button !== 0 || !isWindowDragArea(event.target)) {
      return
    }

    const now = Date.now()
    const isSameSpot = Math.abs(event.screenX - lastPointerDownX) <= DOUBLE_CLICK_SLOP_PX
      && Math.abs(event.screenY - lastPointerDownY) <= DOUBLE_CLICK_SLOP_PX
    const isDoubleClick = now - lastPointerDownAt <= DOUBLE_CLICK_INTERVAL_MS && isSameSpot

    lastPointerDownAt = now
    lastPointerDownX = event.screenX
    lastPointerDownY = event.screenY

    if (isDoubleClick) {
      // 双击标题栏 = 最大化/还原，是 Windows 的既定习惯。
      // 用现有的 maximize / restore 命令，不新造协议。
      lastPointerDownAt = 0
      channelUtil.send({ event: isMaximized() ? 'restore' : 'maximize' }).catch(() => {})
      return
    }

    dragPointerId = event.pointerId
    startPointerScreenX = event.screenX
    startPointerScreenY = event.screenY
    movedDistance = 0

    // 通知主进程「开始拖动」：它会记下鼠标相对窗口的偏移 + 尺寸快照。
    // 之后每帧由主进程自己读鼠标位置，渲染层不再传任何坐标。
    channelUtil.send({ event: 'move-window', data: { phase: 'start' } }).catch(() => {})

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', cleanupDrag)
    window.addEventListener('pointercancel', cleanupDrag)
    window.addEventListener('blur', cleanupDrag)
  }

  // 捕获阶段：比业务组件的 pointerdown 更早拿到，但不动 event，不干扰它们
  document.addEventListener('pointerdown', handlePointerDown, true)

  return () => {
    document.removeEventListener('pointerdown', handlePointerDown, true)
    cleanupDrag()
  }
}
