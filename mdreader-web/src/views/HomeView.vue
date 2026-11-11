<script setup>
import { message } from 'ant-design-vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import ExternalFileChangeModal from '@/components/ExternalFileChangeModal.vue'
import EditorTabStrip from '@/components/layout/EditorTabStrip.vue'
import EditorWorkspace from '@/components/layout/EditorWorkspace.vue'
import {
  clampFileManagerPanelWidth,
  createHomeViewFilePanelLayoutController,
  FILE_MANAGER_PANEL_DEFAULT_WIDTH,
} from '@/components/layout/homeViewFilePanelLayoutUtil.js'
import {
  clampOutlinePanelWidth,
  createHomeViewOutlinePanelLayoutController,
  fitSidePanelWidthsToAvailable,
  OUTLINE_PANEL_DEFAULT_WIDTH,
  resolveHomeViewGridTemplateColumns,
  resolveOutlineGutterTrack,
} from '@/components/layout/homeViewOutlinePanelLayoutUtil.js'
import LayoutMenu from '@/components/layout/LayoutMenu.vue'
import LayoutTop from '@/components/layout/LayoutTop.vue'
import OutlinePanel from '@/components/layout/OutlinePanel.vue'
import SidebarPanel from '@/components/layout/SidebarPanel.vue'
import { useCommonStore } from '@/stores/counter.js'
import channelUtil from '@/util/channel/channelUtil.js'
import { sendConfigMutationRequest } from '@/util/config/configMutationCommandUtil.js'
import { getConfigUpdateFailureMessageKey } from '@/util/config/configUpdateResultUtil.js'
import { registerCurrentWindowOpenPreparation } from '@/util/document-session/currentWindowOpenPreparationService.js'
import { openDroppedMarkdownDocumentInPane } from '@/util/document-session/documentDropOpenInPaneUtil.js'
import {
  createDocumentOpenInteractionService,
  registerDocumentOpenInteractionService,
} from '@/util/document-session/documentOpenInteractionService.js'
import { resolveMinContentWidth } from '@/util/document-session/paneLayoutUtil.js'
import { requestDocumentOpenDialog } from '@/util/document-session/rendererDocumentCommandUtil.js'
import { createFileManagerOpenDecisionController } from '@/util/file-manager/fileManagerOpenDecisionController.js'
import { createFileManagerPanelWidthPersistenceController } from '@/util/file-manager/fileManagerPanelWidthPersistenceController.js'
import shortcutKeyUtil from '@/util/shortcutKeyUtil.js'

const functionShortcutKeyPattern = /^F(?:[1-9]|1[0-2])$/
const { t } = useI18n()
const store = useCommonStore()
const route = useRoute()
const fileManagerHostRef = ref()
const fileManagerGutterRef = ref()
const outlineGutterRef = ref()
const fileManagerPanelWidth = ref(clampFileManagerPanelWidth(store.config.sidebarWidth ?? FILE_MANAGER_PANEL_DEFAULT_WIDTH))
const outlinePanelWidth = ref(clampOutlinePanelWidth(store.config.outlineWidth ?? OUTLINE_PANEL_DEFAULT_WIDTH))
const fileManagerPanelWidthPersistenceController = createFileManagerPanelWidthPersistenceController({
  sendConfigMutationRequest,
  getConfigUpdateFailureMessageKey,
  getPersistedWidth: () => store.config.sidebarWidth,
  showWarningMessage: messageKey => message.warning(t(messageKey)),
  applyPersistedWidth: (width) => {
    store.config.sidebarWidth = width
  },
})
const outlinePanelWidthPersistenceController = createFileManagerPanelWidthPersistenceController({
  sendConfigMutationRequest,
  getConfigUpdateFailureMessageKey,
  getPersistedWidth: () => store.config.outlineWidth,
  showWarningMessage: messageKey => message.warning(t(messageKey)),
  applyPersistedWidth: (width) => {
    store.config.outlineWidth = width
  },
  configPath: ['outlineWidth'],
  clampWidth: clampOutlinePanelWidth,
})
const documentOpenInteractionService = createDocumentOpenInteractionService({
  requestDocumentOpenDialog,
})
const fileManagerOpenDecisionController = createFileManagerOpenDecisionController({
  t,
})
const shouldShowFileManagerShell = computed(() => String(route.name ?? '') === 'editor')
const shouldEnableFileManagerSplit = computed(() => shouldShowFileManagerShell.value && Boolean(store.sidebarVisible))
const shouldEnableOutlineSplit = computed(() => shouldShowFileManagerShell.value && Boolean(store.outlineVisible))

