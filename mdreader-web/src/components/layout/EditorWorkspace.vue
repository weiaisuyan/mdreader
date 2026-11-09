<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import LayoutContainer from '@/components/layout/LayoutContainer.vue'
import { useCommonStore } from '@/stores/counter.js'
import {
  clearEditorPaneDrag,
  editorPaneDropState,
  PANE_DROP_SIDE_LEFT,
  PANE_DROP_SIDE_RIGHT,
  setEditorPaneDropHover,
  setEditorPaneDropSide,
  setEditorPaneDropTargetGroupId,
} from '@/util/document-session/editorPaneDropState.js'
import {
  requestDocumentActivateTab,
  requestDocumentCreateGroup,
  requestDocumentMoveTabToGroup,
} from '@/util/document-session/rendererDocumentCommandUtil.js'
import { MAX_PANE_COUNT, MIN_PANE_WIDTH } from '@/util/document-session/paneLayoutUtil.js'
import {
  DROP_KIND_TAB,
  isOutsideTabSpan,
  isPointOnTab,
  resolveDropIntent,
  resolveEdgeSide,
} from '@/util/document-session/paneDropIntentUtil.js'
import PaneDropPreview from '@/components/layout/PaneDropPreview.vue'
import { isMarkdownFileName } from '@/util/document-session/documentDropOpenUtil.js'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import {
  FILE_PATH_MIME,
  openDroppedFileInGroup,
  openDroppedFileInSplitPane,
  resolveDroppedFilePath,
  resolveOpenFailureMessageKey,
} from '@/util/file-manager/fileDragDropUtil.js'

// 按栏渲染的编辑网格只在真正拆栏时才需要：
// 用异步组件把它挡在编辑页的静态依赖图之外，单栏用户的页面包体与启动路径不变。
const EditorPaneGrid = defineAsyncComponent(() => import('@/components/layout/EditorPaneGrid.vue'))

const route = useRoute()
const store = useCommonStore()
const { t } = useI18n()

// 只有编辑页参与多栏并排；设置页、导出页仍是单份页面。
const isEditorRoute = computed(() => route.name === 'editor')
// 真正要并排的栏数：单栏时继续走原来的 router-view + keep-alive 路径，
// 保证「不拆栏」的用户行为与改造前完全一致（含页面缓存与失活语义）。
const paneCount = computed(() => (Array.isArray(store.paneGroupList) ? store.paneGroupList.length : 1))
const usePaneGrid = computed(() => isEditorRoute.value && paneCount.value > 1)

const workspaceRef = ref(null)

/**
 * 单栏时要画的分栏预览。
 *
 * 单栏时 `EditorPaneGrid` 不渲染（继续走 router-view，保住页面缓存语义），
 * 所以预览要在这里单独取一份；多栏时交给 `EditorPaneGrid` 画在目标栏内部。
 *
 * @returns {{paneId: (string|null), side: ('left'|'right'|null), kind: string} | null} 预览状态
 */
const singlePaneDropHover = computed(() => (
  usePaneGrid.value ? null : editorPaneDropState.hover
))

/**
 * 命中指针所在的栏，并取出该栏**正文区**的矩形。
 *
 * 为什么量正文区而不是整个栏：栏的矩形包含顶部标签条，
 * 按整栏算的话标签条两端也会落进「外侧 20%」，于是拖到标签条最右边
 * 就被判成分栏 —— 那里明明是「加进这一栏」。
 *
 * @param {number} clientX 指针横坐标
 * @param {number} clientY 指针纵坐标
 * @returns {{paneId: (string|null), rect: (DOMRect|null), onTab: boolean, narrow: boolean}}
 *          命中信息；不在任何栏上时 paneId 为 null
 */
