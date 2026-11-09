<script setup>
import { Dropdown as ADropdown, Empty as AEmpty, Input as AInput, Menu as AMenu } from 'ant-design-vue'
import { computed, h, nextTick, ref } from 'vue'
import IconButton from '@/components/editor/IconButton.vue'
import i18n from '@/i18n/index.js'
import { useCommonStore } from '@/stores/counter.js'
import { resolveFileManagerEntryIconProfile } from '@/util/file-manager/fileManagerEntryMetaUtil.js'
import { createFileManagerPanelController } from '@/util/file-manager/fileManagerPanelController.js'
import { endFileDrag, startFileDrag } from '@/util/file-manager/fileDragDropUtil.js'

const store = useCommonStore()
const { t } = i18n.global
const controller = createFileManagerPanelController({
  store,
  t,
})
const {
  breadcrumbList,
  canOpenParentDirectory,
  canFocusCurrentDocumentDirectory,
  emptyMessageKey,
  focusCurrentDocumentDirectory,
  hasDirectory,
  openEntry,
  openParentDirectory,
  pickDirectory,
  requestCreateFolderFromInput,
  requestCreateMarkdownFromInput,
  updateFileManagerSortConfig,
  updateFileManagerVisibleFileMode,
  visibleEntryList,
  visibleFileMode,
} = controller

const searchQuery = ref('')
const panelRootRef = ref(null)
const SCROLL_INTO_VIEW_OPTIONS = Object.freeze({
  behavior: 'smooth',
  block: 'center',
  inline: 'nearest',
})

const filteredEntryList = computed(() => {
  if (!searchQuery.value.trim()) {
    return visibleEntryList.value
  }
  const query = searchQuery.value.toLowerCase()
  return visibleEntryList.value.filter(entry =>
    entry.name.toLowerCase().includes(query),
  )
})

// 显示范围为「仅可打开的文件」时，搜索框文案同步提示过滤范围。
const searchPlaceholder = computed(() => visibleFileMode.value === 'supported'
  ? t('message.fileManagerSearchPlaceholderSupported')
  : t('message.fileManagerSearchPlaceholder'))

/**
 * 文件列表四态判定。
 *
 * 标签栏用「青条 / 灰条 / 无条」区分三种身份，文件列表比它多分一层，
 * 因为「已打开」在文件视角下有两种不同处境：
 *
 * - active ：我正在看的那一个（焦点栏里显示着的）—— 蓝色粗体 + 青色竖条
 * - visible：已经在某个栏里**正显示**着，但那一栏没有焦点
 *            —— 加粗 + 灰色竖条（和标签条上的灰条同义）
 * - open   ：已经打开了，但它所在那一栏当前显示的是**别的标签**
 *            —— 加粗、**没有竖条**（没有栏在显示它，所以不给竖条）
 * - none   ：根本没打开 —— 完全沿用原来的默认样式
 *
 * 判定靠一张「路径 → 状态」表，一次遍历所有栏所有标签得到：
 * - 每栏的 `activeSessionId` 指向的标签 = 该栏正在显示的，记 visible；
 * - 其余标签 = 打开了但没显示，记 open；
 * - 同一路径出现在多个标签时，visible 优先（更强的状态压制弱的）。
 */
function normalizeComparableEntryPath(rawPath) {
  const text = String(rawPath || '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (!text) {
    return ''
  }
  // 只有 Windows 盘符 / UNC 大小写不敏感；POSIX 路径大小写敏感，
  // 无条件 toLowerCase 会把 A.md 和 a.md 压成同一个文件。
  return /^[A-Za-z]:\//.test(text) || text.startsWith('//') ? text.toLowerCase() : text
}

