import { MIN_PANE_WIDTH } from '../../util/document-session/paneLayoutUtil.js'

import {
  clampFileManagerPanelWidth,
  createHomeViewFilePanelLayoutController,
} from './homeViewFilePanelLayoutUtil.js'

// 默认宽度（首次打开时的宽度）。必须 > 最小宽度，否则没有可压缩区间。
export const OUTLINE_PANEL_DEFAULT_WIDTH = 240
// 最小宽度统一取编辑区分栏的 MIN_PANE_WIDTH（用户要求四者一致）。
export const OUTLINE_PANEL_MIN_WIDTH = MIN_PANE_WIDTH
export const OUTLINE_PANEL_MAX_WIDTH = 480

/**
 * 主编辑区（中间那列）的最小宽度。
 *
 * 用户要求「文件栏、大纲栏和显示栏的最小宽度都设置成一样，统一一下」，
 * 所以这里也取 MIN_PANE_WIDTH，不再单独用 360。
 *
 * 之前设 360 的副作用：窗口从 1920 缩到 900 的过程中，两侧栏几乎不动
 * （预算被编辑区下限吃光），只有编辑区在缩 —— 正是用户抱怨的交互。
 */
export const EDITOR_COLUMN_MIN_WIDTH = MIN_PANE_WIDTH

/**
 * 编辑区在列模板里的 fr 权重基准。
 *
 * 三栏都用 fr 权重才能「一起缩」，但编辑区没有存档像素宽度，
 * 需要一个能代表它常见宽度的基准值。取 1400（1920 窗口下编辑区的典型宽度），
 * 这样 280 + 1400 + 240 的比例与默认布局一致，窗口缩放时三栏按同一比例变化。
 *
 * 它只影响相对比例，不影响正确性：窗口变窄时三栏一起缩，各自触底 160px 后钉住。
 */
export const EDITOR_WEIGHT_REFERENCE = 1400

/**
 * 两侧栏合计占可用宽度的上限比例。
 *
 * 窗口变宽时两侧栏最多占 30%，剩下的都给编辑区 —— 这样窗口一缩，
 * 两侧栏会按比例跟着变窄，而不是死守像素值把编辑区挤扁。
 *
 * 取值依据（实测离线验算，`fitSidePanelWidthsToAvailable` 打表）：
 * - 40% 时 1600/1300 两档两侧栏一直是 517 不动，用户感受仍是「只有编辑区在缩」；
 * - 30% 时从 1600 往下每一档两侧栏都在变小，才符合「跟着一起缩放」。
 */
export const SIDE_PANEL_MAX_RATIO = 0.3

/**
 * 窗口变窄时收窄三栏（文件栏 / 编辑区 / 大纲栏）。
 *
 * 语义（用户口述，逐字）：
 * 「缩放的时候，在没有到达它们最小宽度之前，它们应该整体一起同比例缩放。
 *   某一个栏到达最小宽度后，再缩放时，这个最小宽度不动，但其他没到最小宽度的栏应该动。」
 *
 * 实现**交给 CSS**：`resolveHomeViewGridTemplateColumns` 生成
 * `minmax(160px, Nfr)`，浏览器原生就实现这条规则 ——
 * 空间不足时各栏按 fr 比例一起缩，缩到 160px 钉住，剩余空间给其余栏。
 *
 * 之前用 JS 每帧算像素写死进 grid-template-columns，取整抖动、基准塌陷，
 * 改了三版都不对。交给 CSS 后与窗口缩放同一条渲染管线，平滑无跳变。
 *
 * 只影响**渲染**，不改 `sidebarWidth` / `outlineWidth` 这两个持久化值：
 * 否则用户把窗口拖窄一次，config 里记着的宽度就被改掉了，窗口放大回来也回不到原样。
 *
 * @param {{
 *   sidebarVisible: boolean,
 *   sidebarWidth: number,
 *   outlineVisible: boolean,
 *   outlineWidth: number,
 * }} options
 * @returns {{ sidebarWidth: number, outlineWidth: number }} 用于渲染的宽度（不再按可用宽度收窄）
 */
