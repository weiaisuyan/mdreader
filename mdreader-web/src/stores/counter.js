import { message } from 'ant-design-vue'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import i18n from '@/i18n/index.js'
import channelUtil from '@/util/channel/channelUtil.js'
import {
  createDefaultDocumentSessionSnapshot,
  createDefaultExternalFileChangeState,
  deriveDocumentSessionStoreState,
  normalizeRecentList,
} from '@/util/document-session/documentSessionSnapshotUtil.js'
import { normalizePaneLayout } from '@/util/document-session/paneLayoutUtil.js'
import {
  createViewModeBySessionStore,
  isValidViewMode,
  normalizeViewMode,
  pruneViewModeBySession,
  resolveViewModeForSession,
  seedViewModesForTabList,
  setViewModeForSession,
} from '@/util/document-session/viewModeBySessionUtil.js'
import { createSidebarVisibilityPersistenceController } from '@/util/layout/sidebarVisibilityPersistenceController.js'

// 与主进程 documentSessionStore 保持一致的默认标签组 id：
// 单栏窗口的所有标签都挂在 main 上，多栏才会出现 group-2、group-3。
const DEFAULT_GROUP_ID = 'main'

const configData = await channelUtil.send({ event: 'get-config' })
const recentListData = await channelUtil.send({ event: 'recent.get-list' })