const documentPathStateMap = computed(() => {
  const stateByPath = new Map()
  for (const group of (store.paneGroupList || [])) {
    // 单栏时虚拟 main 栏可能只带 sessionId（counter.js 里做了双回退），这里保持一致
    const activeSessionId = group?.activeSessionId ?? group?.sessionId ?? null
    for (const tab of (group?.tabs || [])) {
      // recent-missing 标签的 displayPath 是「文件曾经在这里」的路径，
      // 不是真的打开着一个文件；原路径后来出现新文件时会被误点亮，跳过。
      if (tab?.isRecentMissing === true) {
        continue
      }
      const key = normalizeComparableEntryPath(tab?.displayPath)
      if (!key) {
        continue
      }
      const isShowing = Boolean(activeSessionId && tab?.sessionId === activeSessionId)
      if (!stateByPath.has(key) || isShowing) {
        stateByPath.set(key, isShowing ? 'visible' : 'open')
      }
    }
  }
  return stateByPath
})

function resolveEntryOpenState(entry) {
  if (entry?.isActive) {
    return 'active'
  }
  const key = normalizeComparableEntryPath(entry?.path)
  if (!key) {
    return 'none'
  }
  return documentPathStateMap.value.get(key) ?? 'none'
}

const createMenuList = computed(() => [
  {
    key: 'create-folder',
    label: t('message.fileManagerCreateFolder'),
    action: requestCreateFolderFromInput,
  },
  {
    key: 'create-markdown',
    label: t('message.fileManagerCreateMarkdown'),
    action: requestCreateMarkdownFromInput,
  },
])

const sortMenuCurrentKey = computed(() => {
  const field = ['name', 'modifiedTime', 'type'].includes(store?.config?.fileManagerSort?.field)
    ? store.config.fileManagerSort.field
    : 'type'
  const direction = ['asc', 'desc'].includes(store?.config?.fileManagerSort?.direction)
    ? store.config.fileManagerSort.direction
    : 'asc'

  return `${field}-${direction}`
})

function createSortMenuLabel(messageKey, key) {
  const label = t(messageKey)
  const indicatorClass = sortMenuCurrentKey.value === key ? 'i-tabler:check mr-1' : 'mr-1 inline-block w-[1em]'

  return h('span', { class: 'inline-flex items-center' }, [
    h('span', { class: indicatorClass }),
    label,
  ])
}

const sortMenuList = computed(() => [
  {
    key: 'type-asc',
    label: createSortMenuLabel('message.fileManagerSortTypeAsc', 'type-asc'),
    action: () => updateFileManagerSortConfig({
      field: 'type',
      direction: 'asc',
    }),
  },
  {
    key: 'type-desc',
    label: createSortMenuLabel('message.fileManagerSortTypeDesc', 'type-desc'),
    action: () => updateFileManagerSortConfig({
      field: 'type',
      direction: 'desc',
    }),
  },
  {
    key: 'name-asc',
    label: createSortMenuLabel('message.fileManagerSortNameAsc', 'name-asc'),
    action: () => updateFileManagerSortConfig({
      field: 'name',
      direction: 'asc',
    }),
  },
  {
    key: 'name-desc',
    label: createSortMenuLabel('message.fileManagerSortNameDesc', 'name-desc'),
    action: () => updateFileManagerSortConfig({
      field: 'name',
      direction: 'desc',
    }),
  },
  {
    key: 'modifiedTime-asc',
    label: createSortMenuLabel('message.fileManagerSortModifiedTimeAsc', 'modifiedTime-asc'),
    action: () => updateFileManagerSortConfig({
      field: 'modifiedTime',
      direction: 'asc',
    }),
  },
  {
    key: 'modifiedTime-desc',
    label: createSortMenuLabel('message.fileManagerSortModifiedTimeDesc', 'modifiedTime-desc'),
    action: () => updateFileManagerSortConfig({
      field: 'modifiedTime',
      direction: 'desc',
    }),
  },
])

function createVisibleFileModeMenuLabel(messageKey, key) {
  const label = t(messageKey)
  const indicatorClass = visibleFileMode.value === key ? 'i-tabler:check mr-1' : 'mr-1 inline-block w-[1em]'

  return h('span', { class: 'inline-flex items-center' }, [
    h('span', { class: indicatorClass }),
    label,
  ])
}

const visibleFileModeMenuList = computed(() => [
  {
    key: 'all',
    label: createVisibleFileModeMenuLabel('message.fileManagerVisibleFileModeAll', 'all'),
    action: () => updateFileManagerVisibleFileMode('all'),
  },
  {
    key: 'supported',
    label: createVisibleFileModeMenuLabel('message.fileManagerVisibleFileModeSupported', 'supported'),
    action: () => updateFileManagerVisibleFileMode('supported'),
  },
])

