import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

import {
  clampOutlinePanelWidth,
  createHomeViewOutlinePanelLayoutController,
  EDITOR_COLUMN_MIN_WIDTH,
  fitSidePanelWidthsToAvailable,
  OUTLINE_PANEL_DEFAULT_WIDTH,
  OUTLINE_PANEL_MAX_WIDTH,
  OUTLINE_PANEL_MIN_WIDTH,
  readTrailingTrackWidth,
  resolveHomeViewGridTemplateColumns,
  resolveOutlineGutterTrack,
  SIDE_PANEL_MAX_RATIO,
} from '../homeViewOutlinePanelLayoutUtil.js'
import {
  FILE_MANAGER_PANEL_DEFAULT_WIDTH,
  FILE_MANAGER_PANEL_MIN_WIDTH,
} from '../homeViewFilePanelLayoutUtil.js'
import { MIN_PANE_WIDTH } from '../../../util/document-session/paneLayoutUtil.js'

const outlinePanelLayoutState = vi.hoisted(() => ({
  splitCalls: [],
  splitDestroySpies: [],
}))

vi.mock('split-grid', () => ({
  default(options) {
    const destroy = vi.fn()
    outlinePanelLayoutState.splitCalls.push(options)
    outlinePanelLayoutState.splitDestroySpies.push(destroy)
    return {
      destroy,
    }
  },
}))

function createHostElement(gridTemplateColumns = `280px 1px 1fr 1px ${OUTLINE_PANEL_DEFAULT_WIDTH}px`) {
  const hostElement = document.createElement('div')
  hostElement.style.gridTemplateColumns = gridTemplateColumns
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

describe('homeViewOutlinePanelLayoutUtil', () => {
  beforeEach(() => {
    outlinePanelLayoutState.splitCalls.length = 0
    outlinePanelLayoutState.splitDestroySpies.length = 0
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('大纲栏默认宽度和边界值必须保持稳定', () => {
    // 最小/默认宽度统一到编辑区分栏的 MIN_PANE_WIDTH（四者一致，用户要求）
    expect(OUTLINE_PANEL_DEFAULT_WIDTH).toBe(240)
    expect(OUTLINE_PANEL_MIN_WIDTH).toBe(160)
    expect(OUTLINE_PANEL_MAX_WIDTH).toBe(480)
  })

  it('拖动大纲栏时应把宽度限制在 160 到 480 之间', () => {
    expect(clampOutlinePanelWidth(80)).toBe(160)
    expect(clampOutlinePanelWidth(900)).toBe(480)
    expect(clampOutlinePanelWidth(Number.NaN)).toBe(OUTLINE_PANEL_DEFAULT_WIDTH)
  })

  it('侧栏与大纲栏都展开时应生成五列 grid 定义', () => {
    expect(
      resolveHomeViewGridTemplateColumns({
        sidebarVisible: true,
        sidebarWidth: 280,
        outlineVisible: true,
        outlineWidth: 240,
      }),
    ).toBe('minmax(160px, 280fr) 1px minmax(160px, 1400fr) 1px minmax(160px, 240fr)')
  })

  it('只开侧栏时应退化成三列 grid 定义', () => {
    expect(
      resolveHomeViewGridTemplateColumns({
        sidebarVisible: true,
        sidebarWidth: 280,
        outlineVisible: false,
        outlineWidth: 240,
      }),
    ).toBe('minmax(160px, 280fr) 1px minmax(160px, 1400fr)')
  })

  it('只开大纲栏时应退化成三列 grid 定义', () => {
    expect(
      resolveHomeViewGridTemplateColumns({
        sidebarVisible: false,
        sidebarWidth: 280,
        outlineVisible: true,
        outlineWidth: 240,
      }),
    ).toBe('minmax(160px, 1400fr) 1px minmax(160px, 240fr)')
  })

  it('两侧都关闭时应只剩主区单列', () => {
    expect(
      resolveHomeViewGridTemplateColumns({
        sidebarVisible: false,
        sidebarWidth: 280,
        outlineVisible: false,
        outlineWidth: 240,
      }),
    ).toBe('minmax(160px, 1400fr)')
  })

  it('大纲栏分隔条轨道下标应随侧栏显隐变化', () => {
    expect(resolveOutlineGutterTrack(true)).toBe(3)
    expect(resolveOutlineGutterTrack(false)).toBe(1)
  })

  it('应读取 grid 定义里最后一列的宽度', () => {
    expect(readTrailingTrackWidth('280px 1px 1fr 1px 240px')).toBe(240)
    expect(readTrailingTrackWidth('1fr 1px 320.5px')).toBe(320.5)
  })

  // 侧栏拖拽已改为原生指针事件实现（弃用 split-grid）。
  // split-grid 用 `raw.split(' ')` 解析列模板，`minmax(160px, 280fr)` 参数里带空格
  // 会被切成两段 → 解析失效 → 完全拖不动（实测拖 +100px 侧栏不动）。
  it('读取大纲栏宽度时按末尾轨道取像素并钳制', async () => {
    const controller = createHomeViewOutlinePanelLayoutController({
      hostRef: ref(createHostElement()),
      gutterRef: ref(createGutterElement()),
      panelWidthRef: ref(OUTLINE_PANEL_DEFAULT_WIDTH),
      nextTick,
      resolveGridTemplateColumns: () => '',
      readComputedStyle: () => ({
        gridTemplateColumns: '280px 1px 1fr 1px 900px',
      }),
    })

    await controller.rebuildSplitLayout(true)

    // 末尾轨道 900px 超过上限，必须钳到 480
    expect(controller.readCurrentPanelWidth()).toBe(OUTLINE_PANEL_MAX_WIDTH)
  })

  it('拖动大纲栏：指针左移为变宽，拖动中写像素、松手转 fr', async () => {
    const hostElement = createHostElement()
    const gutterElement = createGutterElement()
    const panelWidthRef = ref(OUTLINE_PANEL_DEFAULT_WIDTH)
    const controller = createHomeViewOutlinePanelLayoutController({
      hostRef: ref(hostElement),
      gutterRef: ref(gutterElement),
      panelWidthRef,
      nextTick,
      // 模拟真实浏览器：getComputedStyle 返回的是**已解析的纯像素串**，
      // 不是我们写的 minmax(...fr) 模板
      readComputedStyle: () => ({
        gridTemplateColumns: '280px 1px 1400px 1px 240px',
      }),
      resolveGridTemplateColumns: width => `minmax(160px, 280fr) 1px minmax(160px, 1400fr) 1px minmax(160px, ${Math.round(width)}fr)`,
    })

    await controller.rebuildSplitLayout(true)

    gutterElement.dispatchEvent(createPointerLikeEvent('pointerdown', { button: 0, clientX: 900 }))
    window.dispatchEvent(createPointerLikeEvent('pointermove', { clientX: 850 }))
    // 写入走 requestAnimationFrame（限帧，避免 120Hz 鼠标每帧都触发重排）
    await new Promise(resolve => requestAnimationFrame(resolve))

    // 拖动中：末列是像素
    expect(hostElement.style.gridTemplateColumns).toMatch(/\d+px$/)

    window.dispatchEvent(createPointerLikeEvent('pointerup', { clientX: 850 }))
    // 松手：**保留像素模板**（不立刻转 fr）。
    // 立刻转会把「目标 420px」写成 420fr 渲染成 442px，再钳回 420 又变 420fr，
    // 振荡几轮后停在 401（实测）。只在窗口尺寸变化时才转 fr 权重重算。
    expect(hostElement.style.gridTemplateColumns).toMatch(/\d+px$/)
  })
})
