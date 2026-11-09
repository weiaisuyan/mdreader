<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { message } from 'ant-design-vue'
import DocumentTabBar from '@/components/layout/DocumentTabBar.vue'
import { useCommonStore } from '@/stores/counter.js'
import { editorPaneDropState } from '@/util/document-session/editorPaneDropState.js'
import { setFocusedPreparationProviderKey } from '@/util/document-session/currentWindowOpenPreparationService.js'
import { requestDocumentActivateGroup } from '@/util/document-session/rendererDocumentCommandUtil.js'
import { createTabInCurrentWindow } from '@/util/document-session/rendererTabCommandService.js'
import {
  FILE_PATH_MIME,
  isPaneReusableBlank,
  openDroppedFileInGroup,
  openDroppedFileInSplitPane,
  openDroppedFileReplacingBlank,
  resolveDroppedFilePath,
  resolveOpenFailureMessageKey,
} from '@/util/file-manager/fileDragDropUtil.js'
import {
  PANE_GUTTER_WIDTH,
  resolvePaneGridTemplateColumns,
} from '@/util/document-session/paneLayoutUtil.js'

/**
 * 顶栏里的标签条。
 *
 * 标签栏不再独占一行：它和顶部工具栏并排，一行里「左边是开关/菜单、中间是标签、
 * 右边是视图模式与窗口控制」。
 *
 * 多栏时每栏一条，并且**必须落在自己那一栏的正上方**：列宽与左右位置都从下方
 * `editor-pane-grid` 的真实几何抄（见 measureAlign），不自己按「均分」算一遍——
 * 栏宽被拖动过之后是明确的 px，均分会立刻对不齐。这样标签条与编辑区逐像素对齐，
 * 拖动栏宽时上下一起变；栏与栏之间的 gutter 列在这里也是一条竖线，
 * 视觉上和编辑区的分隔条连成一条。
 */
const route = useRoute()
const store = useCommonStore()
const { t } = useI18n()

// 只有编辑页有标签：设置页、导出页要把整行让给窗口拖动。
const isEditorRoute = computed(() => route.name === 'editor')
const paneList = computed(() => (Array.isArray(store.paneGroupList) ? store.paneGroupList : []))
const showTabStrip = computed(() => isEditorRoute.value && paneList.value.length > 0)
const isMultiPane = computed(() => paneList.value.length > 1)

const rootRef = ref(null)
// 文件拖拽经过哪一栏：给标签栏一个「可以放这里」的高亮
const fileDragOverGroupId = ref(null)
// 与编辑区对齐用的三个量：左右内边距 + 从编辑区抄来的列模板
const alignState = ref({ paddingLeft: 0, paddingRight: 0, columns: '' })

/**
 * 把编辑区的几何抄过来。
 *
 * - `paddingLeft/Right`：标签条容器与编辑区容器的左右差值，用来把标签条推到编辑区正上方；
 * - `columns`：编辑区 grid 的计算列宽（已解析成 px，含 4px 分隔列），照抄即可逐像素对齐；
 * - 侧边栏收起时编辑区会跑到顶栏按钮左边（`gridLeft < rootLeft`），此时左内边距只能是 0，
 *   改成把第一列削掉被遮住的宽度——保证栏间分隔条仍然对齐，只有第一栏的标签条变窄。
 *
 * jsdom 里没有布局也没有 `editor-pane-grid`，一律回落到按栏数均分的模板，组件测试照旧。
 */
