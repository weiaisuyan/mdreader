<script setup>
import { message, Modal } from 'ant-design-vue'
import { computed, ref, useSlots, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useCommonStore } from '@/stores/counter.js'
import { requestCurrentWindowOpenPreparation } from '@/util/document-session/currentWindowOpenPreparationService.js'
import {
  clearEditorPaneDrag,
  editorPaneDropState,
  queueEditorPaneDrop,
  startEditorPaneDrag,
} from '@/util/document-session/editorPaneDropState.js'
import {
  requestDocumentMoveTabToGroup,
  requestDocumentMoveTabToNewWindow,
  requestDocumentReorderTabs,
  requestDocumentRevealInFolder,
} from '@/util/document-session/rendererDocumentCommandUtil.js'
import {
  activateTabById,
  closeTabById,
  closeTabsByIds,
} from '@/util/document-session/rendererTabCommandService.js'
import { copyTextWithFeedback } from '@/util/previewInlineCodeCopyUtil.js'
import { useDocumentTabDrag } from '@/util/useDocumentTabDrag.js'
import {
  openDroppedFileInGroup,
  resolveDroppedFilePath,
  resolveOpenFailureMessageKey,
} from '@/util/file-manager/fileDragDropUtil.js'

/**
 * 多栏并排时这一栏对应的标签组 id。
 *
 * 默认 null 表示单栏：组件直接读窗口快照，取到的对象与改造前完全一致，
 * 所以单栏的渲染结果、拖拽顺序、右键菜单语义都不会因为多栏改动而变化。
 */
const props = defineProps({
  groupId: { type: String, default: null },
})

/**
 * 文档标签栏。
 *
 * 标签栏只是文档会话的视图外壳：
 * 1. 标签项只承载展示信息，正文永远从活动会话的完整快照里取
 * 2. 关闭、切换、重排一律发命令给主进程，渲染层不做脏判断、不自己改顺序
 * 3. 标签顺序就是主进程返回的数组顺序，渲染层不排序
 *
 * 布局是纯 flex 流，全程不使用 position：
 * - 标签内部：[脏点槽 14px] 文件名 [关闭槽 14px]，两个槽宽度恒定，
 *   干净标签只是不渲染圆点，槽位仍然占位，所以所有标签的文字起点完全一致
 * - 标签内部间距：内边距与 gap 统一为 4px，四段间距完全对称
 *   （4 | 脏点槽 | 4 | 文件名 | 4 | 关闭槽 | 4）
 * - 标签之间：独立的 `.document-tab-separator` 元素（1×16px，两侧各 4px），
 *   由 v-for 生成，数量恒为「标签数 − 1」，不用 border 也不用伪元素
 *
 * 尺寸基准（与现有界面严格对齐）：
 * - 标签栏 32px = 侧边栏 tab 区（p-1 + h-6）；含 1px 顶边框后两者都是 33px
 * - 标签 24px = 侧边栏 tab 按钮 / 工具栏 IconButton 的 h-6
 * - 标签最大宽 240px（max-w-60）：内边距与 gap 统一 4px，固定开销共 44px，
 *   文件名可用 196px；短文件名标签更窄，只有长文件名才会顶到这个上限
 * - 分隔线 16px = 标题栏那条竖分隔线（LayoutTop 的 h-4 w-px）
 *
 * 横向溢出（产品要求：不要滚动条）：
 * - 标签按可用宽度均分（`flex-1 basis-0`），最窄 24px（`min-w-6`），最宽 240px（`max-w-60`）
 * - 超过可用宽度时继续缩窄并把文件名截断，`overflow-hidden` 保证不出现任何滚动条
 * - 历史上的自绘 overlay 滑块、垂直滚轮转横向滚动、活动标签自动补位移都已移除
 *
 * 拖拽重排：
 * - 交互全部在 `useDocumentTabDrag` 里，这里只负责把目标顺序交给主进程
 * - 拖拽过程不发任何 IPC，松手且顺序真的变了才发一次 `document.reorder-tabs`
 * - 标签顺序仍然是主进程返回的数组顺序，渲染层不自己排序
 *
 * 状态规则：
 * - 脏点只要有就一直显示，没有任何 hover 规则去隐藏它
 * - 关闭按钮只在 hover 时显示；槽位恒定，显隐不产生任何位移
 *
 * 对齐 Obsidian 的两条额外手势：
 * - 中键点标签即关闭（`auxclick` + button 1），拖拽进行中不生效
 * - 双击标签栏空白处新建标签，双击标签本身或关闭按钮都不触发
 *
 * 标签栏自己不画底边框：下方区域在两种视图模式下都已经有一条同位置的顶边框
 * （源码/分栏是 EditorToolbar 的 border-t，纯预览是布局元素的 b-t），
 * 两边都画会出现双线。顶部边框则是必须的：标题栏与标签栏同为 bg-primary，
 * 没有分隔线时两者会连成一片；侧边栏顶部也有同一条边框，两者因此对齐。
 */