// 三栏宽度只做范围钳制，**不再按容器宽度做 JS 收窄** ——
// 收窄交给 CSS `minmax(160px, Nfr)`：浏览器原生实现「未触底前同比例缩、
// 触底后钉住其余继续缩」，比每帧算像素平滑得多。
// 也不写回 config：否则拖窄一次窗口就把用户拖好的宽度覆盖了。
/**
 * 编辑区在列模板里的 fr 权重（实测像素）。
 *
 * 拖动侧栏/大纲栏结束时更新为当时编辑区的真实宽度，
 * 让三栏权重之和等于容器实际像素 —— 这样松手后不会因为比例换算被拉回去。
 * 窗口缩放时**不更新**，保持比例不变、三栏一起缩。
 */
const editorLayoutWeight = ref(0)

/**
 * 宿主容器当前宽度：把「目标像素」反算成 fr 权重时要用。
 *
 * fr 是权重不是像素（容器 1919、权重 [420,1400] 时 420fr 渲染成 442.8px），
 * 所以必须知道容器宽度才能精确反算，否则拖完侧栏会被比例放大。
 */
const hostContainerWidth = ref(0)

/**
 * 读完三个栏的当前宽度，把编辑区宽度记进权重。
 */
function syncEditorLayoutWeight() {
  const element = fileManagerHostRef.value
  if (!element) {
    return
  }
  const hostWidth = Math.round(element.getBoundingClientRect().width ?? 0)
  if (hostWidth > 0) {
    hostContainerWidth.value = hostWidth
  }
  const editorElement = element.querySelector('[data-testid=editor-column]')
  const width = Math.round(editorElement?.getBoundingClientRect().width ?? 0)
  if (width > 0) {
    editorLayoutWeight.value = width
  }
}

const fittedSidePanelWidths = computed(() => fitSidePanelWidthsToAvailable({
  sidebarVisible: Boolean(store.sidebarVisible),
  sidebarWidth: fileManagerPanelWidth.value,
  outlineVisible: Boolean(store.outlineVisible),
  outlineWidth: outlinePanelWidth.value,
}))
const homeViewFileManagerHostStyle = computed(() => {
  if (shouldShowFileManagerShell.value === false) {
    return undefined
  }

  return {
    // 侧栏与大纲栏各自显隐；两侧都关闭时宿主退化为单列，避免残留手柄空槽。
    gridTemplateColumns: resolveHomeViewGridTemplateColumns({
      sidebarVisible: Boolean(store.sidebarVisible),
      sidebarWidth: fittedSidePanelWidths.value.sidebarWidth,
      outlineVisible: Boolean(store.outlineVisible),
      outlineWidth: fittedSidePanelWidths.value.outlineWidth,
      editorWidth: editorLayoutWeight.value > 0 ? editorLayoutWeight.value : null,
      containerWidth: hostContainerWidth.value > 0 ? hostContainerWidth.value : null,
    }),
  }
})
const homeViewFilePanelLayoutController = createHomeViewFilePanelLayoutController({
  hostRef: fileManagerHostRef,
  gutterRef: fileManagerGutterRef,
  panelWidthRef: fileManagerPanelWidth,
  nextTick,
  onPanelWidthCommit: (width) => {
    // 松手瞬间先记下编辑区实测宽度：权重按实际像素算，松手后不会被比例拉回
    syncEditorLayoutWeight()
    return fileManagerPanelWidthPersistenceController.persistFileManagerPanelWidth(width)
  },
  // 列定义由左右两侧共同决定，不能再用只描述左侧的默认实现。
  // 宽度取「收窄后」的值：窗口很窄时渲染出来的列本来就比 config 里的小，
  // 若用未收窄的值当基准，一拖动就会跳变。
  resolveGridTemplateColumns: width => resolveHomeViewGridTemplateColumns({
    sidebarVisible: Boolean(store.sidebarVisible),
    sidebarWidth: width,
    outlineVisible: Boolean(store.outlineVisible),
    outlineWidth: fittedSidePanelWidths.value.outlineWidth,
    editorWidth: editorLayoutWeight.value > 0 ? editorLayoutWeight.value : null,
    containerWidth: hostContainerWidth.value > 0 ? hostContainerWidth.value : null,
  }),
})
const homeViewOutlinePanelLayoutController = createHomeViewOutlinePanelLayoutController({
  hostRef: fileManagerHostRef,
  gutterRef: outlineGutterRef,
  panelWidthRef: outlinePanelWidth,
  nextTick,
  onPanelWidthCommit: (width) => {
    syncEditorLayoutWeight()
    return outlinePanelWidthPersistenceController.persistFileManagerPanelWidth(width)
  },
  resolveGridTemplateColumns: width => resolveHomeViewGridTemplateColumns({
    sidebarVisible: Boolean(store.sidebarVisible),
    sidebarWidth: fittedSidePanelWidths.value.sidebarWidth,
    outlineVisible: Boolean(store.outlineVisible),
    outlineWidth: width,
    editorWidth: editorLayoutWeight.value > 0 ? editorLayoutWeight.value : null,
    containerWidth: hostContainerWidth.value > 0 ? hostContainerWidth.value : null,
  }),
  // 左侧栏显隐会改变大纲分隔条所在的轨道下标
  resolveGutterTrack: () => resolveOutlineGutterTrack(Boolean(store.sidebarVisible)),
})
const unregisterCurrentWindowOpenPreparation = registerCurrentWindowOpenPreparation(async ({ provider }) => {
  if (typeof provider !== 'function') {
    return {
      ok: false,
      reason: 'preparation-unavailable',
    }
  }

  return await provider()
})
const unregisterDocumentOpenInteractionService = registerDocumentOpenInteractionService(documentOpenInteractionService)
const unregisterDocumentOpenHandler = documentOpenInteractionService.setOpenHandler(async ({ path, ...options }) => await fileManagerOpenDecisionController.openDocument(path, options))

