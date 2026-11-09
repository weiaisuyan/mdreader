/**
 * 编辑区分栏的「投放意图」判定 —— 全部是纯几何计算，不碰 DOM 之外的东西。
 *
 * 这套规则照搬 DSH 多栏插件（dsh-split-view）已验证的交互模型：
 *
 * 1. **只有外侧 20% 算分栏**（0.2 / 0.8），中间 60% 是「加标签」。
 *    早先用「中点分左右」，导致拖到中间也弹分栏预览 —— 与用户预期相反
 *    （拖到中间那栏，直觉就是「放进这一栏」）。
 *
 * 2. **量正文区，不量整个栏**。栏的矩形包含顶部标签条，
 *    会让标签条的两个外端点也被算成分栏目标。
 *
 * 3. **指针正落在标签上 = 加标签**。窄栏时标签群几乎贴着栏的左缘，
 *    不排除这条的话，拖到标签上会被误判成「左侧 20% 边缘」。
 *
 * 4. **满栏时不给分栏预览**，改给「最多 N 栏」提示 —— 画了半屏却分不出来是骗人。
 */

/** 外侧判定带宽：指针落在栏宽的右 20% 才算分栏 */
export const PANE_EDGE_RATIO = 0.2

/** 投放意图的种类 */
export const DROP_KIND_SPLIT = 'split'
export const DROP_KIND_TAB = 'tab'
export const DROP_KIND_LIMIT = 'limit'

/**
 * 指针落在这一栏的哪一侧边缘带。
 *
 * 左右都认，各占 20%：`left` | `right` | `null`（中间 60% = 合并到本栏）。
 *
 * 早期只做了右缘，理由是「主进程建栏对左侧插入不可靠」。那个前提现在已经不成立——
 * `requestDocumentCreateGroup` 支持 `insertAt`，`openDroppedFileInSplitPane` 也已经
 * 按 `side === 'left' ? targetIndex : targetIndex + 1` 算好了插入位置，
 * 左侧分栏能真正落在目标栏左边。所以判定层不该再挡着它。
 *
 * @param {{left: number, width: number}} rect 目标区域的矩形（用正文区，不是整个栏）
 * @param {number} clientX 指针横坐标
 * @returns {'left' | 'right' | null} 落在左/右边缘带返回对应侧，中间返回 null
 */
export function resolveEdgeSide(rect, clientX) {
  if (!rect || !(rect.width > 0)) {
    return null
  }
  const ratio = (clientX - rect.left) / rect.width
  if (ratio <= PANE_EDGE_RATIO) {
    return 'left'
  }
  if (ratio >= 1 - PANE_EDGE_RATIO) {
    return 'right'
  }
  return null
}

/**
 * 指针是否正压在某个标签上。
 *
 * 标签是可交互元素、有明确边界，落在它上面就是「加进这一栏」，
 * 不该再按边缘判定去分栏。
 *
 * @param {Element | null} stripEl 标签条元素（内部含 .document-tab）
 * @param {number} clientX 指针横坐标
 * @param {number} clientY 指针纵坐标
 * @returns {boolean} 是否压在标签上
 */
export function isPointOnTab(stripEl, clientX, clientY) {
  if (!stripEl || typeof stripEl.querySelectorAll !== 'function') {
    return false
  }
  for (const tabEl of stripEl.querySelectorAll('.document-tab')) {
    // 排除标签条容器自身（它的类名也带 document-tab 前缀）
    const className = tabEl.className?.toString?.() || ''
    if (className.includes('bar') || className.includes('scroller')) {
      continue
    }
    const rect = tabEl.getBoundingClientRect()
    if (clientX >= rect.left && clientX <= rect.right
      && clientY >= rect.top && clientY <= rect.bottom) {
      return true
    }
  }
  return false
}

/**
 * 标签群实际占用的水平范围（第一个标签左缘 .. 最后一个标签右缘）。
 *
 * @param {Element | null} stripEl 标签条元素
 * @returns {{left: number, right: number} | null} 没有标签时返回 null
 */
export function resolveTabSpan(stripEl) {
  if (!stripEl || typeof stripEl.querySelectorAll !== 'function') {
    return null
  }
  const tabList = [...stripEl.querySelectorAll('.document-tab')].filter((tabEl) => {
    const className = tabEl.className?.toString?.() || ''
    return !className.includes('bar') && !className.includes('scroller')
  })
  if (tabList.length === 0) {
    return null
  }
  const first = tabList[0].getBoundingClientRect()
  const last = tabList[tabList.length - 1].getBoundingClientRect()
  return { left: first.left, right: last.right }
}

/** 标签群外扩的容差：留一点余量，免得「想排到第一个」都排不了 */
export const TAB_SPAN_SLACK = 24

/**
 * 指针是否已经拖出标签群。
 *
 * 群内（含容差）一律算排序 —— 否则想把标签排到第一个就没法拖；
 * 只有真正拖出去，才谈得上「分栏」这个动作。
 *
 * @param {Element | null} stripEl 标签条元素
 * @param {number} clientX 指针横坐标
 * @returns {boolean} 是否在标签群之外
 */
export function isOutsideTabSpan(stripEl, clientX) {
  const span = resolveTabSpan(stripEl)
  if (span === null) {
    return false
  }
  return clientX < span.left - TAB_SPAN_SLACK || clientX > span.right + TAB_SPAN_SLACK
}

/**
 * 算出「松手会发生什么」。
 *
 * @param {object} options 判定输入
 * @param {{left: number, right: number, top: number, bottom: number, width: number}} options.paneRect
 *        指针所在栏的**正文区**矩形
 * @param {number} options.clientX 指针横坐标
 * @param {number} options.clientY 指针纵坐标
 * @param {number} options.paneCount 当前栏数
 * @param {number} options.maxPaneCount 栏数上限
 * @param {boolean} [options.onTab] 指针是否压在标签上（压着就只能是加标签）
 * @param {boolean} [options.narrow] 该栏是否窄到没有可用的左右边缘
 * @param {string | null} [options.paneId] 指针所在栏的 id
 * @returns {{kind: string, paneId: (string|null), side: ('left'|'right'|null)}}
 *          kind: 'split' 分栏 / 'tab' 加标签 / 'limit' 已达上限
 */
export function resolveDropIntent({
  paneRect,
  clientX,
  clientY,
  paneCount,
  maxPaneCount,
  onTab = false,
  narrow = false,
  paneId = null,
}) {
  const fallback = { kind: DROP_KIND_TAB, paneId, side: null }

  if (!paneRect) {
    return fallback
  }
  // 水平方向必须在栏内；垂直方向**不设上界**：
  // 指针常常落在栏上方的顶栏标签条那片空白上（那里不属于栏的 DOM），
  // 按「必须在矩形内」判的话，拖到标签条右侧永远算不出分栏 ——
  // 表现就是「会分栏但没有预览」。命中哪一栏已由调用方用 elementFromPoint 定好。
  if (clientX < paneRect.left || clientX > paneRect.right || clientY > paneRect.bottom) {
    return fallback
  }
  // 压在标签上 / 栏太窄：只能是加标签
  if (onTab || narrow) {
    return fallback
  }

  const side = resolveEdgeSide(paneRect, clientX)
  if (side === null) {
    return fallback
  }

  // 边缘带但已经满栏：给「最多 N 栏」提示，不画半屏预览
  if (paneCount >= maxPaneCount) {
    return { kind: DROP_KIND_LIMIT, paneId, side }
  }

  return { kind: DROP_KIND_SPLIT, paneId, side }
}