const store = useCommonStore()
const { t } = useI18n()

/**
 * 当前这条标签栏是否属于**焦点栏**（用户正在看的那一栏）。
 *
 * 单栏时 `props.groupId` 是 null，永远算焦点栏。
 * 多栏时每栏一个 `DocumentTabBar`，只有焦点栏的那一个为 true。
 *
 * 用途：标签下方的激活横条要区分两种情况 ——
 * - 焦点栏的激活标签：青色（「我正在看的就是它」）
 * - 非焦点栏的激活标签：灰色（「它在那栏里开着，但我没在看它」）
 * - 其它标签：没有横条
 */
const isFocusedPane = computed(() => (
  !props.groupId || props.groupId === store.focusedGroupId
))

const paneSnapshot = computed(() => store.getPaneGroupSnapshot(props.groupId))

const tabs = computed(() => (
  props.groupId ? (paneSnapshot.value?.tabs || []) : (store.documentSessionSnapshot?.tabs || [])
))
const slots = useSlots()
/**
 * 空栏也要渲染整条标签栏。
 *
 * 原来根节点是 `v-if="tabs.length > 0"`：某一栏还没有标签时整条不渲染，
 * 而「+ 新建标签」按钮挂在 `after-tabs` 插槽里，于是空栏既没有标签条、
 * 也没有 + 按钮 —— 用户拆出新栏后根本无法往里面放东西，也就永远拆不出第 4 栏。
 * 现在改为「有标签、或者调用方提供了尾部插槽」就渲染。
 */
const shouldRender = computed(() => tabs.value.length > 0 || Boolean(slots['after-tabs']))

const activeSessionId = computed(() => (
  props.groupId
    // 与 counter.js 的虚拟 main 栏保持同一口径：activeSessionId 缺失时回退 sessionId，
    // 否则个别快照里「文件列表说这一栏在显示某文件、标签条却一个激活标签都没有」。
    ? (paneSnapshot.value?.activeSessionId ?? paneSnapshot.value?.sessionId ?? null)
    : (store.documentSessionSnapshot?.activeSessionId ?? store.documentSessionSnapshot?.sessionId ?? null)
))

const scrollerRef = ref(null)

/**
 * 标签栏不再滚动：标签按可用宽度均分，各自缩窄到 `min-w-6`（24px）为止，
 * 再多就只是把名字截断，不出现滚动条。
 *
 * 历史上这里有一套自绘 overlay 滑块 + 垂直滚轮转横向滚动 + 活动标签补位移，
 * 产品明确不要滚动条，故整套移除；`scrollerRef` 仍保留给拖拽层测量用。
 */

/**
 * 判断落点是不是「另一栏的标签条」。
 *
 * 拖动时指针在同高的标签条之间移动，纵向位置没有变化，
 * 只能靠命中的 DOM 判断落到了哪一栏的标签条上。
 *
 * @param {{ clientX: number, clientY: number }} drop 松手位置
 * @returns {string | null} 目标栏的 groupId；不是别的栏则返回 null
 */
function resolveDropTargetGroupId(drop) {
  if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') {
    return null
  }
  const element = document.elementFromPoint(drop.clientX, drop.clientY)
  const stripPane = element?.closest?.('[data-testid="editor-tab-strip-pane"]')
  const targetGroupId = stripPane?.dataset?.paneGroupId || null
  if (!targetGroupId) {
    return null
  }
  // 落回自己这一栏不算跨栏：交给本栏的重排逻辑处理
  return targetGroupId === (props.groupId ?? store.focusedGroupId) ? null : targetGroupId
}

/**
 * 拖拽重排。
 *
 * `onCommit` 是唯一发 IPC 的地方：拖拽过程完全在渲染层完成，
 * 主进程只负责裁决顺序并广播新快照。
 * 顺序没变时 `useDocumentTabDrag` 不会调用它。
 */