function findShortcutKeyId(keymap) {
  const shortcutKeyList = store.config.shortcutKeyList
  for (let i = 0; i < shortcutKeyList.length; i++) {
    const item = shortcutKeyList[i]
    if (item.keymap === keymap && item.enabled === true && item.type === 'web') {
      return item.id
    }
  }
  return null
}

function onKeydown(e) {
  if (shortcutKeyUtil.isShortcutKey(e)) {
    const shortcutKey = shortcutKeyUtil.getShortcutKey(e)
    // 裸 F1-F12 需要先拦截宿主默认行为，避免触发浏览器刷新等内建动作。
    if (functionShortcutKeyPattern.test(shortcutKey)) {
      e.preventDefault()
    }
    const shortcutKeyId = findShortcutKeyId(shortcutKey)
    if (shortcutKeyId) {
      shortcutKeyUtil.getWebShortcutKeyHandler(shortcutKeyId, true)
    }
  }
}

function isFileDragEvent(event) {
  return event.dataTransfer?.types?.includes('Files') === true
}

function onWindowDragOver(event) {
  if (isFileDragEvent(event) !== true) {
    return
  }
  // 编辑器以外的窗口区域原本不接受文件落下，这里统一放开；
  // 真正的打开/拦截动作在 drop 阶段裁决。
  event.preventDefault()
}

async function onWindowDrop(event) {
  if (isFileDragEvent(event) !== true) {
    return
  }
  // 编辑器等内部区域已经处理过的拖拽（defaultPrevented）不重复接管，
  // 避免同一次拖拽被打开两次。
  if (event.defaultPrevented === true) {
    return
  }
  // 统一拦截文件拖拽，避免 Chromium 回退到 file:// 导航。
  event.preventDefault()
  // 聚焦栏只剩一个空白标签时直接顶替它（用户开软件后拖文件进来的直觉行为）；
  // 该标签已被编辑过（dirty）则照常开新标签，不会覆盖用户正在写的内容。
  await openDroppedMarkdownDocumentInPane(event.dataTransfer.files, { store })
}