function measureAlign() {
  const root = rootRef.value
  if (!root || typeof document === 'undefined') {
    return
  }
  // 锚点用「编辑区列容器」：单栏、多栏、侧边栏开关三种状态下它都存在，
  // 而 editor-pane-grid 只在多栏时渲染——单栏时拿它当锚点会取不到，标签条就退回均分、
  // 跑到侧边栏分割线左边去（用户报的「单栏时标签页跑到左边来了」）。
  const anchor = document.querySelector('[data-testid="editor-column"]')
  const grid = document.querySelector('[data-testid="editor-pane-grid"]')
  // 容器节点被重建过就重新绑观察器，否则之后再也收不到几何变化
  bindAnchorObserver(anchor, grid)
  const rootRect = root.getBoundingClientRect()
  if (!anchor || !rootRect.width) {
    alignState.value = { paddingLeft: 0, paddingRight: 0, columns: '' }
    return
  }
  const anchorRect = anchor.getBoundingClientRect()
  if (!anchorRect.width) {
    alignState.value = { paddingLeft: 0, paddingRight: 0, columns: '' }
    return
  }
  const paddingLeft = Math.max(0, anchorRect.left - rootRect.left)
  const paddingRight = Math.max(0, rootRect.right - anchorRect.right)
  // 编辑区左侧被顶栏按钮盖住的那一段：从第一列里扣掉，分隔条才不会整体右移
  const leftCovered = Math.max(0, rootRect.left - anchorRect.left)
  // 多栏：列模板直接抄编辑区 grid 的计算值（含 4px 分隔列），拖动栏宽也永远同步。
  // 单栏：没有 grid，交给回落模板（一列 minmax(0,1fr)），宽度由 padding 卡死等于编辑区。
  const rawColumns = grid
    ? (getComputedStyle(grid).gridTemplateColumns || '')
      .split(' ')
      .map(value => Number.parseFloat(value))
      .filter(value => Number.isFinite(value) && value > 0)
    : []
  let columns = ''
  if (rawColumns.length === paneList.value.length * 2 - 1) {
    columns = rawColumns.map((value, index) => {
      if (index !== 0) {
        return `${value}px`
      }
      return `${Math.max(PANE_GUTTER_WIDTH, value - leftCovered)}px`
    }).join(' ')
  }
  alignState.value = { paddingLeft, paddingRight, columns }
}

const fallbackColumns = computed(() => {
  // 单栏：编辑区永远占满整列，列宽必须由容器决定（padding 已把它收窄到编辑区宽度）。
  // 不能用 paneLayout 里遗留的上一轮栏宽——否则标签条只剩 897 宽、缩在左边，
  // 正是用户报的「单栏时标签页跑到左边来了」。
  if (paneList.value.length <= 1) {
    return 'minmax(0, 1fr)'
  }
  return resolvePaneGridTemplateColumns(
    { count: paneList.value.length, widths: store.paneLayout.widths },
    PANE_GUTTER_WIDTH,
    // 列数必须跟实际渲染的栏数一致，理由与 EditorPaneGrid 相同
    paneList.value.length,
  )
})
const gridTemplateColumns = computed(() => alignState.value.columns || fallbackColumns.value)
const stripStyle = computed(() => ({
  gridTemplateColumns: gridTemplateColumns.value,
  paddingLeft: `${alignState.value.paddingLeft}px`,
  paddingRight: `${alignState.value.paddingRight}px`,
}))

let resizeObserver = null
let mutationObserver = null
let observedAnchor = null
let observedGrid = null
let retryFrame = 0
let retryLeft = 0
let measureFrames = 0

/**
 * 量一次；量不到（编辑区还没挂上）就在后续帧里重试。
 *
 * 组件挂载顺序不保证编辑区已经进 DOM，`onMounted` 时 `editor-pane-grid` 可能还不存在；
 * 而它的尺寸之后也不会再变（ResizeObserver 不会被触发），所以必须自己补重试，
 * 否则会永远停在「均分」的回落模板上。
 */
function measureAlignWithRetry() {
  measureAlign()
  // 单栏时 columns 本来就是空（只有一列，交给回落模板），不能用它判断「没量到」
  const measured = alignState.value.paddingLeft > 0 || alignState.value.paddingRight > 0
  // 变化后连量几帧：栏数切换（单↔双）时 DOM 与 store 不是同一帧到位，
  // 只量一帧可能读到「旧 grid 还在」的中间态，把过期的列模板留在标签条上。
  if (measureFrames > 0 && typeof requestAnimationFrame === 'function') {
    measureFrames -= 1
    retryFrame = requestAnimationFrame(measureAlignWithRetry)
    return
  }
  if (!measured && retryLeft > 0 && typeof requestAnimationFrame === 'function') {
    retryLeft -= 1
    retryFrame = requestAnimationFrame(measureAlignWithRetry)
  }
}

function scheduleMeasure() {
  if (retryFrame && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(retryFrame)
  }
  retryLeft = 30
  measureFrames = 3
  if (typeof requestAnimationFrame === 'function') {
    retryFrame = requestAnimationFrame(measureAlignWithRetry)
    return
  }
  measureAlign()
}

/**
 * 把观察器绑到当前的编辑区容器上。
 *
 * 侧边栏/大纲栏开关、单栏↔多栏切换都会让编辑区重排、容器节点也可能被重建：
 * 绑在旧节点上的观察器从此收不到任何回调，标签条就会停在旧位置。
 * 所以每次量到新的锚点/新的 grid 都要重新绑一次。
 */