const {
  isDragging,
  draggedSessionId,
  handlePointerDown: handleTabPointerDownRaw,
  shouldSuppressClick,
  notifyTabsChanged,
} = useDocumentTabDrag({
  scrollerRef,
  getSessionIds: () => tabs.value.map(tab => tab.sessionId),
  onCommit: nextSessionIds => (
    // 单栏不传第二个参数：命令 payload 与改造前逐字节一致，
    // 主进程走的就是旧的重排分支。
    props.groupId
      ? requestDocumentReorderTabs(nextSessionIds, props.groupId)
      : requestDocumentReorderTabs(nextSessionIds)
  ),
  // 落在别的栏的标签条上：这不是重排，而是「搬到那一栏」
  isDropOutsideTabBar: drop => Boolean(resolveDropTargetGroupId(drop)),
  onDropOutside: (drop) => {
    const targetGroupId = resolveDropTargetGroupId(drop)
    if (targetGroupId) {
      // 拖到另一栏的标签条松手 = 把这个标签搬进那一栏，并跟过去
      requestDocumentMoveTabToGroup(drop.sessionId, targetGroupId)
        .then(() => {})
        .catch(() => message.error(t('documentTab.moveToOtherPaneFailed')))
      return
    }
    // 拖到标签栏下方的编辑区松手 = 想在那侧分栏，交给 EditorWorkspace 处理
    queueEditorPaneDrop(drop)
  },
  onError: () => message.error(t('documentTab.reorderFailed')),
})

/**
 * 文件拖到标签栏空白处：在这一栏打开。
 *
 * 标签栏在顶栏，不在 EditorWorkspace 的 DOM 里，所以那边绑的 @drop 接不到这里。
 * 用户把文件从文件栏（或资源管理器）拖到标签条右侧那片空白时，直觉就是
 * 「放进这一栏」—— 必须单独接住，否则整条标签栏是「拖不进去」的死区。
 *
 * @param {DragEvent} event 原生 dragover 事件
 */
function handleTabBarFileDragOver(event) {
  // 拖标签（内部搬栏）由 useDocumentTabDrag 处理，这里只管文件拖入
  if (isDragging.value) {
    return
  }
  const types = Array.from(event?.dataTransfer?.types || [])
  const isFileDrag = types.includes('application/x-wj-file-path')
    || types.includes('text/plain')
    || types.includes('Files')
  if (!isFileDrag) {
    return
  }
  event.preventDefault()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy'
  }
}

/**
 * 文件拖到标签栏松手：在**指针所在那一栏**开新标签。
 *
 * ⚠️ 不能用 `props.groupId`：多栏时一个 `DocumentTabBar` 渲染了所有栏的标签条，
 * `props.groupId` 是 null，回落到 `store.focusedGroupId` 就会永远落在聚焦栏 ——
 * 用户实测「拖到第二栏的标签条，松手跑到第一栏」就是这么来的。
 *
 * 必须按落点反查是哪一栏的标签条。
 *
 * @param {DragEvent} event 原生 drop 事件
 */
async function handleTabBarFileDrop(event) {
  if (isDragging.value) {
    return
  }
  const path = resolveDroppedFilePath(event)
  if (!path) {
    return
  }
  event.preventDefault()

  const hitElement = typeof document.elementFromPoint === 'function'
    ? document.elementFromPoint(event.clientX, event.clientY)
    : null
  const stripPane = hitElement?.closest?.('[data-testid="editor-tab-strip-pane"]')
  const targetGroupId = stripPane?.dataset?.paneGroupId
    || props.groupId
    || store.focusedGroupId
    || null

  const result = await openDroppedFileInGroup(path, targetGroupId, store)
  const failureKey = resolveOpenFailureMessageKey(result?.reason)
  if (failureKey) {
    message.error(t(failureKey))
  }
}

// 拖拽开始/结束同步到模块级状态：编辑区的左右半区高亮依赖它
watch(isDragging, (dragging) => {
  if (dragging) {
    // 记下“从哪一栏拖出去的”，跨栏落点判定要排除自己这一栏
    startEditorPaneDrag(draggedSessionId.value, props.groupId)
    return
  }
  // 正常落点会被 EditorWorkspace 消费；这里只兜底清掉“拖着拖着被取消”的状态
  if (!editorPaneDropState.pendingDrop) {
    clearEditorPaneDrag()
  }
})

// 标签增删或顺序变化后把最新顺序告诉拖拽层：
// 提交后靠它确认“主进程已经换成目标顺序”，
// 拖拽中被外部改动则直接取消，避免渲染层和主进程各执一份顺序。
watch(tabs, (nextTabs) => {
  notifyTabsChanged((nextTabs || []).map(tab => tab.sessionId))
}, { flush: 'post' })

// 标签标题直接用会话文件名。
// 未命名草稿在数据层就是固定的 `Untitled` 哨兵值，
// 展示层不再做国际化，保证所有语言下看到同一个标识。
const UNTITLED_FILE_NAME = 'Untitled'