function resolveEntryIconTestId(entry) {
  return resolveFileManagerEntryIconProfile(entry).testId
}

function resolveEntryIconClass(entry) {
  return resolveFileManagerEntryIconProfile(entry).iconClass
}

function createMarkdownEntryMenuList(entry) {
  if (entry?.kind !== 'markdown') {
    return []
  }

  return [
    {
      key: 'new-tab',
      label: t('message.fileManagerOpenInNewTab'),
      action: () => openEntry(entry, { openMode: 'new-tab' }),
    },
  ]
}

// 单击=在当前标签里打开（旧标签被顶替）；Ctrl/Cmd/Shift/中键=另开一个标签。
// 这是 Obsidian 的手感：默认不堆积标签，想保留当前文档时才加修饰键。
function resolveEntryClickOpenOptions(event) {
  const hasModifier = Boolean(event?.ctrlKey || event?.metaKey || event?.shiftKey)
  return hasModifier ? { openMode: 'new-tab' } : undefined
}

function handleEntryMiddleClick(entry, event) {
  event?.preventDefault?.()
  openEntry(entry, { openMode: 'new-tab' })
}

/**
 * 开始从文件列表拖动一个 markdown 文件。
 *
 * 拖到编辑区/标签区后由目标栏接手打开（见 fileDragDropUtil）；
 * 目录等非 markdown 条目不参与拖拽，避免拖出一个打不开的东西。
 */
function handleMarkdownEntryDragStart(entry, event) {
  if (entry?.kind !== 'markdown') {
    event?.preventDefault?.()
    return
  }
  startFileDrag(entry.path, event)
}

function handleMarkdownEntryDragEnd() {
  endFileDrag()
}

function handleMarkdownEntryMenuClick(entry, menuInfo) {
  const matchedMenu = createMarkdownEntryMenuList(entry)
    .find(item => String(item.key) === String(menuInfo?.key))

  matchedMenu?.action?.()
}

// 公共 IconButton 不处理禁用态时，在当前面板内补充交互限制和视觉弱化。
const disabledToolbarButtonClass = 'pointer-events-none cursor-not-allowed opacity-45'
const resolvedDirectoryPath = computed(() => breadcrumbList.value.length
  ? breadcrumbList.value[breadcrumbList.value.length - 1].path
  : '')

function resolveCurrentEntryElement() {
  return panelRootRef.value?.querySelector('[data-testid="file-manager-entry-current"]') ?? null
}

// 定位按钮的最终交互在组件层完成：目录切换结束后，再按当前渲染结果决定是否清空搜索并滚动。
async function scrollCurrentEntryIntoView() {
  await nextTick()

  let currentEntryElement = resolveCurrentEntryElement()
  if (!currentEntryElement && searchQuery.value.trim()) {
    searchQuery.value = ''
    await nextTick()
    currentEntryElement = resolveCurrentEntryElement()
  }

  currentEntryElement?.scrollIntoView(SCROLL_INTO_VIEW_OPTIONS)
  return currentEntryElement
}

async function handleFocusCurrentDocumentDirectory() {
  const result = await focusCurrentDocumentDirectory()
  if (result?.ok === false) {
    return result
  }

  await scrollCurrentEntryIntoView()
  return result
}
</script>