function resolvePaneHit(clientX, clientY) {
  const paneList = Array.isArray(store.paneGroupList) ? store.paneGroupList : []
  const singlePaneId = paneList.length <= 1 ? (paneList[0]?.groupId ?? null) : null

  /**
   * 单栏兜底：这时没有 `editor-pane` 元素（走的是 router-view 那条路径），
   * 整块编辑区就是那一栏。
   *
   * ⚠️ 必须校验指针**真的在编辑区矩形内**。原来无条件返回单栏 id，
   * 导致从文件栏拖文件时「还没拖出文件栏就松手」也被判成落在编辑区，
   * 于是稍微一拖文件就打开了 —— 用户根本没想打开它。
   */
  const singlePaneFallback = () => {
    if (singlePaneId === null) {
      return { paneId: null, rect: null, onTab: false, narrow: false }
    }
    const rect = workspaceRef.value?.getBoundingClientRect?.() ?? null
    if (!rect) {
      return { paneId: null, rect: null, onTab: false, narrow: false }
    }
    /**
     * 纵向必须有上下界：只判「不超出底部」时，拖到顶栏甚至窗口上缘之外
     * （clientY < 0）都算命中编辑区，从文件栏稍微往上偏一点松手就打开文件。
     * 上界放到标签条下缘——标签条本身不接文件投放，落在那里不算命中。
     */
    const tabStripHeight = 42
    const insideWorkspace = clientX >= rect.left && clientX <= rect.right
      && clientY >= rect.top - tabStripHeight
      && clientY <= rect.bottom
    if (!insideWorkspace) {
      return { paneId: null, rect: null, onTab: false, narrow: false }
    }
    return { paneId: singlePaneId, rect, onTab: false, narrow: isNarrow(rect) }
  }

  const isNarrow = rect => !rect || rect.width < MIN_PANE_WIDTH

  /**
   * 几何命中：按坐标与各栏的矩形比对。
   *
   * ⚠️ 必须放在 `elementFromPoint` **之前**。
   * 从资源管理器拖文件进来时（OS 级拖拽），`elementFromPoint` 经常返回 null 或
   * 某个覆盖层，导致判定拿不到栏 → 落点回落到「第一栏」。
   * 栏是规整的横向排列，用矩形比对既准又不依赖命中测试。
   *
   * 垂直方向允许到 body.top 以上（顶栏标签条区域），那里 x 仍落在栏的水平范围内。
   */
  const hitByGeometry = () => {
    const paneElements = [...(workspaceRef.value?.querySelectorAll?.('[data-testid="editor-pane"]') || [])]
    if (paneElements.length === 0) {
      return null
    }
    for (const paneEl of paneElements) {
      const bodyEl = paneEl.querySelector('[data-testid="editor-pane-body"]') ?? paneEl
      const rect = bodyEl.getBoundingClientRect()
      if (!(rect.width > 0)) {
        continue
      }
      const inHorizontalRange = clientX >= rect.left && clientX <= rect.right
      if (!inHorizontalRange) {
        continue
      }
      // 正文区内部，或上方顶栏标签条（y 小于 body.top）
      if (clientY <= rect.bottom) {
        const stripEl = document.querySelector(
          `[data-testid="editor-tab-strip-pane"][data-pane-group-id="${paneEl.dataset.paneId}"]`,
        )
        const inStrip = clientY < rect.top
        return {
          paneId: paneEl.dataset.paneId || null,
          rect,
          onTab: inStrip ? isPointOnTab(stripEl, clientX, clientY) : false,
          narrow: isNarrow(rect),
        }
      }
    }
    return null
  }

  const geometryHit = hitByGeometry()
  if (geometryHit) {
    return geometryHit
  }

  if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') {
    return singlePaneFallback()
  }
  const element = document.elementFromPoint(clientX, clientY)
  if (!element) {
    return singlePaneFallback()
  }

  // ① 指针在某一栏的正文区里
  const paneEl = element.closest?.('[data-testid="editor-pane"]')
  if (paneEl) {
    const bodyEl = paneEl.querySelector('[data-testid="editor-pane-body"]') ?? paneEl
    const rect = bodyEl.getBoundingClientRect()
    return {
      paneId: paneEl.dataset.paneId || null,
      rect,
      onTab: false,
      narrow: isNarrow(rect),
    }
  }

  // ② 指针在顶栏标签条上：标签条不在栏的 DOM 里，要反查那一栏的正文区矩形
  const stripEl = element.closest?.('[data-testid="editor-tab-strip-pane"]')
  const stripPaneId = stripEl?.dataset?.paneGroupId || null
  if (stripPaneId) {
    const targetPaneEl = document.querySelector(
      `[data-testid="editor-pane"][data-pane-id="${stripPaneId}"]`,
    )
    const bodyEl = targetPaneEl?.querySelector('[data-testid="editor-pane-body"]')
    // 单栏没有 pane 元素 → 回退到整块编辑区
    const rect = bodyEl?.getBoundingClientRect?.() ?? workspaceRef.value?.getBoundingClientRect?.() ?? null
    return {
      paneId: stripPaneId,
      rect,
      // 压在某个标签上：只能是「加进这一栏」，不能算边缘分栏
      onTab: isPointOnTab(stripEl, clientX, clientY),
      narrow: isNarrow(rect),
    }
  }

  return singlePaneFallback()
}