function getTabLabel(tab) {
  return tab?.fileName || UNTITLED_FILE_NAME
}

/**
 * 标签的悬浮提示文案。
 *
 * 默认就是文件名：长文件名会被 `truncate` 截断，这里顺带承担“看全名”的作用。
 * 文件被删除 / 移走、存在未决外部变更时，在文件名后补一句原因，
 * 避免用户只看到一条黄色文字却不知道发生了什么。
 *
 * 两种黄态理论上互斥（文件缺失时主进程会清空 pendingExternalChange），
 * 仍然把缺失放在前面：它描述的是更严重、且不会自行恢复的那个状态。
 */
function getTabTitle(tab) {
  const label = getTabLabel(tab)
  if (tab?.fileMissing === true) {
    return t('documentTab.fileDeletedOrMoved', { fileName: label })
  }
  if (tab?.hasPendingExternalChange === true) {
    return t('documentTab.externalChangePending', { fileName: label })
  }

  return label
}

function isActiveTab(tab) {
  return Boolean(tab) && tab.sessionId === activeSessionId.value
}

/**
 * 标签的视觉状态类。
 *
 * 激活态用实心胶囊，未激活只靠文字色区分；脏标签额外提亮文字色，
 * 保证「脏」在任何状态下都能被看见，而不是只在 hover 时才出现。
 */
function getTabClassList(tab) {
  const active = isActiveTab(tab)
  return {
    'bg-bg-hover': active,
    'color-text-primary': active || tab?.dirty === true,
    'font-medium': active,
    'color-text-secondary': !active && tab?.dirty !== true,
    'hover:bg-[var(--wj-markdown-bg-secondary)]': !active,
  }
}

function handleTabPointerDown(tab, event) {
  if (!tab?.sessionId) {
    return
  }
  handleTabPointerDownRaw(tab.sessionId, event)
}

/**
 * 点击激活。
 *
 * 拖拽结束后那一次 click 必须吞掉：
 * 用户已经表达了“我在拖动”，此时再顺手激活一个后台标签完全不符合预期。
 */
function handleTabClick(tab) {
  if (shouldSuppressClick(tab?.sessionId)) {
    return
  }
  activateTab(tab)
}

function activateTab(tab) {
  if (!tab?.sessionId) {
    return
  }

  /**
   * 只有「本栏激活 **且焦点已经在本栏**」才跳过。
   *
   * 只判 isActiveTab 会漏掉一种情况：右栏的标签在右栏里是 active，
   * 但焦点还在左栏。用户点它本意是「切到这一栏看它」，
   * 此时提前 return 会让命令根本不发出去 —— 焦点永远切不过去，
   * 表现就是「点另一个栏里的标签没反应」。
   *
   * 主进程的 activateSession 本来就会连带把 focusedGroupId 设成该标签所在的栏，
   * 所以这里只要把命令发出去即可。
   */
  if (isActiveTab(tab) && isFocusedPane.value) {
    return
  }

  // 切换前的正文收敛与 autoSave 降级由 rendererTabCommandService 统一负责，
  // 保证点击与快捷键走同一份契约。
  activateTabById(tab.sessionId).then(() => {}).catch(() => {})
}

function closeTab(tab) {
  if (!tab?.sessionId) {
    return
  }
  closeTabById(tab.sessionId).then(() => {}).catch(() => {})
}

/**
 * 双击标签关闭它（对齐 Obsidian）。
 *
 * 空白处的双击归「新建标签」，这里的 `.stop` 保证两件事互不串门；
 * 拖拽过程中的双击同样忽略，理由与中键一致。
 */
function handleTabDblClick(tab) {
  if (isDragging.value) {
    return
  }
  closeTab(tab)
}

/**
 * 中键关闭标签（对齐 Obsidian）。
 *
 * 只在 `auxclick` 上判中键：按下/抬起已经归拖拽层处理，在这里再判一次会打断拖拽收尾。
 * 拖拽进行中一律不关，那一刻用户表达的是“我在移动标签”，不是“我要关掉它”。
 */
function handleTabAuxClick(tab, event) {
  if (event.button !== 1 || isDragging.value) {
    return
  }
  event.preventDefault()
  closeTab(tab)
}

/**
 * 中键按下时拦掉默认行为。
 *
 * 标签栏是可横向滚动的容器，Chromium 会对中键按下进入“自动滚动”模式，
 * 松手后还要再点一下才能退出。中键在这里只承担关闭语义，因此直接压制。
 */
function handleTabMouseDown(event) {
  if (event.button === 1) {
    event.preventDefault()
  }
}

