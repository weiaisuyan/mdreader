/**
 * 多栏并排的栏布局归一。
 *
 * 只描述「界面上摆几栏、每栏多宽」，不描述「哪些文档在哪一栏」——
 * 后者是标签组的归属事实，属于主进程的 store 与 tab-group.json，
 * 渲染层绝不能在这里另存一份，否则重启后就会出现两套互相矛盾的布局。
 *
 * 当前 UI 只开放 2 栏，但数据结构按 N 栏设计：
 * 加栏只需要放宽 MAX_PANE_COUNT，归一逻辑不用改。
 */

// 栏数量下限：至少一栏，否则编辑器无处可放。
export const MIN_PANE_COUNT = 1
// 栏数量上限：4 栏（数据结构本来就是按 N 栏设计的，放宽这里即可）。
export const MAX_PANE_COUNT = 4
// 单栏最小宽度（px）。
//
// 这是**全局唯一**的「栏最小宽度」真源：编辑区分栏、左侧文件栏、右侧大纲栏
// 三者都引用它（用户要求「文件栏、大纲栏、显示栏的最小宽度都统一」）。
//
// 取 160：220 时文件栏很快就触底、之后只剩编辑区在缩，用户实测反馈「最小宽度太大」。
// 160 让各栏有更长的等比缩放区间，触底更晚、过渡更自然。
export const MIN_PANE_WIDTH = 160
// 栏与栏之间分隔条的宽度（px）。
// 编辑区的 gutter 和顶栏标签条里的 gutter 必须同宽，否则上下对不齐。
export const PANE_GUTTER_WIDTH = 4

/**
 * 把任意输入归一成合法的栏布局。
 *
 * 归一规则刻意「不猜」：非法值一律回落到安全的默认值，
 * 因为这份数据会写进 config.json，宁可用默认布局也不能让窗口算出 0 宽。
 *
 * @param {object | null | undefined} rawLayout 配置里的原始值
 * @param {number} [maxCount] 允许的栏数上限；渲染层按实际栏数放宽，配置写盘时用默认上限
 * @returns {{ count: number, widths: Array<number | null> }} 归一后的布局
 */
export function normalizePaneLayout(rawLayout, maxCount = MAX_PANE_COUNT) {
  const upperBound = Math.max(MIN_PANE_COUNT, Number.isInteger(maxCount) ? maxCount : MAX_PANE_COUNT)
  const rawCount = Number.isInteger(rawLayout?.count) ? rawLayout.count : MIN_PANE_COUNT
  const count = Math.min(Math.max(rawCount, MIN_PANE_COUNT), upperBound)

  const rawWidthList = Array.isArray(rawLayout?.widths) ? rawLayout.widths : []
  const widths = []
  for (let i = 0; i < count; i++) {
    const width = rawWidthList[i]
    // null 表示「这一栏用 1fr 均分」，不是 0 宽：null 与数字必须区分开。
    widths.push(Number.isFinite(width) && width >= MIN_PANE_WIDTH ? width : null)
  }

  return { count, widths }
}

/**
 * 分栏用的宽度推导：把目标栏一分为二，新栏插到 `insertAt`。
 *
 * **纯函数**：不读 DOM、不写 DOM。基准必须来自**拆分前**的
 * `store.paneLayout.widths`（语义 = 上一个真实布局）。
 *
 * 为什么不能测 DOM（原来的做法）：
 * `applySplitPaneWidths` 在 Vue patch 之前同步测量，量到的是旧布局（少一栏），
 * 长度与最终列数不匹配 → `normalizePaneLayout` 给缺位补 `null`
 * → 出现「部分有限 + 部分 null」→ `resolvePaneGridTemplateColumns` 整排降级成 1fr 均分。
 * 3→4 栏时实测就是 1:1:2:2。
 *
 * 触底处理：目标栏已经是 160px 时切半是 80px，低于 `MIN_PANE_WIDTH`，
 * `normalizePaneLayout` 会把它变 `null` 再次触发降级 —— 所以这里夹住下限，
 * 与 CSS `minmax(160px, …)` 的钉住行为保持一致。
 *
 * @param {Array<number | null>} baseWidths 拆分前的宽度（长度 = 拆分前栏数）
 * @param {number} targetIndex 被拆分的栏下标
 * @param {number} insertAt 新栏插入位置
 * @param {number} [minWidth] 单栏最小宽度
 * @returns {Array<number> | null} 拆分后的宽度（长度 +1）；基准不可用时返回 null
 */
export function halvePaneWidths(baseWidths, targetIndex, insertAt, minWidth = MIN_PANE_WIDTH) {
  const list = Array.isArray(baseWidths) ? baseWidths : []
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= list.length) {
    return null
  }
  const targetWidth = list[targetIndex]
  if (!Number.isFinite(targetWidth) || targetWidth <= 0) {
    return null
  }

  const half = Math.max(minWidth, Math.round(targetWidth / 2))
  const next = [...list]
  next[targetIndex] = half

  const at = Number.isInteger(insertAt)
    ? Math.min(Math.max(insertAt, 0), next.length)
    : next.length
  next.splice(at, 0, half)

  return next.map(width => (
    Number.isFinite(width) && width >= minWidth ? Math.round(width) : minWidth
  ))
}