/**
 * 算出「松手会发生什么」并写进共享状态，供 `EditorPaneGrid` 画预览。
 *
 * 规则（照搬 DSH 多栏插件）：
 * - 外侧 20% = 分栏，中间 60% = 加标签；
 * - 压在标签上 = 加标签（**仅拖标签时**，见 ignoreTabHit）；
 * - 满栏时边缘带只给「最多 N 栏」提示，不画半屏。
 *
 * @param {number} clientX 指针横坐标
 * @param {number} clientY 指针纵坐标
 * @param {{ ignoreTabHit?: boolean }} [options]
 *        `ignoreTabHit`：拖**文件**时置 true。
 *        标签占位判定是给「拖标签排序/合并」用的 —— 拖文件没有排序语义，
 *        而标签常常被拉宽到占满整条栏，不忽略的话拖到标签条边缘永远判成「加标签」，
 *        用户看到的就是「拖到标签栏触发分栏却没有预览」。
 * @returns {{kind: string, paneId: (string|null), side: ('left'|'right'|null)}} 判定结果
 */
function updateDropHover(clientX, clientY, { ignoreTabHit = false } = {}) {
  const hit = resolvePaneHit(clientX, clientY)
  const intent = resolveDropIntent({
    paneRect: hit.rect,
    clientX,
    clientY,
    paneCount: paneCount.value,
    maxPaneCount: MAX_PANE_COUNT,
    onTab: ignoreTabHit ? false : hit.onTab,
    narrow: hit.narrow,
    paneId: hit.paneId,
  })

  // 「松手其实什么也不会变」的情况一律不给预览 —— 画了就是骗人。
  const shouldPreview = (() => {
    if (intent.kind === DROP_KIND_TAB) {
      return false
    }
    // 正在拖标签时，还有两条额外规则
    if (editorPaneDropState.dragging) {
      /**
       * 是不是拖在「自己那一栏」上。
       *
       * ⚠️ 单栏必须单独判：`startEditorPaneDrag` 在单栏时把 sourceGroupId 传成 null
       * （那时还没有真实标签组），而命中结果里的 paneId 是虚拟栏 id，两者永远不相等。
       * 只按 id 比的话，单栏拖自己的唯一标签到边缘会被当成「拖到别的栏」，
       * 于是弹出一个根本分不出去的半屏预览。
       */
      const isSinglePane = paneCount.value <= 1
      const samePane = isSinglePane
        || (hit.paneId !== null && hit.paneId === editorPaneDropState.sourceGroupId)
      if (samePane) {
        // ① 同栏唯一标签拖到自己这一栏的边缘 = 空操作（分出去等于没变化）
        const paneTabs = (store.paneGroupList || []).find(pane => pane.groupId === hit.paneId)?.tabs ?? []
        if (isSinglePane && paneTabs.length <= 1) {
          return false
        }
        // ② 同栏内拖动：还在标签群里 = 排序，别弹分栏预览；
        //    只有拖出标签群才谈得上分栏。
        const stripEl = document.querySelector(
          `[data-testid="editor-tab-strip-pane"][data-pane-group-id="${hit.paneId}"]`,
        )
        if (!isOutsideTabSpan(stripEl, clientX)) {
          return false
        }
      }
    }
    return true
  })()

  setEditorPaneDropHover(shouldPreview ? intent : null)
  return intent
}

/**
 * 拖**标签**时的左右半区判定（供标签条搬栏逻辑用）。
 *
 * @param {number} clientX 指针横坐标
 * @param {number} clientY 指针纵坐标
 * @returns {'left' | 'right' | null} 落在外侧 20% 时返回该侧
 */
function resolveDropSide(clientX, clientY) {
  const hit = resolvePaneHit(clientX, clientY)
  return resolveEdgeSide(hit.rect, clientX)
}

/**
 * 判断指针是否悬停在「另一栏」的标签条上。
 *
 * 标签条在顶栏，不在本组件的 DOM 里，所以只能靠命中测试反查。
 * 命中的那一栏就是这个标签要搬过去的目标栏。
 *
 * @param {number} clientX 指针横坐标
 * @param {number} clientY 指针纵坐标
 * @returns {string | null} 目标栏 groupId；不在别的栏上返回 null
 */