/**
 * 双击标签栏空白处的行为：**不做事**。
 *
 * 这里原本是「双击空白新建标签」（对齐 Obsidian），但顶栏空白区域要能像标题栏一样
 * 拖动窗口 / 双击最大化，而 Electron 的 `-webkit-app-region: drag` 会把这些鼠标事件
 * 直接吞掉、网页根本收不到 —— 两者只能留一个。产品决定：空白区拖动窗口优先，
 * 新建标签改用标签条尾部那个「+」按钮。
 */

/**
 * 批量关闭一批标签页。
 *
 * 脏标签交给主进程裁决，渲染层不再先行过滤：
 * - 未开启“关闭标签自动保存”时，主进程仍然只关干净标签（行为不变）
 * - 开启后，脏标签会先写盘再关
 *
 * 渲染层的脏标记本身可能除旧（后台标签的正文尚未回流），
 * 在这里过滤等于拿不可信的脏状态做决定。
 *
 * 必须一次请求发给主进程，不能 forEach 逐个发：
 * 逐个关闭时主进程每个命令都会先激活目标、再推一次快照，
 * 渲染层会看到活动标签一路跳过去（标签循环切换）。
 */
function closeTabList(tabList) {
  const sessionIds = tabList
    .filter(tab => tab && tab.sessionId)
    .map(tab => tab.sessionId)
  if (sessionIds.length === 0) {
    return
  }
  closeTabsByIds(sessionIds).then(() => {}).catch(() => {})
}

function closeOtherTabs(tab) {
  closeTabList(tabs.value.filter(item => item.sessionId !== tab.sessionId))
}

function closeTabsToRight(tab) {
  const targetIndex = tabs.value.findIndex(item => item.sessionId === tab.sessionId)
  if (targetIndex < 0) {
    return
  }
  closeTabList(tabs.value.slice(targetIndex + 1))
}

function closeTabsToLeft(tab) {
  const targetIndex = tabs.value.findIndex(item => item.sessionId === tab.sessionId)
  if (targetIndex < 0) {
    return
  }
  closeTabList(tabs.value.slice(0, targetIndex))
}

function copyTextToClipboard(text) {
  if (!text) {
    return
  }
  copyTextWithFeedback({
    text,
    writeText: async value => await navigator.clipboard.writeText(value),
    onEmpty() {
      message.warning(t('message.noCopyableContent'))
    },
    onSuccess() {
      message.success(t('message.copySucceeded'))
    },
    onError() {
      message.error(t('message.copyFailed'))
    },
  })
}

function copyTabFileName(tab) {
  copyTextToClipboard(tab?.fileName || '')
}

function copyTabPath(tab) {
  copyTextToClipboard(tab?.displayPath || '')
}

function revealTabInExplorer(tab) {
  const targetPath = tab?.displayPath || ''
  if (!targetPath) {
    return
  }
  requestDocumentRevealInFolder(targetPath)
    .then((result) => {
      if (result?.ok === true) {
        return
      }
      if (result?.reason === 'not-found') {
        message.warning(t('message.fileNotFound'))
      }
    })
    .catch(() => {})
}

/**
 * 把标签移动到新窗口。
 *
 * 会话整体搬走：正文、脏状态、外部变更待处理态都保留，所以脏标签和未命名标签都能移。
 * 但撤销历史存在渲染进程的 EditorState 里，新窗口拿不到，
 * 所以必须二次确认并明确告知这条限制。
 *
 * 迁移前要先把挂起的正文同步进主进程：
 * 活动标签的正文可能还在 160ms 防抖窗口里，不 flush 就迁移会让最后一次输入随旧窗口一起消失。
 * 后台标签的正文在切走那一刻就已经同步过了，不需要多这一次往返。
 */
async function moveTabToNewWindow(tab) {
  if (!tab?.sessionId) {
    return
  }

  const confirmed = await new Promise((resolve) => {
    Modal.confirm({
      title: t('documentTab.moveToNewWindowConfirmTitle'),
      content: t('documentTab.moveToNewWindowConfirmContent', {
        fileName: getTabLabel(tab),
      }),
      okText: t('okText'),
      cancelText: t('cancelText'),
      centered: true,
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    })
  })
  if (!confirmed) {
    return
  }

  if (isActiveTab(tab)) {
    try {
      await requestCurrentWindowOpenPreparation()
    }
    catch {}
  }

  try {
    const movedWindowId = await requestDocumentMoveTabToNewWindow(tab.sessionId)
    if (!movedWindowId) {
      message.error(t('documentTab.moveToNewWindowFailed'))
      return
    }
    message.success(t('documentTab.moveToNewWindowSucceeded'))
  }
  catch {
    message.error(t('documentTab.moveToNewWindowFailed'))
  }
}