function bindAnchorObserver(anchor, grid) {
  if (anchor !== observedAnchor) {
    observedAnchor = anchor
    if (resizeObserver && anchor) {
      resizeObserver.observe(anchor)
    }
  }
  if (grid === observedGrid) {
    return
  }
  observedGrid = grid
  if (mutationObserver) {
    mutationObserver.disconnect()
    mutationObserver = null
  }
  if (!grid) {
    return
  }
  // 拖分隔条改的是「列模板」不是容器尺寸：容器宽高都没变，ResizeObserver 不会响，
  // 必须盯 style 属性的变化，否则上下会对不齐（栏宽拖动后标签条不动）。
  if (typeof MutationObserver === 'function') {
    mutationObserver = new MutationObserver(() => measureAlign())
    mutationObserver.observe(grid, { attributes: true, attributeFilter: ['style', 'class'] })
  }
}

function startObserving() {
  if (typeof ResizeObserver !== 'function') {
    return
  }
  const root = rootRef.value
  resizeObserver = new ResizeObserver(() => measureAlign())
  // 顶栏自身宽度变化（窗口缩放）也要重算
  if (root) {
    resizeObserver.observe(root)
  }
  bindAnchorObserver(
    document.querySelector('[data-testid="editor-column"]'),
    document.querySelector('[data-testid="editor-pane-grid"]'),
  )
}

onMounted(() => {
  startObserving()
  scheduleMeasure()
  // 拖拽被取消（按 Escape）或拖出窗口时，`dragleave` 不一定到达这一栏，
  // 那圈 2px 描边会永久留在一栏上。全局兜底清一次。
  window.addEventListener('dragend', clearFileDragOverHighlight, true)
  window.addEventListener('drop', clearFileDragOverHighlight, true)
  window.addEventListener('keydown', handleGlobalKeydownForDragHighlight, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('dragend', clearFileDragOverHighlight, true)
  window.removeEventListener('drop', clearFileDragOverHighlight, true)
  window.removeEventListener('keydown', handleGlobalKeydownForDragHighlight, true)
  if (retryFrame && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(retryFrame)
  }
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  if (mutationObserver) {
    mutationObserver.disconnect()
    mutationObserver = null
  }
})

// 栏数/栏宽变化后编辑区会重排，等一帧再抄几何
watch([() => paneList.value.length, () => store.paneLayout, () => isEditorRoute.value], () => {
  nextTick(scheduleMeasure)
}, { deep: true })

// 侧边栏/大纲栏开关会让编辑区左右边界整体平移，几何必须重抄
watch([() => store.sidebarVisible, () => store.outlineVisible], () => {
  nextTick(scheduleMeasure)
})
// 拖拽悬停在哪一栏的标签条上（跨栏搬运的落点提示）
const dropTargetGroupId = computed(() => editorPaneDropState.targetGroupId)

/**
 * 某一栏当前的标签列表。
 *
 * 取数口径必须与 DocumentTabBar 一致：单栏读窗口级快照，多栏读该栏的分组快照，
 * 否则「这一栏有没有新标签」会跟标签条上看到的对不上。
 */
function resolvePaneTabList(groupId) {
  if (!isMultiPane.value) {
    return store.documentSessionSnapshot?.tabs || []
  }
  return store.getPaneGroupSnapshot?.(groupId)?.tabs || []
}

/**
 * 这一栏里是否已经有一个「新建但还没保存」的标签。
 *
 * 判定口径 = 没有 displayPath（已保存的文档一定有路径，新标签没有）。
 * 有的话「新建标签」按钮置灰：一栏里堆多个空白标签没有意义。
 */
function paneHasNewTab(groupId) {
  return resolvePaneTabList(groupId).some(tab => !tab.displayPath)
}

async function createTabInPane(pane) {
  if (paneHasNewTab(pane.groupId)) {
    return
  }
  try {
    // 先聚焦这一栏，新标签才会落进这栏而不是当前聚焦的那栏
    await requestDocumentActivateGroup(pane.groupId)
    await createTabInCurrentWindow()
  } catch (error) {
    message.error(t('documentTab.newTabFailed'))
  }
}

/** 拖拽中的东西是不是「本应用的文件列表项」（而非外部文件、文本等）。 */
function isFileDragPayload(event) {
  const types = Array.from(event?.dataTransfer?.types || [])
  return types.includes(FILE_PATH_MIME) || types.includes('text/plain')
}

function handlePaneDragOver(pane, event) {
  if (!isFileDragPayload(event)) {
    return
  }
  event.preventDefault()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy'
  }
  fileDragOverGroupId.value = pane.groupId
}