function resolveDropTargetGroupId(clientX, clientY) {
  if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') {
    return null
  }
  const element = document.elementFromPoint(clientX, clientY)
  const stripPane = element?.closest?.('[data-testid="editor-tab-strip-pane"]')
  const targetGroupId = stripPane?.dataset?.paneGroupId || null
  if (!targetGroupId || targetGroupId === editorPaneDropState.sourceGroupId) {
    return null
  }
  return targetGroupId
}

/**
 * 命中测试：松手位置落在哪一栏的编辑区里。
 *
 * @param {number} clientX 指针横坐标
 * @param {number} clientY 指针纵坐标
 * @returns {string | null} 该栏的 groupId；不在任何一栏上返回 null
 */
function resolveDropTargetPaneGroupId(clientX, clientY) {
  if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') {
    return null
  }
  const element = document.elementFromPoint(clientX, clientY)
  const pane = element?.closest?.('[data-testid="editor-pane"]')
  return pane?.dataset?.paneId || null
}

/**
 * 从文件列表拖到编辑区：松手时落在哪一栏就在哪一栏打开。
 *
 * 单栏时就是当前这一栏；多栏时按命中测试取栏，取不到回落到第一栏。
 *
 * @param {number} clientX 指针横坐标
 * @param {number} clientY 指针纵坐标
 * @returns {string | null} 目标栏 groupId
 */
function resolveHoveredPaneGroupId(clientX, clientY) {
  const paneList = Array.isArray(store.paneGroupList) ? store.paneGroupList : []
  if (paneList.length <= 1) {
    return paneList[0]?.groupId ?? store.focusedGroupId ?? null
  }
  return resolveDropTargetPaneGroupId(clientX, clientY) || paneList[0].groupId
}

/**
 * 文件列表拖拽经过编辑区时允许落下（忽略标签条拖拽等其他拖放）。
 *
 * ⚠️ 必须同时接受三种来源，少一种就有入口失效：
 * - `application/x-wj-file-path`：从本应用文件栏拖出（内部拖拽）
 * - `text/plain`：部分环境的内部拖拽只带这个
 * - `Files`：从**资源管理器**拖入（外部拖拽）。缺了它会导致 dragover 不 preventDefault，
 *   浏览器判定为「不允许放下」，drop 永远不触发 —— 外部拖文件进来就完全没反应。
 *
 * @param {DragEvent} event 原生 dragover 事件
 */
function handleFileDragOver(event) {
  const types = Array.from(event?.dataTransfer?.types || [])
  const isSupported = types.includes(FILE_PATH_MIME)
    || types.includes('text/plain')
    || types.includes('Files')
  if (!isSupported) {
    return
  }
  event.preventDefault()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy'
  }
  // 记录「松手会发生什么」，预览跟着它走（拖文件忽略标签占位，见 updateDropHover 注释）
  updateDropHover(event.clientX, event.clientY, { ignoreTabHit: true })
}

/**
 * 指针离开编辑区：收起预览，避免提示残留在屏幕上。
 *
 * @param {DragEvent} event 原生 dragleave 事件
 */
function handleFileDragLeave(event) {
  // dragleave 在移动到子元素时也会触发（冒泡），只有真正离开 workspace 才清理
  const next = event.relatedTarget
  if (next && workspaceRef.value?.contains?.(next)) {
    return
  }
  setEditorPaneDropHover(null)
}

/**
 * 文件列表拖到编辑区松手：在落点那一栏打开。
 *
 * 同一窗口内已打开的路径由主进程聚焦已有标签，不会出现两份相同的标签；
 * 不同窗口各自独立，同一个文件可以在多个窗口里同时打开。
 *
 * @param {DragEvent} event 原生 drop 事件
 */
async function handleFileDrop(event) {
  const path = resolveDroppedFilePath(event)
  if (!path) {
    return
  }
  event.preventDefault()
  // 落完就清掉预览
  setEditorPaneDropHover(null)

  const paneList = Array.isArray(store.paneGroupList) ? store.paneGroupList : []
  const hit = resolvePaneHit(event.clientX, event.clientY)
  const intent = resolveDropIntent({
    paneRect: hit.rect,
    clientX: event.clientX,
    clientY: event.clientY,
    paneCount: paneCount.value,
    maxPaneCount: MAX_PANE_COUNT,
    // 与 dragover 保持一致：拖文件忽略标签占位，否则「预览会分栏、松手却只加标签」
    onTab: false,
    narrow: hit.narrow,
    paneId: hit.paneId,
  })

  // 分栏意图（外侧 20% 边缘带）：把文件开进**目标栏那一侧**的新栏。
  // 其它情况都在目标栏里加一个标签。
  if (intent.kind === 'split' && paneList.length < MAX_PANE_COUNT) {
    const splitResult = await openDroppedFileInSplitPane(path, store, {
      targetGroupId: hit.paneId,
      side: intent.side,
    })
    const splitFailureKey = resolveOpenFailureMessageKey(splitResult?.reason)
    if (splitFailureKey) {
      message.error(t(splitFailureKey))
    }
    return
  }

  const groupId = hit.paneId ?? resolveHoveredPaneGroupId(event.clientX, event.clientY)
  const result = await openDroppedFileInGroup(path, groupId, store)
  const failureKey = resolveOpenFailureMessageKey(result?.reason)
  if (failureKey) {
    message.error(t(failureKey))
  }
}