/**
 * 算出多栏容器的列模板。
 *
 * ## 为什么全部栏都用 fr 权重
 *
 * 用 `minmax(160px, 619px)` 这种「固定像素上限」时，窗口变窄这一栏纹丝不动，
 * 只有 `1fr` 那一栏承担全部收缩 —— 用户实测：「只有右边那一栏在动，左边栏没有反应」。
 *
 * 改成**每栏都用 fr 权重**（权重取该栏的像素值）后：
 * - 窗口变窄 → 所有栏按权重同比例缩小（都会动）；
 * - 某栏缩到 160px → CSS 把它钉住，剩余空间在其余栏之间重新分配。
 *
 * 这正是用户要的规则，且完全由 CSS Grid 原生实现，没有任何 JS 每帧计算。
 *
 * @param {{ count: number, widths: Array<number | null> }} layout 归一后的布局
 * @param {number} [gutterWidth] 栏间分隔条宽度
 * @param {number} [maxCount] 允许的栏数上限；渲染层要传实际栏数，避免真实栏数超过上限时列数错位
 * @returns {string} CSS grid-template-columns 值
 */
export function resolvePaneGridTemplateColumns(layout, gutterWidth = PANE_GUTTER_WIDTH, maxCount = MAX_PANE_COUNT) {
  const normalized = normalizePaneLayout(layout, maxCount)

  /**
   * 混合权重必须先归一，否则新加的栏会被压到最小宽度。
   *
   * 典型场景：两栏时用户调过宽度 → widths=[516, 545]；再加一栏 → [516, 545, null]。
   * 直接算会得到 `516fr 545fr 1fr`，第三栏的 1fr 在前两栏几百 fr 面前等于零，
   * CSS 把它钉在 160px —— 看起来就是「新栏细得像根线」。
   *
   * 处理方式与 `EditorPaneGrid.normalizeMixedPaneWidths` 一致：**全部转 1fr 均分**。
   * 不能拿当前渲染宽度去补 —— 那些宽度本身就是被错误权重算出来的。
   */
  const finiteCount = normalized.widths.filter(width => Number.isFinite(width)).length
  const mixed = finiteCount > 0 && finiteCount < normalized.count

  const columnList = []
  for (let i = 0; i < normalized.count; i++) {
    const width = mixed ? null : normalized.widths[i]
    if (i > 0) {
      columnList.push(`${gutterWidth}px`)
    }
    // 有存档宽度 → 用像素值当 fr 权重；没有 → 1fr 均分。
    // 两者都带 160px 下限，触底后由 CSS 钉住。
    const weight = Number.isFinite(width) ? Math.round(width) : 1
    columnList.push(`minmax(${MIN_PANE_WIDTH}px, ${weight}fr)`)
  }

  return columnList.join(' ')
}

/**
 * 算出「所有栏都缩到最小宽度」时，内容区需要的最小宽度。
 *
 * 窗口最小宽度不能拍一个固定值（原来写死 800）：栏数不同、侧栏显隐不同，
 * 需要的宽度差很多。写死 800 的后果是二栏布局下窗口到 800 就缩不动了，
 * 而左侧那栏还剩 300 多像素没缩到底 —— 用户实测：「缩到最小宽度之后还能再缩吗？
 * 我看你这里是缩不了了」。
 *
 * 改成按实际布局算：每一栏都取 MIN_PANE_WIDTH，加上所有分隔条。
 *
 * @param {{
 *   sidebarVisible?: boolean,
 *   outlineVisible?: boolean,
 *   paneCount?: number,
 *   sidebarGutterWidth?: number,
 * }} [options]
 * @returns {number} 内容区最小宽度（px）
 */
export function resolveMinContentWidth({
  sidebarVisible = false,
  outlineVisible = false,
  paneCount = 1,
  sidebarGutterWidth = 1,
} = {}) {
  const safePaneCount = Math.max(MIN_PANE_COUNT, Number.isInteger(paneCount) ? paneCount : 1)
  let total = safePaneCount * MIN_PANE_WIDTH
  // 编辑区内部的分隔条
  total += PANE_GUTTER_WIDTH * Math.max(0, safePaneCount - 1)
  // 侧栏 / 大纲栏各占一栏宽度 + 一条分隔条
  if (sidebarVisible) {
    total += MIN_PANE_WIDTH + sidebarGutterWidth
  }
  if (outlineVisible) {
    total += MIN_PANE_WIDTH + sidebarGutterWidth
  }
  return Math.round(total)
}
