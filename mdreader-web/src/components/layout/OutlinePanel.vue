<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import MarkdownMenu from '@/components/editor/MarkdownMenu.vue'
import { useCommonStore } from '@/stores/counter.js'
import { parseOutlineFromMarkdown } from '@/util/editor/outlineParseUtil.js'

/**
 * 右侧大纲栏：与左侧文件栏并列，把标题导航放在编辑区右侧。
 *
 * - 大纲数据直接解析当前文档源文本，不依赖预览组件实例；
 * - 点击大纲后的编辑器跳转通过 store.outlineNavigateHandler 由当前激活页面处理；
 * - 顶部自带收起按钮，收起后可通过顶栏按钮或快捷键重新展开。
 */

const { t } = useI18n()
const store = useCommonStore()

/**
 * 大纲解析是**全文 md.parse**：每敲一个字符都跑一次，长文档下成本很高
 * （预览侧同一份内容还要再 md.render 一次）。
 *
 * 这里对内容做 160ms 防抖：连续输入期间只保留最后一次解析，
 * 停手后立刻刷新。大纲是「扫一眼」用的，160ms 延迟完全无感，
 * 但能把每键一次全文解析降到每次停顿一次。
 */
const OUTLINE_DEBOUNCE_MS = 160
const debouncedContent = ref('')
let outlineTimer = null

watch(
  () => store.documentSessionSnapshot?.content ?? '',
  (content) => {
    // 切换文档时立即生效（避免「切过去大纲还是上一篇的」）
    if (!debouncedContent.value) {
      debouncedContent.value = content
      return
    }
    if (outlineTimer) {
      clearTimeout(outlineTimer)
    }
    outlineTimer = setTimeout(() => {
      outlineTimer = null
      debouncedContent.value = content
    }, OUTLINE_DEBOUNCE_MS)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (outlineTimer) {
    clearTimeout(outlineTimer)
    outlineTimer = null
  }
})

const outlineList = computed(() => parseOutlineFromMarkdown(debouncedContent.value))

function resolveOutlineScrollContainer() {
  return store.outlineScrollContainer ?? null
}

function onAnchorNavigate(payload) {
  store.outlineNavigateHandler?.(payload)
}

function collapse() {
  store.setOutlineVisible(false)
}
</script>

<template>
  <div
    class="outline-panel h-full min-w-0 flex flex-col overflow-hidden bg-bg-primary text-text-primary"
    data-testid="outline-panel"
  >
    <div class="outline-panel__header h-9 flex shrink-0 items-center justify-between gap-1 border-b border-b-border-primary border-b-solid px-2">
      <span class="outline-panel__title min-w-0 truncate text-sm color-text-secondary">{{ t('outline') }}</span>
      <button
        type="button"
        class="outline-panel__collapse h-6 w-6 flex cursor-pointer items-center justify-center rounded border-none bg-transparent color-text-secondary transition-colors hover:bg-[var(--wj-markdown-bg-secondary)]"
        :title="t('topMenu.view.children.closeOutline')"
        data-testid="outline-panel-collapse"
        @click="collapse"
      >
        <div class="i-tabler:chevron-right" />
      </button>
    </div>
    <div class="outline-panel__content relative min-h-0 flex-1 overflow-hidden">
      <MarkdownMenu
        :anchor-list="outlineList"
        :get-container="resolveOutlineScrollContainer"
        :active-line-number="store.outlineActiveLine"
        :show-header="false"
        @anchor-navigate="onAnchorNavigate"
      />
    </div>
  </div>
</template>
