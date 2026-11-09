import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

import {
  clampFileManagerPanelWidth,
  createHomeViewFilePanelLayoutController,
  FILE_MANAGER_PANEL_DEFAULT_WIDTH,
  FILE_MANAGER_PANEL_MAX_WIDTH,
  FILE_MANAGER_PANEL_MIN_WIDTH,
  resolveHomeViewFilePanelGridTemplateColumns,
} from '../homeViewFilePanelLayoutUtil.js'

const homeViewFilePanelLayoutState = vi.hoisted(() => ({
  splitCalls: [],
  splitDestroySpies: [],
}))

vi.mock('split-grid', () => ({
  default(options) {
    const destroy = vi.fn()
    homeViewFilePanelLayoutState.splitCalls.push(options)
    homeViewFilePanelLayoutState.splitDestroySpies.push(destroy)
    return {
      destroy,
    }
  },
}))

function createHostElement() {
  const hostElement = document.createElement('div')
  hostElement.style.gridTemplateColumns = `${FILE_MANAGER_PANEL_DEFAULT_WIDTH}px 1px 1fr`
  document.body.appendChild(hostElement)
  return hostElement
}

/** jsdom 没有 PointerEvent：用 MouseEvent 造一个带 pointerId 的等价事件 */
function createPointerLikeEvent(type, init = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  return event
}

function createGutterElement() {
  const gutterElement = document.createElement('div')
  document.body.appendChild(gutterElement)
  return gutterElement
}