<template>
  <div ref="panelRootRef" class="file-manager-panel h-full min-w-0 flex flex-col overflow-hidden bg-bg-primary text-text-primary">
    <div class="file-manager-panel__toolbar flex items-center gap-2 border-b border-b-border-primary border-b-solid p-1">
      <div
        data-testid="file-manager-breadcrumb"
        :title="resolvedDirectoryPath || undefined"
        class="file-manager-panel__path min-w-0 flex-1 text-sm color-text-secondary"
      >
        <span v-if="resolvedDirectoryPath" class="file-manager-panel__path-text">
          <span class="file-manager-panel__path-value">{{ resolvedDirectoryPath }}</span>
        </span>
        <span v-else-if="emptyMessageKey" class="block w-full overflow-hidden text-ellipsis whitespace-nowrap">
          <span>{{ t(emptyMessageKey) }}</span>
        </span>
      </div>
      <div class="flex items-center gap-1">
        <IconButton
          data-testid="file-manager-open-parent"
          icon="i-tabler:arrow-up"
          :label="t('message.fileManagerOpenParentDirectory')"
          :action="canOpenParentDirectory ? openParentDirectory : undefined"
          :disabled="!canOpenParentDirectory ? true : undefined"
          :class="!canOpenParentDirectory ? disabledToolbarButtonClass : undefined"
        />
        <IconButton
          data-testid="file-manager-focus-current-file-directory"
          icon="i-tabler:focus-2"
          :label="t('message.fileManagerFocusCurrentFileDirectory')"
          :action="canFocusCurrentDocumentDirectory ? handleFocusCurrentDocumentDirectory : undefined"
          :disabled="!canFocusCurrentDocumentDirectory ? true : undefined"
          :class="!canFocusCurrentDocumentDirectory ? disabledToolbarButtonClass : undefined"
        />
        <IconButton
          data-testid="file-manager-open-directory"
          icon="i-tabler:folder-open"
          :label="t('message.fileManagerSelectDirectory')"
          :action="pickDirectory"
        />
        <IconButton
          data-testid="file-manager-create-entry"
          icon="i-tabler:square-plus"
          :label="t('message.fileManagerCreateEntry')"
          :menu-list="hasDirectory ? createMenuList : []"
          :menu-trigger="['click']"
          :disabled="!hasDirectory ? true : undefined"
          :class="!hasDirectory ? disabledToolbarButtonClass : undefined"
        />
        <IconButton
          data-testid="file-manager-sort-entry"
          icon="i-tabler:arrows-sort"
          :label="t('message.fileManagerSort')"
          :menu-list="sortMenuList"
          :menu-trigger="['hover']"
          :show-tooltip="false"
        />
      </div>
    </div>
    <div v-if="hasDirectory" class="file-manager-panel__search flex items-center gap-1 border-b border-b-border-primary border-b-solid p-1">
      <AInput
        v-model:value="searchQuery"
        allow-clear
        :placeholder="searchPlaceholder"
        class="file-manager-panel__search-input min-w-0 flex-1"
        size="small"
      />
      <IconButton
        data-testid="file-manager-visible-file-mode"
        icon="i-tabler:filter"
        :label="t('message.fileManagerVisibleFileMode')"
        :menu-list="visibleFileModeMenuList"
        :menu-trigger="['hover']"
        :show-tooltip="false"
      />
    </div>
    <div class="h-0 min-h-0 flex-1 overflow-hidden">
      <div
        v-if="!hasDirectory"
        data-testid="file-manager-empty-state"
        class="file-manager-panel__empty h-full flex items-center justify-center px-4"
      >
        <AEmpty :description="null" />
      </div>
      <div
        v-else-if="filteredEntryList.length > 0"
        class="wj-scrollbar file-manager-panel__list h-full min-h-0 overflow-y-auto p-1"
      >
        <template v-for="entry in filteredEntryList" :key="entry.path">
          <ADropdown
            v-if="entry.kind === 'markdown'"
            :trigger="['contextmenu']"
            placement="bottomLeft"
          >
            <button
              :title="entry.name"
              type="button"
              class="file-manager-panel__entry"
              :class="{ 'is-active': entry.isActive }"
              :data-open-state="resolveEntryOpenState(entry)"
              :data-testid="entry.isActive ? 'file-manager-entry-current' : null"
              draggable="true"
              @click="openEntry(entry, resolveEntryClickOpenOptions($event))"
              @auxclick.middle="handleEntryMiddleClick(entry, $event)"
              @dragstart="handleMarkdownEntryDragStart(entry, $event)"
              @dragend="handleMarkdownEntryDragEnd"
            >
              <span
                :data-testid="resolveEntryIconTestId(entry)"
                class="file-manager-panel__entry-icon"
                :class="resolveEntryIconClass(entry)"
              />
              <span
                data-testid="file-manager-entry-name"
                class="file-manager-panel__entry-name truncate"
              >
                {{ entry.name }}
              </span>
            </button>
            <template #overlay>
              <AMenu
                mode="vertical"
                :items="createMarkdownEntryMenuList(entry)"
                @click="menuInfo => handleMarkdownEntryMenuClick(entry, menuInfo)"
              />
            </template>
          </ADropdown>
          <button
            v-else
            :title="entry.name"
            type="button"
            class="file-manager-panel__entry"
            :class="{ 'is-active': entry.isActive }"
            :data-open-state="resolveEntryOpenState(entry)"
            :data-testid="entry.isActive ? 'file-manager-entry-current' : null"
            @click="openEntry(entry, resolveEntryClickOpenOptions($event))"
            @auxclick.middle="handleEntryMiddleClick(entry, $event)"
          >
            <span
              :data-testid="resolveEntryIconTestId(entry)"
              class="file-manager-panel__entry-icon"
              :class="resolveEntryIconClass(entry)"
            />
            <span
              data-testid="file-manager-entry-name"
              class="file-manager-panel__entry-name truncate"
            >
              {{ entry.name }}
            </span>
          </button>
        </template>
      </div>
      <div
        v-else
        data-testid="file-manager-empty-state"
        class="file-manager-panel__empty h-full flex items-center justify-center p-1"
      >
        <AEmpty>
          <template #description>
            <span class="file-manager-panel__empty-description color-gray-500">
              {{ searchQuery ? t('message.fileManagerNoSearchResults') : t(emptyMessageKey) }}
            </span>
          </template>
        </AEmpty>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.file-manager-panel__path-text {
  display: block;
  width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  line-height: 1.5;
  direction: rtl;
  text-align: left;
}