/**
 * 把标签搬到另一栏。
 *
 * 搬的是同一个文档会话（不复制）：一个会话同时属于两栏会让两套 CodeMirror view
 * 各自持有 undo 栈，正文与撤销历史会分叉，所以跨栏只允许「搬家」。
 */
const otherPaneGroupId = computed(() => {
  const groupList = Array.isArray(store.paneGroupList) ? store.paneGroupList : []
  if (groupList.length <= 1) {
    return null
  }
  const currentGroupId = props.groupId ?? store.focusedGroupId
  const targetGroup = groupList.find(group => group.groupId !== currentGroupId)
  return targetGroup?.groupId ?? null
})

async function moveTabToOtherPane(tab) {
  if (!tab?.sessionId || !otherPaneGroupId.value) {
    return
  }

  // 活动标签的正文可能还在防抖窗口里，先收敛再搬，避免最后一次输入留在旧栏。
  if (isActiveTab(tab)) {
    try {
      await requestCurrentWindowOpenPreparation()
    }
    catch {}
  }

  try {
    const moved = await requestDocumentMoveTabToGroup(tab.sessionId, otherPaneGroupId.value)
    if (!moved) {
      message.error(t('documentTab.moveToOtherPaneFailed'))
      return
    }
    message.success(t('documentTab.moveToOtherPaneSucceeded'))
  }
  catch {
    message.error(t('documentTab.moveToOtherPaneFailed'))
  }
}

function getMenuItems(tab) {
  const hasPath = Boolean(tab?.displayPath)
  // 文件已从磁盘消失时，任何“要求文件真实存在”的动作都必须禁用。
  // 复制路径 / 复制文件名只需要路径字符串或文件名，仍然有效——
  // 此刻用户恰恰要靠复制出来的路径去找文件被搬到了哪里，不能一并禁掉。
  const fileMissing = tab?.fileMissing === true
  const tabIndex = tabs.value.findIndex(item => item.sessionId === tab?.sessionId)

  // 批量关闭的禁用态必须跟主进程的裁剪策略一致，否则会出现“能关但菜单是灰的”
  // （或者反过来“点了什么也没发生”）：
  //
  // - 未开启“关闭标签自动保存”：脏标签一律跳过，所以只有干净标签算可关。
  // - 开启后：脏标签会先保存再关，因此只要它能被自动保存就算可关：
  //   有真实路径即可；recent-missing 虽然没路径，但本来就放行关闭，也算可关。
  //   未命名草稿无路径，即使开启开关也会被跳过，不能算“可关”。
  const autoSaveOptionList = Array.isArray(store.config?.autoSave) ? store.config.autoSave : []
  const closeTabAutoSaveEnabled = autoSaveOptionList.includes('closeTab')
  const isBatchClosable = (item) => {
    if (!item?.sessionId) {
      return false
    }
    if (item.dirty !== true) {
      return true
    }
    if (closeTabAutoSaveEnabled !== true) {
      return false
    }
    return Boolean(item.displayPath) || item.isRecentMissing === true
  }
  const leftTabs = tabIndex > 0 ? tabs.value.slice(0, tabIndex) : []
  const rightTabs = tabIndex >= 0 ? tabs.value.slice(tabIndex + 1) : []
  const otherTabs = tabs.value.filter(item => item.sessionId !== tab?.sessionId)

  const hasClosableOthers = otherTabs.some(isBatchClosable)
  const hasClosableLeft = leftTabs.some(isBatchClosable)
  const hasClosableRight = rightTabs.some(isBatchClosable)

  return [
    {
      key: 'close',
      label: t('documentTab.close'),
    },
    // 关闭类动作一组：它们都只影响标签存在性
    {
      key: 'close-others',
      label: t('documentTab.closeOthers'),
      disabled: !hasClosableOthers,
    },
    {
      key: 'close-left',
      label: t('documentTab.closeToLeft'),
      disabled: !hasClosableLeft,
    },
    {
      key: 'close-right',
      label: t('documentTab.closeToRight'),
      disabled: !hasClosableRight,
    },
    // 分隔线把“关闭”与“窗口动作”分开
    {
      type: 'divider',
    },
    {
      key: 'move-to-other-pane',
      label: t('documentTab.moveToOtherPane'),
      // 只有真并排（两栏以上）才有「另一栏」可搬。
      disabled: !otherPaneGroupId.value,
    },
    {
      key: 'move-to-new-window',
      label: t('documentTab.moveToNewWindow'),
      // 只有一个标签时“移动到新窗口”等于把整个窗口搬走：
      // 结果和“关窗口 + 开新窗口”一样，只会平白丢掉撤销历史。
      disabled: tabs.value.length <= 1,
    },
    // 分隔线把“窗口动作”与“文件操作”分开
    {
      type: 'divider',
    },
    {
      key: 'copy-file-name',
      label: t('documentTab.copyFileName'),
    },
    {
      key: 'copy-path',
      label: t('documentTab.copyPath'),
      disabled: !hasPath,
    },
    {
      key: 'reveal-in-explorer',
      label: t('documentTab.revealInExplorer'),
      // “在资源管理器中显示”要求目标文件真实存在：
      // 文件被删除或移动后点下去只会是一条“文件不存在”的警告，直接置灰更诚实。
      disabled: !hasPath || fileMissing,
    },
  ]
}