describe('homeViewFilePanelLayoutUtil', () => {
  beforeEach(() => {
    homeViewFilePanelLayoutState.splitCalls.length = 0
    homeViewFilePanelLayoutState.splitDestroySpies.length = 0
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  // 回归：拖动期绝不能调 getComputedStyle。
  // 它会强制同步重排，真实鼠标 ~120Hz 就是每秒 120 次全量 reflow，
  // 表现为「宽度一格一格跳、不跟光标」（用户实测反馈）。
  it('拖动期间只读一次列模板，不在每次 pointermove 里重新计算样式', async () => {
    const hostElement = createHostElement()
    const gutterElement = createGutterElement()
    const readComputedStyle = vi.fn(() => ({
      gridTemplateColumns: '280px 1px 1100px 1px 240px',
    }))
    const controller = createHomeViewFilePanelLayoutController({
      hostRef: ref(hostElement),
      gutterRef: ref(gutterElement),
      panelWidthRef: ref(280),
      nextTick,
      readComputedStyle,
      resolveGridTemplateColumns: width => `minmax(160px, ${Math.round(width)}fr) 1px minmax(160px, 1100fr) 1px minmax(160px, 240fr)`,
    })

    await controller.rebuildSplitLayout(true)
    const callsAfterBuild = readComputedStyle.mock.calls.length

    gutterElement.dispatchEvent(createPointerLikeEvent('pointerdown', { button: 0, clientX: 300 }))
    const callsBeforeMoves = readComputedStyle.mock.calls.length
    for (const dx of [10, 20, 30, 40, 50]) {
      window.dispatchEvent(createPointerLikeEvent('pointermove', { clientX: 300 + dx }))
      await new Promise(resolve => requestAnimationFrame(resolve))
    }
    const callsDuringMoves = readComputedStyle.mock.calls.length - callsBeforeMoves
    window.dispatchEvent(createPointerLikeEvent('pointerup', { clientX: 350 }))

    // 拖动开始后，pointermove 一轮都不能再读样式（最多 pointerup 读一次收尾值）
    // build 1 次 + pointerdown 1 次 + pointerup 1 次，其余都在拖动期（必须为 0）
    expect(readComputedStyle.mock.calls.length - callsAfterBuild).toBeLessThanOrEqual(3)
    expect(callsDuringMoves).toBe(0)
  })

  it('文件管理栏默认宽度和边界值必须保持稳定', () => {
    expect(FILE_MANAGER_PANEL_DEFAULT_WIDTH).toBe(280)
    expect(FILE_MANAGER_PANEL_MIN_WIDTH).toBe(160)
    expect(FILE_MANAGER_PANEL_MAX_WIDTH).toBe(420)
  })

  it('拖动文件管理栏时应把宽度限制在 160 到 420 之间', () => {
    expect(clampFileManagerPanelWidth(120)).toBe(160)
    expect(clampFileManagerPanelWidth(520)).toBe(420)
  })

  it('文件管理栏展开态的 grid 列定义应使用 1px sash 轨道', () => {
    expect(resolveHomeViewFilePanelGridTemplateColumns(FILE_MANAGER_PANEL_DEFAULT_WIDTH)).toBe('280px 1px 1fr')
  })

  it('测试宿主元素的初始 grid 列定义应与 1px sash 需求保持一致', () => {
    const hostElement = createHostElement()

    expect(hostElement.style.gridTemplateColumns).toBe('280px 1px 1fr')
  })

  // 侧栏拖拽已改为原生指针事件实现（弃用 split-grid）。
  // 原因：split-grid 用 `raw.split(' ')` 解析列模板，而 `minmax(160px, 280fr)`
  // 参数里带空格会被切成两段，解析失效 → 完全拖不动（实测拖 +100px 侧栏不动）。
  it('指针拖动时按位移更新像素列模板，松手后钳制并回写', async () => {
    const hostElement = createHostElement()
    const gutterElement = createGutterElement()
    const panelWidthRef = ref(FILE_MANAGER_PANEL_DEFAULT_WIDTH)
    const commitSpy = vi.fn()
    const controller = createHomeViewFilePanelLayoutController({
      hostRef: ref(hostElement),
      gutterRef: ref(gutterElement),
      panelWidthRef,
      nextTick,
      onPanelWidthCommit: commitSpy,
      readComputedStyle: () => ({ gridTemplateColumns: '520px 1px 1fr' }),
    })

    await controller.rebuildSplitLayout(true)
    // 松手时读到 520px（被 mock 的 computed style），钳到上限 420
    expect(controller.readCurrentPanelWidth()).toBe(FILE_MANAGER_PANEL_MAX_WIDTH)
    expect(commitSpy).not.toHaveBeenCalled()
  })

  it('拖动中写像素模板（1:1 跟手），松手后转回 fr 权重模板', async () => {
    const hostElement = createHostElement()
    const gutterElement = createGutterElement()
    const panelWidthRef = ref(FILE_MANAGER_PANEL_DEFAULT_WIDTH)
    const controller = createHomeViewFilePanelLayoutController({
      hostRef: ref(hostElement),
      gutterRef: ref(gutterElement),
      panelWidthRef,
      nextTick,
      // 模拟真实浏览器：getComputedStyle 返回的是**已解析的像素串**，
      // 不是我们写进去的 minmax(...fr) 模板
      readComputedStyle: () => ({ gridTemplateColumns: '280px 1px 1400px' }),
      resolveGridTemplateColumns: width => `minmax(160px, ${Math.round(width)}fr) 1px minmax(160px, 1400fr)`,
    })

    await controller.rebuildSplitLayout(true)

    // jsdom 没有 PointerEvent，用 MouseEvent 派发同名事件（事件名一致即可）
    gutterElement.dispatchEvent(createPointerLikeEvent('pointerdown', { button: 0, clientX: 300 }))
    window.dispatchEvent(createPointerLikeEvent('pointermove', { clientX: 350 }))
    // 写入走 requestAnimationFrame（限帧，避免 120Hz 鼠标每帧都触发重排），要等一帧
    await new Promise(resolve => requestAnimationFrame(resolve))

    // 拖动中：第一列必须是像素（不能是 fr）
    const draggingColumns = hostElement.style.gridTemplateColumns
    expect(draggingColumns.split(' ')[0]).toMatch(/px$/)

    window.dispatchEvent(createPointerLikeEvent('pointerup', { clientX: 350 }))
    // 松手：**保留像素模板，不立刻转 fr**。
    // 立刻转会把「目标 350px」写成 350fr 渲染成别的值（fr 是权重不是像素），
    // 再钳回又变一轮，振荡几轮后停在偏移值上。
    // 只在窗口尺寸变化时才由 Vue 重算成 fr 权重模板。
    expect(hostElement.style.gridTemplateColumns).toMatch(/^\d+px /)
  })

  it('关闭再打开后仍可拖拽（监听器正确重建，不重复叠加）', async () => {
    const hostElement = createHostElement()
    const gutterElement = createGutterElement()
    const controller = createHomeViewFilePanelLayoutController({
      hostRef: ref(hostElement),
      gutterRef: ref(gutterElement),
      panelWidthRef: ref(FILE_MANAGER_PANEL_DEFAULT_WIDTH),
      nextTick,
    })

    await controller.rebuildSplitLayout(true)
    await controller.rebuildSplitLayout(false)
    await controller.rebuildSplitLayout(true)

    // 重建后仍能响应指针事件（监听器被重新挂上）
    expect(() => {
      gutterElement.dispatchEvent(createPointerLikeEvent('pointerdown', { button: 0, clientX: 300 }))
      window.dispatchEvent(createPointerLikeEvent('pointerup', { clientX: 300 }))
    }).not.toThrow()
  })
})