function handlePaneDragLeave(pane, event) {
  // 只有当指针真的离开这一栏时才清高亮（进入子元素也会触发 dragleave）
  const nextTarget = event?.relatedTarget
  if (nextTarget && event.currentTarget?.contains?.(nextTarget)) {
    return
  }
  if (fileDragOverGroupId.value === pane.groupId) {
    fileDragOverGroupId.value = null
  }
}

/** 拖拽结束（成功投放 / 拖出窗口）后清掉所有栏的「可放这里」描边。 */
function clearFileDragOverHighlight() {
  fileDragOverGroupId.value = null
}

/** 按 Escape 取消拖拽时，浏览器不会再发 dragleave/dragend，必须自己清。 */
function handleGlobalKeydownForDragHighlight(event) {
  if (event?.key === 'Escape') {
    fileDragOverGroupId.value = null
  }
}

/**
 * 从文件列表拖到某一栏的标签区松手：在**这一栏**打开它。
 *
 * 已在本窗口打开过的文件，主进程会聚焦已有标签而不会新建第二个，
 * 所以一个窗口里不会出现两份相同文件（跨窗口互不影响）。
 */
async function handlePaneDrop(pane, event) {
  const path = resolveDroppedFilePath(event)
  if (!path) {
    return
  }
  event.preventDefault()
  fileDragOverGroupId.value = null

  /**
   * 这一栏只有一个空白标签时，任何位置的拖入都视为「就在这儿打开」，不分栏。
   *
   * 否则用户把文件拖到一个什么都没写的新建标签上，会得到「左边凭空多出一个空白标签、
   * 右边才是文件」的结果 —— 那个空白标签纯属噪音。
   */
  if (isPaneReusableBlank(pane)) {
    const blankResult = await openDroppedFileReplacingBlank(path, pane, store)
    const blankFailureKey = resolveOpenFailureMessageKey(blankResult?.reason)
    if (blankFailureKey) {
      message.error(t(blankFailureKey))
    }
    return
  }

  // 单栏时拖到这一栏标签条的**右半**（含最右侧那块空白）= 想分栏，
  // 而不是在原来这一栏里再加一个标签。
  if (!isMultiPane.value && isRightHalfOfDropTarget(event)) {
    const splitResult = await openDroppedFileInSplitPane(path, store)
    const splitFailureKey = resolveOpenFailureMessageKey(splitResult?.reason)
    if (splitFailureKey) {
      message.error(t(splitFailureKey))
    }
    return
  }

  const result = await openDroppedFileInGroup(path, pane.groupId, store)
  const failureKey = resolveOpenFailureMessageKey(result?.reason)
  if (failureKey) {
    message.error(t(failureKey))
  }
}

/** 落点是否在触发元素的右半部分（标签条右侧那段空白也算）。 */
function isRightHalfOfDropTarget(event) {
  const rect = event?.currentTarget?.getBoundingClientRect?.()
  if (!rect || !rect.width) {
    return false
  }
  return event.clientX > rect.left + rect.width / 2
}

/**
 * 点到某一栏的标签条（标签之间的空白、或者空白处）就把焦点交给这一栏。
 *
 * 编辑区那一侧由 EditorPaneGrid 的 `@pointerdown.capture` 负责，标签条在顶栏
 * 不属于它，所以这里得单独补：否则用户在右栏标签条空白处点一下，
 * 焦点仍留在左栏，接着按快捷键或新建标签都会作用到错误的那一栏。
 */
/**
 * 把焦点交给某一栏。
 *
 * ⚠️ 必须先登记「焦点栏的准备能力提供者」，再发激活命令。
 * 多栏下每一栏都是独立的 EditorView 实例，各自用 `paneId` 注册了准备能力
 * （`setCurrentWindowOpenPreparationProvider`）；切换文档前的「正文收敛」
 * 会通过 `focusedPreparationProviderKey` 找到该用哪一个栏的编辑器。
 *
 * 少这一步时：key 还停在上一个焦点栏，切走的那一瞬间 flush 会拿错栏的编辑器，
 * 轻则掉字，重则把正文写进隔壁栏打开的那个文件。
 * `EditorPaneGrid.focusPane` 一直有这行，顶栏标签条这里漏了。
 */
