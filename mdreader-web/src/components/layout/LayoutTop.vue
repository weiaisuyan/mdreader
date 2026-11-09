<script setup>
import { message } from 'ant-design-vue'
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import log from '@/assets/img/logo.png'
import { useCommonStore } from '@/stores/counter.js'
import channelUtil from '@/util/channel/channelUtil.js'
import { createLayoutTopOpenFolderAction } from './layoutTopOpenFolderAction.js'
import TopBarActionButton from './TopBarActionButton.vue'

const store = useCommonStore()
const { t } = useI18n()

// 顶部栏视图模式折叠菜单：源码 / 双栏 / 阅读。
// 原先三个模式各占一个按钮，占位太宽；现在收进一个下拉菜单，
// 按钮图标直接反映「当前是哪一种模式」，点开才展开三选一。
const VIEW_MODE_ITEMS = [
  { mode: 'source', icon: 'i-tabler:code', labelKey: 'shortcutKey.viewSource', shortcutKeyId: 'viewSource' },
  { mode: 'split', icon: 'i-tabler:layout-columns', labelKey: 'shortcutKey.viewSplit', shortcutKeyId: 'viewSplit' },
  { mode: 'preview', icon: 'i-tabler:book', labelKey: 'shortcutKey.viewPreview', shortcutKeyId: 'viewPreview' },
]

// 当前模式的图标：store.viewMode 异常时回落到阅读模式（默认模式）
const currentViewModeItem = computed(() => (
  VIEW_MODE_ITEMS.find(item => item.mode === store.viewMode) ?? VIEW_MODE_ITEMS[VIEW_MODE_ITEMS.length - 1]
))

// 从配置中收集已启用且已配置的快捷键，供按钮 tooltip 展示
const shortcutKeyMap = computed(() => {
  const map = {}
  for (const item of store.config.shortcutKeyList ?? []) {
    if (item.enabled === true && item.keymap) {
      map[item.id] = item.keymap
    }
  }
  return map
})

// 侧边栏开关：与 LayoutMenu 中“打开/关闭侧边栏”菜单项共用同一 store 状态
const sidebarVisible = computed(() => store.sidebarVisible === true)
const sidebarToggleLabel = computed(() => t(sidebarVisible.value
  ? 'topMenu.view.children.closeSidebar'
  : 'topMenu.view.children.openSidebar'))

function toggleSidebar() {
  if (typeof store.setSidebarVisible === 'function') {
    store.setSidebarVisible(!sidebarVisible.value)
    return
  }
  store.sidebarVisible = !sidebarVisible.value
}

// 大纲栏开关：与右侧 OutlinePanel 的收起按钮共用同一 store 状态。
// 按钮位置在右侧按钮组里（大纲栏本身也在右边显示）。
const outlineVisible = computed(() => store.outlineVisible === true)
const outlineToggleLabel = computed(() => t(outlineVisible.value
  ? 'topMenu.view.children.closeOutline'
  : 'topMenu.view.children.openOutline'))

function toggleOutline() {
  if (typeof store.setOutlineVisible === 'function') {
    store.setOutlineVisible(!outlineVisible.value)
    return
  }
  store.outlineVisible = !outlineVisible.value
}

function selectViewMode(mode) {
  store.setViewMode(mode)
}

function minimize() {
  channelUtil.send({ event: 'minimize' })
}
function maximize() {
  channelUtil.send({ event: 'maximize' })
}
function restore() {
  channelUtil.send({ event: 'restore' })
}


/**
 * 双击顶栏空白 = 最大化 / 还原。
 *
 * 系统原本会在标题栏处理双击，但窗口用的是 `titleBarStyle: 'hidden'`：
 * 标题栏虽然不可见、框架样式（WS_CAPTION 等）还在，双击却不再落到系统那条通路，
 * 而顶栏是 `app-region: drag` 区域，浏览器又会把双击吞掉 —— 结果就是「双击没反应」。
 * 所以这里自己接一次。
 */
function toggleMaximize() {
  if (isMaximize.value) {
    restore()
    return
  }
  maximize()
}