/**
 * 拖**标签**时跟随指针更新预览与跨栏高亮。
 *
 * 与拖文件共用同一套判定（`updateDropHover`），保证两种拖拽的预览规则一致：
 * 外侧 20% 才画半屏，中间/标签上都不画。
 *
 * @param {PointerEvent} event 指针移动事件
 */
function handleDragPointerMove(event) {
  updateDropHover(event.clientX, event.clientY)
  setEditorPaneDropSide(paneCount.value > 1 ? null : resolveDropSide(event.clientX, event.clientY))
  // 拖到别的栏的标签条上要单独高亮：那表示「搬进那一栏」，不是「在这侧分栏」
  setEditorPaneDropTargetGroupId(resolveDropTargetGroupId(event.clientX, event.clientY))
}

/**
 * 落点处理：把被拖的标签放进目标侧。
 *
 * 单栏时先建一个空栏：
 * - 落在右半区：被拖标签搬进新栏，原栏保留其余标签；
 * - 落在左半区：被拖标签留在原栏（左），其余标签整批搬进新栏（右），
 *   视觉上同样是「被拖的那个在新栏的对面那一侧」。
 * 多栏时直接搬进目标侧的栏。
 *
 * @param {{sessionId: string, clientX: number, clientY: number}} drop 落点
 */
/**
 * 等快照里出现一个不在 `beforeIds` 里的栏。
 *
 * 建栏是异步的：IPC 返回后渲染层还要等一次快照推送才知道多了一栏。
 *
 * @param {object} store 渲染层 store
 * @param {Set<string>} beforeIds 操作前的栏 id 集合
 * @returns {Promise<string|null>} 新栏 id；超时返回 null
 */
async function waitForNewPaneGroupId(store, beforeIds, { retries = 30, intervalMs = 50 } = {}) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const paneList = Array.isArray(store?.paneGroupList) ? store.paneGroupList : []
    const found = paneList.find(pane => pane?.groupId && !beforeIds.has(pane.groupId))
    if (found) {
      return found.groupId
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  return null
}