function focusPane(groupId) {
  if (!groupId) {
    return
  }
  setFocusedPreparationProviderKey(groupId)
  if (groupId === store.focusedGroupId) {
    return
  }
  requestDocumentActivateGroup(groupId).catch(() => {})
}
</script>

<template>
  <div
    v-if="showTabStrip"
    ref="rootRef"
    data-testid="editor-tab-strip"
    class="electron-drag grid min-w-0 w-full items-stretch"
    :style="stripStyle"
  >
    <template
      v-for="(pane, index) in paneList"
      :key="pane.groupId"
    >
      <div
        data-testid="editor-tab-strip-pane"
        :data-pane-group-id="pane.groupId"
        :data-drop-active="dropTargetGroupId === pane.groupId ? 'true' : 'false'"
        :data-file-drag-over="fileDragOverGroupId === pane.groupId ? 'true' : 'false'"
        class="editor-tab-strip__pane min-w-0 overflow-hidden flex items-stretch electron-drag"
        @dragover="event => handlePaneDragOver(pane, event)"
        @dragleave="event => handlePaneDragLeave(pane, event)"
        @drop="event => handlePaneDrop(pane, event)"
      >
        <!-- 单栏时不传 groupId：沿用窗口级快照，行为与改造前逐字段一致 -->
        <DocumentTabBar
          :group-id="isMultiPane ? pane.groupId : null"
          class="min-w-0 flex-1"
        >
          <!-- 「新建标签」按钮紧跟在最后一个标签后面（不再贴在栏最右边） -->
          <template #after-tabs>
            <button
              type="button"
              data-testid="editor-tab-strip-new-tab"
              class="editor-tab-strip__new-tab electron-no-drag shrink-0 flex items-center justify-center"
              :disabled="paneHasNewTab(pane.groupId)"
              :title="t('documentTab.newTab')"
              :aria-label="t('documentTab.newTab')"
              @click="createTabInPane(pane)"
            >
              <span class="i-tabler:plus" />
            </button>
          </template>
        </DocumentTabBar>
      </div>
      <div
        v-if="index < paneList.length - 1"
        aria-hidden="true"
        data-testid="editor-tab-strip-gutter"
        class="editor-tab-strip__gutter"
      />
    </template>
  </div>
</template>

<style scoped lang="scss">
.editor-tab-strip__pane {
  // 标签条宽度严格等于自己那一栏：容器 grid 已按栏切好，这里只负责不溢出
  min-width: 0;
}

.editor-tab-strip__pane[data-drop-active='true'] {
  // 拖拽悬停在别的栏的标签条上：整条高亮，明确「松手就搬到这一栏」。
  //
  // 这里**绝对不能用 opacity**：opacity 作用于整个子树，会把这一栏里
  // 所有标签的文字一起压到 16% 不透明度（用户看到的「3、4 变特别暗，
  // 而另一栏的 1 不变」就是这个）。只用半透明背景，子元素保持原样。
  background: color-mix(in srgb, var(--wj-primary-color, #1677ff) 16%, transparent);
}

// 从文件列表拖文件经过这一栏的标签条：描边框提示「可以放这里」
.editor-tab-strip__pane[data-file-drag-over='true'] {
  box-shadow: inset 0 0 0 2px var(--wj-primary-color, #1677ff);
  border-radius: 4px;
}

.editor-tab-strip__gutter {
  // 与编辑区 gutter 同色同宽，竖向连成一条分隔线
  background: var(--wj-border-color, rgba(128, 128, 128, 0.18));
}

// 「新建标签」按钮：紧跟最后一个标签，与标签同高
.editor-tab-strip__new-tab {
  width: 26px;
  height: 24px;
  // 左 4px 与最后一个标签留缝；右 4px 与栏边留白
  margin: 0 4px 0 4px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--wj-markdown-text-secondary, #888);
  font-size: 14px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;

  &:hover:not(:disabled) {
    background: var(--wj-markdown-bg-hover, rgba(128, 128, 128, 0.16));
    color: var(--wj-markdown-text-primary, #ddd);
  }

  // 这一栏已经有空白标签：置灰并禁用，视觉上明确「点了也没用」
  &:disabled {
    cursor: not-allowed;
    opacity: 0.35;
  }
}
</style>