/**
 * 双击兜底：覆盖所有 `electron-drag` 区域（logo 区、标签条空白、无标签时的整段空白）。
 * 逐个加 @dblclick 容易漏，且挡不住将来新增的拖拽区，所以统一在 window 捕获阶段判定。
 */
function handleWindowDblClick(event) {
  const target = event?.target
  if (!target || typeof target.closest !== 'function') {
    return
  }
  if (!target.closest('.electron-drag') || target.closest('.electron-no-drag')) {
    return
  }
  toggleMaximize()
}

onMounted(() => {
  window.addEventListener('dblclick', handleWindowDblClick, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('dblclick', handleWindowDblClick, true)
})
function close() {
  channelUtil.send({ event: 'close' })
}
const openFolder = createLayoutTopOpenFolderAction({
  sendCommand: payload => channelUtil.send(payload),
  notifyDocumentNotSaved: () => {
    message.warning(t('message.theCurrentFileIsNotSaved'))
  },
})

function openAbout() {
  channelUtil.send({ event: 'open-about' })
}

// 标题栏不再显示文件名：标签栏里的活动标签已经承担了“当前是哪个文档”，
// 标题栏居中区只保留为窗口拖拽热区。
const isMaximize = computed(() => store.isMaximize)
const hasNewVersion = computed(() => store.hasNewVersion)
</script>

<template>
  <div class="electron-drag w-full flex items-center overflow-hidden py-0.5">
    <div class="electron-drag flex items-center pl-2 pr-2">
      <img :src="log" alt="logo" class="h-4 w-4">
    </div>
    <div
      data-testid="layout-top-brand-divider"
      class="h-4 w-px shrink-0"
      style="background-color: var(--wj-markdown-border-primary)"
    />
    <div class="electron-no-drag flex shrink-0 items-center">
      <slot name="menu" />
    </div>
    <div
      data-testid="layout-top-menu-divider"
      class="h-4 w-px shrink-0"
      style="background-color: var(--wj-markdown-border-primary)"
    />
    <!-- 侧栏收起/展开按钮放在「文件 / 帮助」菜单之后（用户要求：放在帮助后面）。
         之前它在品牌竖线与菜单竖线之间，视觉上挤在 logo 旁边。 -->
    <div class="electron-no-drag flex items-center">
      <a-tooltip placement="bottomRight" color="#1677ff">
        <template #title>
          <div v-if="shortcutKeyMap.toggleFileManagerPanel" class="flex gap-2">
            <div>{{ sidebarToggleLabel }}</div>
            <div class="color-[rgb(200,200,200)]">
              {{ shortcutKeyMap.toggleFileManagerPanel }}
            </div>
          </div>
          <span v-else>{{ sidebarToggleLabel }}</span>
        </template>
        <TopBarActionButton
          :icon="sidebarVisible ? 'i-tabler:layout-sidebar-left-collapse' : 'i-tabler:layout-sidebar-left-expand'"
          data-testid="layout-top-toggle-sidebar"
          :data-active="String(sidebarVisible)"
          :aria-pressed="sidebarVisible"
          @click="toggleSidebar"
        />
      </a-tooltip>
    </div>
    <!-- 标签栏与顶栏合并成同一行：中间这段留给各栏的标签条，
         没有标签（设置页等）时退化成可拖动窗口的空白区。 -->
    <div class="min-w-0 flex flex-1 items-center overflow-hidden">
      <slot name="tabs">
        <div class="electron-drag h-full w-full" />
      </slot>
    </div>
    <div class="flex items-center">
      <a-tooltip v-if="hasNewVersion" placement="bottom" color="#1677ff">
        <template #title>
          <span>{{ $t('top.newVersion') }}</span>
        </template>
        <TopBarActionButton
          icon="i-tabler:arrow-bar-up"
          class="bouncing color-red"
          @click="openAbout"
        />
      </a-tooltip>
      <div
        v-if="hasNewVersion"
        data-testid="layout-top-view-group-divider"
        class="h-4 w-px shrink-0"
        style="background-color: var(--wj-markdown-border-primary)"
      />
      <!--
        这里刻意不用 a-tooltip 包裹：点击展开下拉时 tooltip 会浮在菜单正上方，
        把第一项「源码模式」盖住（实测遮挡）。改用原生 title 提示，
        原生提示在按下鼠标时自动消失，不会压住展开的菜单。
      -->
      <a-dropdown placement="bottom" :trigger="['click']" arrow overlay-class-name="wj-view-mode-dropdown">
        <TopBarActionButton
          :icon="currentViewModeItem.icon"
          :title="$t('top.switchView')"
          data-testid="layout-top-view-mode-menu"
          :data-view-mode="store.viewMode"
          :aria-label="$t('top.switchView')"
        />
        <template #overlay>
          <a-menu :selected-keys="[store.viewMode]">
            <a-menu-item
              v-for="item in VIEW_MODE_ITEMS"
              :key="item.mode"
              :data-testid="`layout-top-view-mode-${item.mode}`"
              :data-active="String(store.viewMode === item.mode)"
              :aria-pressed="String(store.viewMode === item.mode)"
              @click="selectViewMode(item.mode)"
            >
              <span class="w-full flex items-center gap-2">
                <!-- 勾选位固定 1em 宽：未选中项也占位，三行文字左对齐不跳动 -->
                <span
                  class="inline-block h-4 w-4 shrink-0"
                  :class="store.viewMode === item.mode ? 'i-tabler:check' : ''"
                />
                <span class="flex-1">{{ $t(item.labelKey) }}</span>
                <span
                  v-if="shortcutKeyMap[item.shortcutKeyId]"
                  class="ml-4 shrink-0 text-xs"
                  style="color: var(--wj-markdown-text-tertiary)"
                >{{ shortcutKeyMap[item.shortcutKeyId] }}</span>
              </span>
            </a-menu-item>
          </a-menu>
        </template>
      </a-dropdown>
      <div
        data-testid="layout-top-view-group-divider"
        class="h-4 w-px shrink-0"
        style="background-color: var(--wj-markdown-border-primary)"
      />
      <a-tooltip placement="bottom" color="#1677ff">
        <template #title>
          <span>{{ $t('top.openInExplorer') }}</span>
        </template>
        <TopBarActionButton icon="i-tabler:folder-open" @click="openFolder" />
      </a-tooltip>
      <!-- 大纲栏开关紧跟在「在文件夹中打开」右边：两个都是「查看类」动作，放一起更顺手 -->
      <a-tooltip placement="bottomRight" color="#1677ff">
        <template #title>
          <div v-if="shortcutKeyMap.toggleOutlinePanel" class="flex gap-2">
            <div>{{ outlineToggleLabel }}</div>
            <div class="color-[rgb(200,200,200)]">
              {{ shortcutKeyMap.toggleOutlinePanel }}
            </div>
          </div>
          <span v-else>{{ outlineToggleLabel }}</span>
        </template>
        <TopBarActionButton
          :icon="outlineVisible ? 'i-tabler:layout-sidebar-right-collapse' : 'i-tabler:layout-sidebar-right-expand'"
          data-testid="layout-top-toggle-outline"
          :data-active="String(outlineVisible)"
          :aria-pressed="outlineVisible"
          @click="toggleOutline"
        />
      </a-tooltip>
      <TopBarActionButton icon="i-tabler:minus" @click="minimize" />
      <TopBarActionButton v-show="!isMaximize" icon="i-tabler:crop-1-1" @click="maximize" />
      <TopBarActionButton v-show="isMaximize" icon="i-tabler:layers-subtract" @click="restore" />
      <TopBarActionButton icon="i-tabler:x" danger @click="close" />
    </div>
  </div>
</template>

<style scoped lang="scss">
@keyframes update-bounce {
  0%,
  100% {
    transform: translateY(0); /* 起始和结束位置 */
  }
  50% {
    transform: translateY(-4px); /* 跳到最高点 */
  }
}
.bouncing {
  animation: update-bounce 1s ease-in-out infinite;
}
</style>