const useCommonStore = defineStore('common', () => {
  const documentSessionSnapshot = ref(createDefaultDocumentSessionSnapshot())
  const fileName = ref(documentSessionSnapshot.value.fileName)
  const saved = ref(true)
  const isMaximize = ref(false)
  const isFullScreen = ref(false)
  const config = ref(configData)
  // 侧边栏是否可见：由“默认视图”配置初始化；用户切换后会写回配置（见 setSidebarVisible）
  const sidebarVisible = ref(configData.sidebarDefaultView !== 'close')
  // 侧边栏当前 tab：由“默认视图”配置初始化；可见性变化时连同它一起落盘
  const sidebarActiveTab = ref(configData.sidebarDefaultView === 'outline' ? 'outline' : 'files')
  // 右侧大纲栏是否可见：由配置初始化；用户切换后会写回配置（见 setOutlineVisible）
  const outlineVisible = ref(configData.outlineVisible !== false)

  /**
   * 侧栏可见性的落盘控制器（左侧文件栏 / 右侧大纲栏）。
   *
   * 历史问题：这两个开关原来只改内存 ref、从不写盘，
   * 于是「展开侧边栏 → 关闭窗口 → 重新打开文件」之后又回到配置里的初始值
   * （用户报的“侧边栏展开收起状态没有记忆”）。
   *
   * 这里复用配置 mutation 通道，把「上次状态」记进既有字段，
   * 不新增配置项、不动 schema：
   *   · 左侧文件栏是否可见 → sidebarDefaultView（'close' 表示不可见，'files' 表示可见）
   *   · 右侧大纲栏是否可见 → outlineVisible
   * 这样 sidebarDefaultView 就天然表示「启动时按上次状态恢复」。
   */
  const { t: translateGlobal } = i18n.global
  const reportConfigWriteFailure = messageKey => message.warning(translateGlobal(messageKey))
  const sidebarDefaultViewController = createSidebarVisibilityPersistenceController({
    getPersistedValue: () => config.value?.sidebarDefaultView,
    applyPersistedValue: (value) => {
      config.value.sidebarDefaultView = value
    },
    configPath: ['sidebarDefaultView'],
    normalizeValue: value => (value === 'outline' ? 'outline' : value === 'close' ? 'close' : 'files'),
    showWarningMessage: reportConfigWriteFailure,
  })
  const outlineVisibleController = createSidebarVisibilityPersistenceController({
    getPersistedValue: () => config.value?.outlineVisible !== false,
    applyPersistedValue: (value) => {
      config.value.outlineVisible = value
    },
    configPath: ['outlineVisible'],
    normalizeValue: value => value === true,
    showWarningMessage: reportConfigWriteFailure,
  })
  // 每个标签页各自持有视图模式：source（仅源码）/ split（双栏）/ preview（仅预览）。
  // 未记录的会话一律回落到 startView，所以「新建标签」永远从配置的启动视图开始；
  // 不持久化，重启后所有标签都回到 startView。
  const viewModeBySessionId = ref(createViewModeBySessionStore())
  // 多栏并排的布局（栏数 + 每栏宽度）：由配置初始化，改栏数时写盘。
  const paneLayout = ref(normalizePaneLayout(configData.paneLayout))
  const searchBarVisible = ref(false)
  const editorSearchBarVisible = ref(false)
  const hasNewVersion = ref(false)
  const isAlwaysOnTop = ref(false)
  const recentList = ref(normalizeRecentList(recentListData))
  const externalFileChange = ref(createDefaultExternalFileChangeState())
  // 大纲滚动联动容器（有预览时为预览容器；无预览时为 null，改由 outlineActiveLine 驱动）
  const outlineScrollContainer = shallowRef(null)
  // 无预览时由编辑区滚动驱动的活动行号（有预览时为 null）
  const outlineActiveLine = shallowRef(null)
  // 当前激活页面提供的大纲导航处理器（编辑页据此跳转编辑器行）
  const outlineNavigateHandler = shallowRef(null)

  // 当前活动标签对应的会话 id。activeSessionId 缺失时回退 sessionId，
  // 保证主进程尚未投影窗口标签列表时也能拿到稳定身份。
  const activeSessionId = computed(() => {
    const snapshot = documentSessionSnapshot.value

    return snapshot.activeSessionId ?? snapshot.sessionId ?? null
  })

  /**
   * 当前窗口的标签组列表（多栏并排的真相源视图）。
   *
   * 单栏时主进程刻意不下发 `groups`，这里补一个「虚拟 main 栏」，
   * 让渲染层永远只需处理「一组一栏」的形状，不必到处写 if (多栏)。
   * 虚拟栏直接复用窗口快照本身，所以单栏路径拿到的对象与改造前完全一致。
   */
  const paneGroupList = computed(() => {
    const snapshot = documentSessionSnapshot.value
    const rawGroupList = Array.isArray(snapshot?.groups) ? snapshot.groups : []
    if (rawGroupList.length > 0) {
      return rawGroupList
    }

    return [{
      groupId: DEFAULT_GROUP_ID,
      tabs: Array.isArray(snapshot?.tabs) ? snapshot.tabs : [],
      activeSessionId: snapshot?.activeSessionId ?? snapshot?.sessionId ?? null,
      snapshot: snapshot ?? null,
    }]
  })

  // 焦点栏：主进程下发 activeGroupId 时以它为准，否则只有一个栏。
  const focusedGroupId = computed(() => {
    const snapshot = documentSessionSnapshot.value
    if (typeof snapshot?.activeGroupId === 'string' && snapshot.activeGroupId !== '') {
      return snapshot.activeGroupId
    }

    return paneGroupList.value[0]?.groupId ?? DEFAULT_GROUP_ID
  })

  /**
   * 取某一栏的可渲染数据。
   *
   * 单栏（或传入 null）时返回窗口快照本身：标签栏、编辑器这些组件
   * 在单栏下拿到的仍是原来那一份对象，行为不会因为多栏改造而变化。
   *
   * @param {string | null | undefined} groupId 标签组 id
   * @returns {{ groupId: string, tabs: Array<object>, activeSessionId: string | null, snapshot: object | null }} 该栏的标签、活动会话与完整快照
   */
  function getPaneGroupSnapshot(groupId) {
    const groupList = paneGroupList.value
    if (typeof groupId !== 'string' || groupId === '') {
      return groupList[0]
    }

    return groupList.find(group => group.groupId === groupId) || groupList[0]
  }

  /**
   * 读取当前的 startView 配置。
   * 它只用于给「首次出现的标签」确定初始视图模式，不会实时驱动已有标签，
   * 所以设置页改 startView 只影响之后打开的标签。
   *
   * @returns {string} 返回合法的视图模式。
   */
  function resolveStartViewMode() {
    // 兜底也走「阅读模式」：配置缺失时不该让用户先看到编辑器
    return normalizeViewMode(config.value?.startView, 'preview')
  }

  // 对外仍然是可读写的 viewMode：读取方无需感知“每个标签一份”。
  // 提供 setter，让任何直接赋值也能落到当前标签上。
  const viewMode = computed({
    get: () => resolveViewModeForSession(
      viewModeBySessionId.value,
      activeSessionId.value,
      resolveStartViewMode(),
    ),
    set: mode => setViewMode(mode),
  })

  /**
   * 判断一份窗口快照是不是「彻底空」的占位快照。
   *
   * 真快照里主进程一定会塞至少一个会话（窗口至少有一份草稿），
   * 所以既没有 sessionId、也没有任何标签/标签组时，它只可能是
   * 某条链路临时造出来的默认值，不能拿它覆盖窗外正在使用的状态。
   *
   * @param {object | null | undefined} snapshot 窗口快照
   * @returns {boolean} 是否为空占位快照
   */
  function isEmptyPlaceholderSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      return true
    }
    const hasSessionId = typeof snapshot.sessionId === 'string' && snapshot.sessionId !== ''
    const hasTabs = Array.isArray(snapshot.tabs) && snapshot.tabs.length > 0
    const hasGroups = Array.isArray(snapshot.groups) && snapshot.groups.length > 0
    return !hasSessionId && !hasTabs && !hasGroups
  }

  function applyDocumentSessionSnapshot(snapshot) {
    // 空占位快照不得覆盖已有内容的窗口状态：多栏切换、视图重挂时会留下
    // 在途的 bootstrap 请求，迟到的空结果一旦写入就会让整个界面塌成空白。
    if (isEmptyPlaceholderSnapshot(snapshot) && !isEmptyPlaceholderSnapshot(documentSessionSnapshot.value)) {
      return documentSessionSnapshot.value
    }
    const nextState = deriveDocumentSessionStoreState(snapshot, externalFileChange.value)
    documentSessionSnapshot.value = nextState.documentSessionSnapshot
    fileName.value = nextState.fileName
    saved.value = nextState.saved
    externalFileChange.value = nextState.externalFileChange
    syncViewModeBySession(nextState.documentSessionSnapshot)
    return nextState.documentSessionSnapshot
  }

  /**
   * 按快照同步视图模式记录：
   * 1. 新出现的标签用**当前** startView 固化初始模式（已有记录一律不覆盖）
   * 2. 再清掉已关闭标签的记录
   *
   * @param {object | null | undefined} snapshot
   */
  function syncViewModeBySession(snapshot) {
    const tabList = Array.isArray(snapshot?.tabs) ? snapshot.tabs : []

    viewModeBySessionId.value = seedViewModesForTabList(
      viewModeBySessionId.value,
      tabList,
      resolveStartViewMode(),
    )

    // tabs 为空时（首帧默认快照）不清理，避免把已有记录误清空。
    if (tabList.length === 0) {
      return
    }

    const openSessionIdList = tabList
      .map(tab => tab?.sessionId)
      .filter(sessionId => typeof sessionId === 'string' && sessionId !== '')

    viewModeBySessionId.value = pruneViewModeBySession(
      viewModeBySessionId.value,
      openSessionIdList,
      snapshot?.activeSessionId ?? snapshot?.sessionId ?? null,
    )
  }

  function replaceRecentList(nextRecentList) {
    const normalizedRecentList = normalizeRecentList(nextRecentList)
    recentList.value = normalizedRecentList
    return normalizedRecentList
  }

  function setExternalFileChangeLoading(loading) {
    externalFileChange.value = {
      ...externalFileChange.value,
      loading,
    }
  }

  function setSidebarVisible(visible) {
    const nextVisible = Boolean(visible)
    sidebarVisible.value = nextVisible

    // 可见时记住当前 tab（大纲页签已独立到右侧，这里实际总是 files），
    // 不可见时记 'close'。写盘失败只提示，不改内存状态。
    const nextDefaultView = nextVisible
      ? (sidebarActiveTab.value === 'outline' ? 'outline' : 'files')
      : 'close'
    void sidebarDefaultViewController.persistSidebarVisibility(nextDefaultView)
  }

  function setSidebarActiveTab(tab) {
    sidebarActiveTab.value = tab === 'outline' ? 'outline' : 'files'
    // 侧栏可见时切换 tab：同样落盘，保持“上次状态”一致
    if (sidebarVisible.value === true) {
      void sidebarDefaultViewController.persistSidebarVisibility(sidebarActiveTab.value)
    }
  }

  function setOutlineVisible(visible) {
    const nextVisible = Boolean(visible)
    outlineVisible.value = nextVisible
    void outlineVisibleController.persistSidebarVisibility(nextVisible)
  }

  function setViewMode(mode) {
    if (!isValidViewMode(mode)) {
      return
    }

    const sessionId = activeSessionId.value
    if (!sessionId) {
      // 首帧快照未到时没有可归属的标签，直接忽略，避免把值写到错误的会话上。
      return
    }

    viewModeBySessionId.value = setViewModeForSession(viewModeBySessionId.value, sessionId, mode)
  }

  function setOutlineScrollContainer(element) {
    outlineScrollContainer.value = element ?? null
  }

  /**
   * 更新多栏布局。
   *
   * 只归一不写盘：写盘由调用方按配置变更入口做，
   * 这样布局拖动过程中的高频更新不会把 config.json 写成流水账。
   *
   * @param {object | null | undefined} nextLayout 新的栏数与宽度
   */
  function setPaneLayout(nextLayout) {
    paneLayout.value = normalizePaneLayout(nextLayout)
  }

  function setOutlineActiveLine(lineNumber) {
    outlineActiveLine.value = Number.isFinite(lineNumber) ? lineNumber : null
  }

  function setOutlineNavigateHandler(handler) {
    outlineNavigateHandler.value = typeof handler === 'function' ? handler : null
  }

  return {
    documentSessionSnapshot,
    fileName,
    saved,
    isMaximize,
    isFullScreen,
    config,
    sidebarVisible,
    sidebarActiveTab,
    outlineVisible,
    viewMode,
    paneLayout,
    paneGroupList,
    focusedGroupId,
    getPaneGroupSnapshot,
    searchBarVisible,
    hasNewVersion,
    isAlwaysOnTop,
    recentList,
    editorSearchBarVisible,
    externalFileChange,
    outlineScrollContainer,
    outlineActiveLine,
    outlineNavigateHandler,
    applyDocumentSessionSnapshot,
    replaceRecentList,
    setExternalFileChangeLoading,
    setSidebarVisible,
    setSidebarActiveTab,
    setOutlineVisible,
    setViewMode,
    setOutlineScrollContainer,
    setOutlineActiveLine,
    setOutlineNavigateHandler,
    setPaneLayout,
  }
})

export { useCommonStore }