async function applyPaneDrop(drop) {
  if (!drop) {
    return
  }
  const paneList = Array.isArray(store.paneGroupList) ? store.paneGroupList : []

  /**
   * 目标栏判定，两级：
   * 1. 落在某一栏的**标签条**上（跨栏拖标签条 = 搬进那一栏）；
   * 2. 退回编辑区**几何命中**（拖到某一栏的显示区，包括正中间）。
   *
   * ⚠️ 不能只靠 `elementFromPoint`：拖拽过程中它经常返回覆盖层或 null，
   * 直接表现就是「拖到右栏显示区中间松手，什么都没发生」。
   */
  const stripGroupId = paneList.length > 1
    ? resolveDropTargetPaneGroupId(drop.clientX, drop.clientY)
    : null
  const hitProbe = resolvePaneHit(drop.clientX, drop.clientY)
  const targetGroupId = stripGroupId || hitProbe?.paneId || null

  // 落在左侧文件栏 / 大纲栏 / 窗口外：既不是「搬进某栏」也不是「分栏」，什么都不做
  if (!targetGroupId) {
    return
  }

  const side = resolveDropSide(drop.clientX, drop.clientY)

  if (paneList.length > 1) {
    // 源栏从 drop 快照里读：`clearEditorPaneDrag()` 已经把模块状态清掉了
    const sourceGroupId = drop.sourceGroupId ?? editorPaneDropState.sourceGroupId

    /**
     * 落在**源栏自己**这一栏：
     * - 右缘 = 分栏（把这一栏一分为二，被拖的标签进新栏）；
     * - 中间/左缘 = 什么都不做 —— 把标签「搬」到它已经所在的栏没有意义，
     *   硬做只会把栏重排一次，看起来像闪了一下。
     */
    if (targetGroupId === sourceGroupId) {
      if (side !== PANE_DROP_SIDE_RIGHT || paneList.length >= MAX_PANE_COUNT) {
        return
      }
      const sourceIndex = paneList.findIndex(pane => pane?.groupId === sourceGroupId)
      if (sourceIndex < 0) {
        return
      }
      const beforeIds = new Set(paneList.map(pane => pane?.groupId).filter(Boolean))
      await requestDocumentCreateGroup(null, sourceIndex + 1).catch(() => null)
      const newGroupId = await waitForNewPaneGroupId(store, beforeIds)
      if (!newGroupId) {
        return
      }
      await requestDocumentMoveTabToGroup(drop.sessionId, newGroupId).catch(() => {})
      await requestDocumentActivateTab(drop.sessionId).catch(() => {})
      return
    }

    /**
     * 落在**别的栏**（显示区任意位置，含正中间；或那一栏的标签条）：
     * 合并进目标栏。
     *
     * 这里刻意**不做分栏**：多栏下的标签拖拽不画半屏预览，
     * 没有预览却改变栏数就是黑箱行为（用户第一反应是「我明明只想搬过去」）。
     */
    await requestDocumentMoveTabToGroup(drop.sessionId, targetGroupId).catch(() => {})
    // 搬过去之后必须**激活它**：用户把这个标签拖到那一栏，就是要看它。
    // 只搬不激活的话，标签进了新栏但新栏还停在原来的标签上，看起来像「拖过去没反应」。
    await requestDocumentActivateTab(drop.sessionId).catch(() => {})
    return
  }

  /**
   * 单栏：左右两侧边缘都分栏，中间 no-op。
   *
   * 预览（`PaneDropPreview`）在单栏下左右两侧都会画 —— 左半边高亮就是「松手在左边开一栏」。
   * 之前这里只认右缘，于是拖到左边缘时预览画了、松手什么都不发生，纯粹的骗人。
   * 预览与执行的判定必须一致。
   */
  if (side === null) {
    return
  }

  const siblingSessionIds = (paneList[0]?.tabs ?? [])
    .map(tab => tab.sessionId)
    .filter(sessionId => sessionId !== drop.sessionId)

  /**
   * 单栏、且这一栏只有这一个标签：分出去等于没变化 —— 直接 no-op。
   *
   * 必须在这里拦，不能只靠「不显示预览」：
   * 否则松手仍会建一个空栏再把唯一标签搬过去，原栏被回收，
   * 结果看起来是「栏闪了一下、什么都没变」，比不动更让人困惑。
   */
  if (siblingSessionIds.length === 0) {
    return
  }

  // 落在左缘 → 新栏插到最左（下标 0）；右缘 → 追加到末尾（不传 insertAt）
  await requestDocumentCreateGroup(null, side === PANE_DROP_SIDE_LEFT ? 0 : null).catch(() => null)
  const newGroupId = store.focusedGroupId
  if (!newGroupId) {
    return
  }
  await requestDocumentMoveTabToGroup(drop.sessionId, newGroupId).catch(() => {})
  await requestDocumentActivateTab(drop.sessionId).catch(() => {})
}

// 拖拽期间才挂指针监听：平时多一个全局监听没有任何价值
watch(() => editorPaneDropState.dragging, (dragging) => {
  if (!dragging) {
    window.removeEventListener('pointermove', handleDragPointerMove, true)
    return
  }
  window.addEventListener('pointermove', handleDragPointerMove, true)
})

/**
 * 上一次 dragover 的坐标。
 *
 * 浏览器在 **drop 之前**会再用 drop 的坐标补发一次 dragover。
 * 如果指针其实没动，这次补发的坐标与上次完全相同 —— 若照常重算，
 * 会把「边缘 = 分栏」的判定冲成「中间 = 加标签」，用户就看到
 * 「预览明明说会分栏，一松手却合并回一栏」。
 *
 * 坐标一致就跳过重算，保住上一次的判定。
 */
let lastDragOverPoint = { x: Number.NaN, y: Number.NaN }