/**
 * 把「内容区最小宽度」同步给主进程。
 *
 * 窗口能做多小不能写死：单栏 + 双侧栏只要 482px、双栏 646px、四栏 974px。
 * 写死 800 时二栏布局缩到 800 就停，左栏还剩 300 多像素没缩到底
 * —— 用户实测：「缩到最小宽度之后还能再缩吗？缩不了了」。
 */
function syncMinContentWidth() {
  const width = resolveMinContentWidth({
    sidebarVisible: Boolean(store.sidebarVisible),
    outlineVisible: Boolean(store.outlineVisible),
    paneCount: store.paneGroupList?.length || 1,
  })
  channelUtil.send({ event: 'set-min-content-width', data: width }).catch(() => {})
}

watch(
  [() => store.sidebarVisible, () => store.outlineVisible, () => (store.paneGroupList?.length || 1)],
  () => { syncMinContentWidth() },
  { immediate: true },
)

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('dragover', onWindowDragOver)
  window.addEventListener('drop', onWindowDrop)
  // 首屏必须同步一次：编辑区权重为 0 时会退回固定参考值 1400，
  // 三栏比例失真（实测侧栏配置 280 却渲染成 443，超过上限后直接拖不动）。
  syncEditorLayoutWeight()
  syncMinContentWidth()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('dragover', onWindowDragOver)
  window.removeEventListener('drop', onWindowDrop)
  unregisterCurrentWindowOpenPreparation()
  unregisterDocumentOpenInteractionService()
  unregisterDocumentOpenHandler()
  documentOpenInteractionService.invalidateActiveRequest()
  homeViewFilePanelLayoutController.destroySplitLayout()
  homeViewOutlinePanelLayoutController.destroySplitLayout()
})

// 左右两侧的显隐、以及左侧显隐导致的大纲分隔条轨道下标变化，都要重建 split-grid
watch([
  shouldEnableFileManagerSplit,
  shouldEnableOutlineSplit,
  () => Boolean(store.sidebarVisible),
], async () => {
  await homeViewFilePanelLayoutController.rebuildSplitLayout(shouldEnableFileManagerSplit.value)
  await homeViewOutlinePanelLayoutController.rebuildSplitLayout(shouldEnableOutlineSplit.value)
}, { immediate: true })

watch(() => store.documentSessionSnapshot?.sessionId ?? null, () => {
  documentOpenInteractionService.invalidateActiveRequest()
})

watch(() => route.name, () => {
  documentOpenInteractionService.invalidateActiveRequest()
})
</script>

<template>
  <div class="h-full w-full flex flex-col overflow-hidden bg-bg-primary text-text-primary">
    <LayoutTop>
      <template #menu>
        <LayoutMenu />
      </template>
      <template #tabs>
        <EditorTabStrip />
      </template>
    </LayoutTop>
    <div class="h-0 flex-1 overflow-hidden">
      <div
        v-if="shouldShowFileManagerShell"
        ref="fileManagerHostRef"
        data-testid="home-file-manager-host"
        class="grid h-full overflow-hidden"
        :style="homeViewFileManagerHostStyle"
      >
        <div
          v-if="store.sidebarVisible"
          data-testid="home-file-manager-panel-slot"
          class="h-full min-w-0 overflow-hidden b-t-1 b-t-border-primary b-t-solid"
        >
          <SidebarPanel />
        </div>
        <div
          v-if="store.sidebarVisible"
          ref="fileManagerGutterRef"
          data-testid="home-file-manager-gutter"
          class="wj-sash wj-sash--vertical h-full"
        />
        <div data-testid="editor-column" class="h-full min-w-0 flex flex-col overflow-hidden">
          <EditorWorkspace />
        </div>
        <div
          v-if="store.outlineVisible"
          ref="outlineGutterRef"
          data-testid="home-outline-gutter"
          class="wj-sash wj-sash--vertical h-full"
        />
        <div
          v-if="store.outlineVisible"
          data-testid="home-outline-panel-slot"
          class="h-full min-w-0 overflow-hidden b-t-1 b-t-border-primary b-t-solid"
        >
          <OutlinePanel />
        </div>
      </div>
      <div v-else data-testid="editor-column" class="h-full min-w-0 flex flex-col overflow-hidden">
        <EditorWorkspace />
      </div>
    </div>
    <ExternalFileChangeModal />
  </div>
</template>

<style scoped lang="scss">
</style>