.file-manager-panel__path-value {
  direction: ltr;
  unicode-bidi: bidi-override;
}

.file-manager-panel__entry {
  position: relative;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  padding: 4px 8px 4px 10px;
  text-align: left;
  color: inherit;
  font-size: 13px;
  cursor: pointer;

  // 三态竖条：和标签条下方那条横条同义 —— 青色=正在看，灰色=已打开但没显示，没有=没打开。
  // 只占 2px，不挤占文字，也不改行高，列表密度不变。
  &::before {
    content: '';
    position: absolute;
    left: 2px;
    top: 50%;
    width: 2px;
    height: 0;
    border-radius: 1px;
    background: transparent;
    transform: translateY(-50%);
    transition: height 0.16s ease, background-color 0.16s ease;
  }

  &:hover {
    background: var(--wj-markdown-bg-secondary);
    color: var(--wj-markdown-text-primary);
  }

  // 3) 根本没打开：**完全不动**，保持原来的默认观感（继承父级颜色）。
  //    用户要求「没打开的状态就对应现在未激活的样式」，所以这里不写任何规则。

  // 2) 已在别的栏里**正显示**着，但那一栏没有焦点：加粗 + 灰色竖条。
  //    竖条和标签条上的灰条同义 —— 「这个正在某个栏里显示，只是不在焦点上」。
  &[data-open-state='visible'] {
    color: #d7d7d7;
    font-weight: 600;

    &::before {
      height: 12px;
      background: rgba(190, 190, 190, 0.55);
    }
  }

  // 1.5) 已打开，但它所在那一栏当前显示的是**别的标签**：只加粗，不给竖条。
  //      没有栏在显示它，所以不给任何"正在显示"的标记，靠字重和「没打开」区分。
  &[data-open-state='open'] {
    color: #d7d7d7;
    font-weight: 600;
  }

  // 当前文件继续仅用文字高亮，但切到项目内统一使用的蓝色主视觉。
  &.is-active {
    color: #1677ff;
    font-weight: 600;

    &::before {
      height: 15px;
      background: #0fb6d6;
    }
  }
}

.file-manager-panel__entry-icon {
  flex: 0 0 auto;
  font-size: 15px;
  line-height: 1;
}

.file-manager-panel__entry-name {
  min-width: 0;
  flex: 1 1 auto;
  line-height: 20px;
}
</style>