export function fitSidePanelWidthsToAvailable({
  sidebarVisible,
  sidebarWidth,
  outlineVisible,
  outlineWidth,
}) {
  return {
    sidebarWidth: clampFileManagerPanelWidth(sidebarWidth),
    outlineWidth: clampOutlinePanelWidth(outlineWidth),
  }
}

/**
 * 将大纲栏宽度限制在允许范围内，避免拖拽结果超出壳层设计边界。
 *
 * @param {number} width
 * @returns {number} 返回经过最小值和最大值钳制后的宽度。
 */
export function clampOutlinePanelWidth(width) {
  const normalizedWidth = Number(width)
  const nextWidth = Number.isFinite(normalizedWidth) ? normalizedWidth : OUTLINE_PANEL_DEFAULT_WIDTH

  return Math.min(OUTLINE_PANEL_MAX_WIDTH, Math.max(OUTLINE_PANEL_MIN_WIDTH, nextWidth))
}

/**
 * 生成 HomeView 壳层的完整列定义。
 * 侧栏在左、大纲栏在右，中间主区始终占 1fr；
 * 关闭一侧时对应列与其 1px 分隔列一起消失，避免留下空白列。
 *
 * @param {{
 *   sidebarVisible: boolean,
 *   sidebarWidth: number,
 *   outlineVisible: boolean,
 *   outlineWidth: number,
 * }} options
 * @returns {string} 返回可直接写入 grid-template-columns 的列定义。
 */
export function resolveHomeViewGridTemplateColumns({
  sidebarVisible,
  sidebarWidth,
  outlineVisible,
  outlineWidth,
  editorWidth = null,
  containerWidth = null,
}) {
  const columnList = []

  // 三栏全部用 fr 权重，窗口变窄时一起同比例缩、触底 160px 后各自钉住。
  //
  // ⚠️ 关键：**fr 是权重不是像素**。要让某一栏渲染成 W 像素，权重不能直接写 W ——
  // 实际宽度 = 容器可用宽 × w / (w + 其余权重之和)。
  // 例如容器 1919、权重 [420, 1400] 时，420fr 那一栏渲染出来是 442.8px，比目标多 22.8。
  //
  // 所以这里把「目标像素」反算成权重：
  //   w = W × 其余权重之和 / (容器可用宽 − W)
  // 这样渲染结果正好等于目标像素，拖动侧栏不会被比例放大。
  //
  // 编辑区权重 = 它当前的实际像素。
  //
  // 必须用实测值，不能用固定参考值：三栏 fr 权重是按比例分配的，
  // 若编辑区写死 1400 而容器实际是 1919，那么 280:(1400):240 的比例
  // 会让侧栏渲染成 443px（比配置的 280 大 58%）。
  // 用实测像素后，三栏权重之和 ≈ 容器宽度，各栏渲染结果 ≈ 各自目标像素。
  const clampedSidebar = clampFileManagerPanelWidth(sidebarWidth)
  const clampedOutline = clampOutlinePanelWidth(outlineWidth)

  // 三栏都用 fr 权重 → 窗口缩放时按同一比例一起缩、触底 160px 后各自钉住。
  //
  // ⚠️ fr 是**权重**不是像素：容器 1919、权重 [280,1400,240] 时，
  // 侧栏实际渲染 = 1918 × 280/1920 = 279.7px —— 正好等于目标 280。
  // 也就是说「权重之和 ≈ 容器宽度」时，权重数值就等于像素，不需要反算。
  //
  // 所以编辑区权重取「容器宽 − 两侧栏」，保证三栏权重之和 = 容器宽度：
  //   280 + (1919-280-240-2) + 240 + 2(分隔条) = 1919 ✓
  //
  // 不能取「当前实测的编辑区宽度」：那是被上一帧比例算出来的结果，
  // 会自我强化、越缩越小（实测配置 280 渲染成 242）。
  const gutterTotal = (sidebarVisible ? 1 : 0) + (outlineVisible ? 1 : 0)
  const sideTotal = (sidebarVisible ? clampedSidebar : 0) + (outlineVisible ? clampedOutline : 0)
  const derivedEditorWidth = Number.isFinite(containerWidth) && containerWidth > 0
    ? Math.max(MIN_PANE_WIDTH, containerWidth - sideTotal - gutterTotal)
    : null

  const editorWeight = Number.isFinite(derivedEditorWidth)
    ? Math.round(derivedEditorWidth)
    : (Number.isFinite(editorWidth) && editorWidth > 0 ? Math.round(editorWidth) : EDITOR_WEIGHT_REFERENCE)

  if (sidebarVisible) {
    columnList.push(`minmax(${MIN_PANE_WIDTH}px, ${Math.round(clampedSidebar)}fr)`, '1px')
  }

  columnList.push(`minmax(${MIN_PANE_WIDTH}px, ${editorWeight}fr)`)

  if (outlineVisible) {
    columnList.push('1px', `minmax(${MIN_PANE_WIDTH}px, ${Math.round(clampedOutline)}fr)`)
  }

  return columnList.join(' ')
}