/**
 * 全局 dragover：算出「指针现在在哪半区」，供分栏预览使用。
 *
 * 为什么不能只靠 workspace 上的 @dragover：
 * 用户从文件栏往右拖时，指针常落在**顶栏标签条**那片空白上（属于顶栏，
 * 不是本组件 DOM 的子节点），那里 dragover 不会冒泡到这里 ——
 * 表现就是「拖到右边会分栏，但全程没有预览」。
 *
 * 所以挂 window 级 capture 监听，任何位置的 dragover 都更新状态。
 *
 * @param {DragEvent} event 原生 dragover 事件
 */
function handleWindowDragOver(event) {
  const types = Array.from(event?.dataTransfer?.types || [])
  const isFileDrag = types.includes(FILE_PATH_MIME)
    || types.includes('text/plain')
    || types.includes('Files')
  if (!isFileDrag) {
    return
  }
  /**
   * 全局放行：不 preventDefault 的话浏览器判定「此处不允许放下」，
   * drop 永远不触发 —— 从资源管理器拖进来就会完全没反应。
   *
   * 各组件自己的 @dragover 也做了这件事，但那只覆盖各自 DOM；
   * 指针落在栏与栏之间的 gutter、顶栏空白这些地方时没人接，
   * 所以这里在 window capture 阶段统一兜住。
   */
  event.preventDefault()

  if (event.clientX === lastDragOverPoint.x && event.clientY === lastDragOverPoint.y) {
    return
  }
  lastDragOverPoint = { x: event.clientX, y: event.clientY }

  // 拖文件：忽略标签占位，标签条边缘也能判出分栏
  updateDropHover(event.clientX, event.clientY, { ignoreTabHit: true })
}

/**
 * 全局拖拽结束：清掉预览。
 *
 * `dragend` 在源元素触发、`drop` 之后也会有。
 * 必须挂上 —— 指针拖到窗口外松手时 dragleave 不一定来，
 * 不清的话半屏预览会永久留在屏幕上。
 */
function clearFileDropSide() {
  setEditorPaneDropHover(null)
  // 必须一起重置：下一次拖拽若首个 dragover 落在与上次终点相同的像素，
  // 会被去重逻辑跳过，hover 一直保持 null，落点判定就与预览分叉了。
  lastDragOverPoint = { x: Number.NaN, y: Number.NaN }
}

/**
 * 全局 drop：只要「落在外侧 20% 边缘带且还能加栏」，就在这里分栏。
 *
 * 为什么放在 window 的 capture 阶段而不是各组件的 @drop：
 * 预览是全局判定的，松手行为必须和预览一致。
 * 用户把文件拖到**顶栏标签条右侧**那片空白松手时，事件目标是标签栏，
 * 标签栏自己的 drop 只会「在当前栏加标签」—— 预览说会分栏、实际却不分，就是骗人。
 *
 * capture 阶段先拿到事件，分栏意图成立时 stopPropagation，
 * 避免标签栏 / workspace 的 drop 再重复打开一次。
 *
 * @param {DragEvent} event 原生 drop 事件
 */