function onMenuClick({ key }, tab) {
  if (key === 'close') {
    closeTab(tab)
    return
  }
  if (key === 'close-others') {
    closeOtherTabs(tab)
    return
  }
  if (key === 'close-left') {
    closeTabsToLeft(tab)
    return
  }
  if (key === 'close-right') {
    closeTabsToRight(tab)
    return
  }
  if (key === 'move-to-other-pane') {
    moveTabToOtherPane(tab)
    return
  }
  if (key === 'move-to-new-window') {
    moveTabToNewWindow(tab)
    return
  }
  if (key === 'copy-file-name') {
    copyTabFileName(tab)
    return
  }
  if (key === 'copy-path') {
    copyTabPath(tab)
    return
  }
  if (key === 'reveal-in-explorer') {
    revealTabInExplorer(tab)
  }
}
</script>

<template>
  <div
    v-if="shouldRender"
    data-testid="document-tab-bar"
    class="document-tab-bar relative min-w-0 w-full flex shrink-0 items-center border-t-1 border-t-border-primary border-t-solid bg-bg-primary"
    :class="{ 'is-dragging': isDragging }"
    @dragover="handleTabBarFileDragOver"
    @drop="handleTabBarFileDrop"
  >
    <div
      ref="scrollerRef"
      data-testid="document-tab-scroller"
      class="document-tab-bar__scroller min-w-0 flex flex-1 items-center overflow-hidden pl-2 py-1"
    >
      <template v-for="(tab, index) in tabs" :key="tab.sessionId">
        <!-- 独立分隔元素：真实 DOM 节点，数量恒为「标签数 − 1」 -->
        <span
          v-if="index > 0"
          aria-hidden="true"
          data-testid="document-tab-separator"
          class="document-tab-separator mx-1 h-4 w-px shrink-0 self-center bg-border-primary"
        />

        <a-dropdown :trigger="['contextmenu']" placement="bottomLeft">
          <div
            :data-testid="`document-tab-${tab.sessionId}`"
            :data-session-id="tab.sessionId"
            :data-active="isActiveTab(tab) ? 'true' : 'false'"
            :data-pane-focused="isFocusedPane ? 'true' : 'false'"
            :data-dirty="tab.dirty ? 'true' : 'false'"
            :data-file-missing="tab.fileMissing ? 'true' : 'false'"
            :data-external-change="tab.hasPendingExternalChange ? 'true' : 'false'"
            :title="editorPaneDropState.dragging ? undefined : getTabTitle(tab)"
            class="group document-tab electron-no-drag h-6 max-w-60 min-w-6 flex cursor-pointer select-none items-center gap-1 overflow-hidden rounded px-1 text-sm transition-colors"
            :class="getTabClassList(tab)"
            @pointerdown="handleTabPointerDown(tab, $event)"
            @mousedown="handleTabMouseDown"
            @click="handleTabClick(tab)"
            @dblclick.stop="handleTabDblClick(tab)"
            @auxclick="handleTabAuxClick(tab, $event)"
          >
            <!-- 脏点槽：与关闭槽等宽 14px，圆点在槽内居中；干净标签只是不渲染圆点，槽位仍然占位 -->
            <span class="document-tab__dot-slot size-3.5 flex shrink-0 items-center justify-center">
              <span
                v-if="tab.dirty"
                data-testid="document-tab-dirty-dot"
                class="document-tab__dot h-1.5 w-1.5 rounded-full bg-text-secondary"
              />
            </span>
            <span class="document-tab__label min-w-0 flex-1 truncate">{{ getTabLabel(tab) }}</span>
            <button
              type="button"
              :aria-label="t('documentTab.close')"
              data-testid="document-tab-close"
              class="document-tab__close size-3.5 flex shrink-0 cursor-pointer items-center justify-center border-0 rounded bg-transparent p-0 color-text-secondary opacity-0 transition-opacity hover:bg-bg-primary hover:color-text-primary group-hover:opacity-100"
              @click.stop="closeTab(tab)"
            >
              <span class="i-tabler:x text-xs" />
            </button>
          </div>
          <!--
            菜单必须走 overlay 插槽。ant-design-vue 4.x 的 Dropdown 虽然声明了 `menu` prop，
            但 renderOverlay() 只读 props.overlay 与 slots.overlay，传 menu 会静默失效（右键弹不出任何东西）。
          -->
          <template #overlay>
            <a-menu :items="getMenuItems(tab)" @click="info => onMenuClick(info, tab)" />
          </template>
        </a-dropdown>
      </template>

      <!--
        尾部插槽：「+ 新建标签」按钮，必须留在 scroller **内部**、标签之后。

        放在 scroller 外面时，scroller 是 `flex-1` 会吃掉整条剩余宽度，
        插槽被挤到栏的最右端 —— 表现就是「+ 永远贴右边，离最后一个标签很远」。

        放在内部靠两条 CSS 约束得到正确行为：
        · 标签 `flex-1 basis-0` 会争抢可用宽度，但受 `max-w-60`（240px）上限约束 —— 
          标签少时每个标签最多 240px，抢不满整行，按钮就紧跟其后；
        · 标签多时标签被压到 `min-w-6`（24px）下限，把按钮顶到最右，仍不需要滚动。

        按钮自己是 `shrink-0`，任何情况下都不会被挤没。
      -->
      <slot name="after-tabs" />
    </div>
  </div>