/**
 * 计算大纲栏分隔条在 grid 中的轨道下标。
 * 侧栏可见时列顺序为 [侧栏, 分隔, 主区, 分隔, 大纲]，分隔条在第 3 列；
 * 侧栏隐藏时为 [主区, 分隔, 大纲]，分隔条在第 1 列。
 *
 * @param {boolean} sidebarVisible
 * @returns {number} 返回大纲栏分隔条所在的 grid 轨道下标。
 */
export function resolveOutlineGutterTrack(sidebarVisible) {
  return sidebarVisible ? 3 : 1
}

/**
 * 读取 grid-template-columns 里的最后一列宽度（大纲栏在末尾）。
 *
 * @param {string} computedGridTemplateColumns
 * @returns {number} 解析失败时返回 NaN。
 */
export function readTrailingTrackWidth(computedGridTemplateColumns) {
  const trackList = String(computedGridTemplateColumns ?? '').trim().split(/\s+/u)

  return Number.parseFloat(trackList[trackList.length - 1] ?? '')
}

/**
 * 右侧大纲栏的 split-grid 控制器：与左侧文件栏共用同一套拖拽实现，
 * 只是分隔条轨道下标与宽度取值方式不同。
 *
 * @param {{
 *   hostRef: { value?: HTMLElement | null },
 *   gutterRef: { value?: HTMLElement | null },
 *   panelWidthRef: { value: number },
 *   nextTick: () => Promise<void>,
 *   onPanelWidthCommit?: (width: number) => void,
 *   resolveGridTemplateColumns: (width: number) => string,
 *   gutterTrack?: number,
 *   resolveGutterTrack?: () => number,
 *   createSplitInstance?: (options: object) => { destroy?: (preserveStyles?: boolean) => void } | null,
 *   readComputedStyle?: (element: HTMLElement) => CSSStyleDeclaration | { gridTemplateColumns?: string },
 * }} options
 */
export function createHomeViewOutlinePanelLayoutController({
  hostRef,
  gutterRef,
  panelWidthRef,
  nextTick,
  onPanelWidthCommit,
  resolveGridTemplateColumns,
  gutterTrack = 1,
  resolveGutterTrack,
  createSplitInstance,
  readComputedStyle,
}) {
  return createHomeViewFilePanelLayoutController({
    hostRef,
    gutterRef,
    panelWidthRef,
    nextTick,
    onPanelWidthCommit,
    resolveGridTemplateColumns,
    createSplitInstance,
    readComputedStyle,
    gutterTrack,
    resolveGutterTrack,
    // 大纲栏在右侧：拖动改的是**最后一列**
    panelSide: 'end',
    minSize: OUTLINE_PANEL_MIN_WIDTH,
    clampPanelWidth: clampOutlinePanelWidth,
    readPanelWidth: readTrailingTrackWidth,
  })
}