async function handleWindowDrop(event) {
  const types = Array.from(event?.dataTransfer?.types || [])
  const isFileDrag = types.includes(FILE_PATH_MIME)
    || types.includes('text/plain')
    || types.includes('Files')
  if (!isFileDrag) {
    return
  }

  const path = resolveDroppedFilePath(event)
  // 非 Markdown（图片等资源）：交给编辑器自己的插入链路，这里不接管
  if (!path || !isMarkdownFileName(path)) {
    return
  }

  /**
   * 指针不在任何一栏上（还停在文件栏 / 侧边栏 / 窗口外）→ **不接管**。
   *
   * 不判断这一条的话，从文件栏拖文件时「稍微一动就松手」也会被打开 ——
   * 用户只是想拖，并没有放到编辑区。
   */
  const hitProbe = resolvePaneHit(event.clientX, event.clientY)
  if (!hitProbe.paneId && !hitProbe.rect) {
    return
  }

  /**
   * ⚠️ 直接复用 dragover 阶段算好的结论（`editorPaneDropState.hover`），不要重算。
   *
   * 原因：drop 事件的坐标是**松手那一瞬间**的指针位置，和最后一次 dragover
   * 常常差几个像素。判定带宽只有外侧 20%，这点偏差就足以让
   * 「dragover 判成分栏（有预览）」变成「drop 判成加标签（合并回一栏）」。
   *
   * 预览显示什么，松手就必须做什么：以 hover 为准。
   */
  const hover = editorPaneDropState.hover
  let intent
  let hit = null
  if (hover) {
    intent = { kind: hover.kind, paneId: hover.paneId, side: hover.side }
    hit = { paneId: hover.paneId }
  } else {
    hit = resolvePaneHit(event.clientX, event.clientY)
    intent = resolveDropIntent({
      paneRect: hit.rect,
      clientX: event.clientX,
      clientY: event.clientY,
      paneCount: paneCount.value,
      maxPaneCount: MAX_PANE_COUNT,
      // 与 dragover 保持一致：拖文件忽略标签占位
      onTab: false,
      narrow: hit.narrow,
      paneId: hit.paneId,
    })
  }

  const paneList = Array.isArray(store.paneGroupList) ? store.paneGroupList : []
  setEditorPaneDropHover(null)

  /**
   * Markdown 文件一律在这里接管并 `stopPropagation`。
   *
   * 否则事件会继续冒泡到 CodeMirror 的 `onDrop`，那条链路是「在**当前聚焦栏**
   * 开标签」——从资源管理器拖进来时没有 pointerdown，焦点还停在上一次的栏，
   * 于是「拖到第 4 栏，文件却开在第 1 栏」。
   */
  event.preventDefault()
  event.stopPropagation()

  if (intent.kind === 'split' && paneList.length < MAX_PANE_COUNT) {
    const splitResult = await openDroppedFileInSplitPane(path, store, {
      targetGroupId: hit.paneId,
      side: intent.side,
    })
    const splitFailureKey = resolveOpenFailureMessageKey(splitResult?.reason)
    if (splitFailureKey) {
      message.error(t(splitFailureKey))
    }
    return
  }

  const groupId = hit.paneId ?? store.focusedGroupId ?? null
  const result = await openDroppedFileInGroup(path, groupId, store)
  const failureKey = resolveOpenFailureMessageKey(result?.reason)
  if (failureKey) {
    message.error(t(failureKey))
  }
}

/**
 * 全局拖拽监听只绑一次。
 *
 * ⚠️ 必须防重复：这三个监听写在 setup 顶层，组件每挂载一次就绑一遍。
 * 绑了两遍时一次 drop 会被处理两次 —— 表现就是「拖一个文件进来，凭空多出两栏」。
 *
 * 标志必须挂在**模块级**（globalThis），`<script setup>` 里声明的 `let`
 * 是每个组件实例一份，对第二个实例完全无效。
 */
const dropListenerState = (globalThis.__wjEditorWorkspaceDropListener ||= { bound: false })

function bindDropListeners() {
  if (dropListenerState.bound) {
    return
  }
  dropListenerState.bound = true
  window.addEventListener('dragover', handleWindowDragOver, true)
  window.addEventListener('drop', handleWindowDrop, true)
  window.addEventListener('dragend', clearFileDropSide, true)
}

function unbindDropListeners() {
  if (!dropListenerState.bound) {
    return
  }
  dropListenerState.bound = false
  window.removeEventListener('dragover', handleWindowDragOver, true)
  window.removeEventListener('drop', handleWindowDrop, true)
  window.removeEventListener('dragend', clearFileDropSide, true)
}

bindDropListeners()

// 落点由标签条写入，这里消费掉；无论成功与否都要清空状态，避免下次拖拽带着旧落点
watch(() => editorPaneDropState.pendingDrop, (drop) => {
  if (!drop) {
    return
  }
  const payload = { ...drop }
  clearEditorPaneDrag()
  if (!isEditorRoute.value) {
    return
  }
  applyPaneDrop(payload).catch(() => {})
})

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', handleDragPointerMove, true)
  unbindDropListeners()
  clearEditorPaneDrag()
})
</script>

<template>
  <div
    ref="workspaceRef"
    class="relative h-full min-h-0 min-w-0 w-full flex flex-col"
    @dragover="handleFileDragOver"
    @dragleave="handleFileDragLeave"
    @drop="handleFileDrop"
  >
    <EditorPaneGrid v-if="usePaneGrid" />
    <div v-else class="h-0 min-h-0 flex-1">
      <LayoutContainer />
    </div>

    <!--
      单栏时的分栏预览。

      单栏走的是 router-view 那条路径（`EditorPaneGrid` 不渲染），
      但单栏恰恰是最常分栏的场景 —— 预览要在这里单独画一份，
      规则与多栏完全一致（同一份 `editorPaneDropState.hover`）。
    -->
    <PaneDropPreview
      v-if="singlePaneDropHover"
      :side="singlePaneDropHover.side"
      :limit="singlePaneDropHover.kind === 'limit'"
      :limit-count="MAX_PANE_COUNT"
    />
  </div>
</template>