</template>

<style scoped lang="scss">
.document-tab {
  /*
   * 宽度策略：按**内容**宽，不参与均分。
   *
   * 原来是 `flex: 1 1 0`（等分剩余宽度）—— 标签少、名字短的时候（比如 `a.md`），
   * 它照样被撑到 210px 左右，名字右边空出一大片，看起来很浪费。
   * 现在改成 `flex: 0 1 auto`：
   *   · 不增长 → 名字多宽标签就多宽；
   *   · 可收缩 → 标签变多时自动压窄，不会撑出栏外（标签栏本身仍然禁止滚动）；
   *   · 上限仍由 `max-w-60`(240px) 卡住，超长名字截断显示。
   */
  flex: 0 1 auto;

  /*
   * 常驻 transform 过渡：拖拽时的让位、以及“顺序没变”时的回弹都靠它。
   * 提交成功后由 JS 临时设 `transition: none` 瞬清，
   * 避免元素从旧位置的让位偏移滑向新位置的自然位置。
   *
   * 这里显式列出 color / background-color，是为了覆盖 UnoCSS 的
   * `transition-colors` 时不把原有的颜色过渡一起丢掉。
   */
  transition:
    transform 140ms cubic-bezier(0.2, 0.7, 0.3, 1),
    color 150ms,
    background-color 150ms;

  /*
   * 文件名警示色：两种“磁盘侧有变化”的状态共用同一个黄色通道，
   * 靠删除线区分「文件已不在盘上」与「磁盘上有新版本待裁决」。
   * 颜色只打在文件名上，关闭按钮与脏点保持中性色，
   * 避免整条标签变成告警条后和激活态、hover 背景互相打架。
   */
  &[data-external-change='true'] .document-tab__label {
    color: var(--wj-markdown-text-warning);
  }

  &[data-file-missing='true'] .document-tab__label {
    color: var(--wj-markdown-text-warning);
    text-decoration: line-through;
  }
}

.document-tab-bar.is-dragging {
  cursor: grabbing;

  .document-tab {
    cursor: grabbing;
    will-change: transform;
  }

  /*
   * 拖拽期间禁用非活动标签的 hover 高亮，避免和让位动画打架。
   * 活动标签保持原有背景，否则用户会以为拖拽把激活态弄丢了。
   */
  .document-tab[data-active='false']:hover {
    background-color: transparent;
  }

  /*
   * 分隔线只是 1px 的视觉元素，让位算法只按标签本身计算。
   * 隐藏但保留占位，松手后主进程重排、DOM 重建时自然恢复。
   */
  .document-tab-separator {
    opacity: 0;
  }

  /* 拖拽中关闭按钮不该看起来可点 */
  .document-tab__close {
    opacity: 0;
  }
}

/*
 * 标签栏不再横向滚动：容器 overflow hidden，标签按 flex 均分宽度，
 * 最窄 24px 后只截断文件名。这套「不要滚动条」的约束下，
 * 原先隐藏原生滚动条 + 自绘 overlay 滑块的样式也一并移除。
 */
</style>
