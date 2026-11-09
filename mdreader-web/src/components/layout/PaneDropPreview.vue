<script setup>
/**
 * 分栏投放预览：半屏覆盖层 + 迷你示意图 + 「松手会发生什么」文案。
 *
 * 为什么单独抽成组件：单栏时 `EditorPaneGrid` 不渲染（继续走 router-view 那条路径，
 * 保住页面缓存语义），但单栏恰恰是最常分栏的场景 —— 两处都得能画，
 * 样式和文案必须完全一致，复制粘贴迟早跑偏。
 *
 * 纯装饰：`pointer-events: none`，不参与命中测试。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  /** 新栏出现在这一侧的哪一边：'left' | 'right' */
  side: {
    type: String,
    default: 'right',
  },
  /** 已达栏数上限时的提示文案里用的上限值 */
  limitCount: {
    type: Number,
    default: 4,
  },
  /** 显示「最多 N 栏」提示而不是半屏预览 */
  limit: {
    type: Boolean,
    default: false,
  },
})

const { t } = useI18n()

/**
 * 迷你示意图两块方块的宽度。
 *
 * 左边那块永远 30px；右边那块在新栏位于右侧时也收窄到 30px ——
 * 两块等宽 = 「一分为二」，用户一眼就能看出新栏占哪一半。
 */
const leftBlockWidth = '30px'
const rightBlockWidth = computed(() => (props.side === 'left' ? '54px' : '30px'))

const label = computed(() => (
  props.side === 'left' ? t('paneDropSplitLeft') : t('paneDropSplitRight')
))
</script>

<template>
  <div
    v-if="limit"
    class="wj-drop-limit pointer-events-none absolute left-1/2 top-1/2 z-40 -translate-x-1/2 -translate-y-1/2 rounded-lg px-3.5 py-1.5 text-xs font-semibold"
    data-testid="editor-pane-drop-limit"
    aria-hidden="true"
  >
    {{ t('paneDropLimit', { count: limitCount }) }}
  </div>

  <div
    v-else
    class="wj-drop-preview pointer-events-none absolute inset-y-0 z-30 flex flex-col items-center justify-center gap-2"
    :data-side="side"
    data-testid="editor-pane-drop-preview"
    aria-hidden="true"
  >
    <div class="wj-drop-preview-mini flex items-center gap-1.5 rounded-lg px-2.5 py-2">
      <span
        class="block h-5 rounded-sm"
        :data-new="side === 'left' ? '1' : '0'"
        :style="{ width: leftBlockWidth }"
      />
      <span
        class="block h-5 rounded-sm"
        :data-new="side === 'right' ? '1' : '0'"
        :style="{ width: rightBlockWidth }"
      />
    </div>
    <span class="wj-drop-preview-label">{{ label }}</span>
  </div>
</template>

<style scoped lang="scss">
/**
 * 预览占目标栏的一半宽度，靠左或靠右 —— 就是新栏将要占的位置。
 *
 * 半屏而不是整块：用户要判断的是「新栏出现在这一栏的哪一侧」，
 * 画满整块看不出方向，等于没提示。
 */
.wj-drop-preview {
  width: 50%;
  background: color-mix(in srgb, var(--wj-primary-color, #1677ff) 10%, transparent);
  outline: 2px dashed var(--wj-primary-color, #1677ff);
  outline-offset: -2px;

  &[data-side='left'] {
    left: 0;
  }

  &[data-side='right'] {
    right: 0;
  }
}

// 迷你示意图：两个方块代表「原来的栏」和「新开的栏」，新的那块高亮
.wj-drop-preview-mini {
  background: var(--wj-surface-raised-color, rgba(20, 20, 24, 0.82));
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);

  span {
    background: var(--wj-border-strong-color, rgba(255, 255, 255, 0.5));
    opacity: 0.45;

    &[data-new='1'] {
      opacity: 1;
      background: var(--wj-primary-color, #1677ff);
    }
  }
}

.wj-drop-preview-label {
  font-size: 11px;
  font-weight: 600;
  padding: 5px 10px;
  border-radius: 999px;
  background: var(--wj-surface-raised-color, rgba(18, 18, 22, 0.92));
  color: var(--wj-text-strong-color, #e8eefc);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
  white-space: nowrap;
}

/**
 * 满栏提示：琥珀色，与「可以分栏」的蓝色预览明确区分开。
 * 出现在边缘带但已经没有空位时，告诉用户上限是多少，而不是画一个分不出来的半屏。
 */
.wj-drop-limit {
  background: color-mix(in srgb, #e0a33e 18%, var(--wj-surface-raised-color, rgba(20, 20, 24, 0.92)));
  color: #f0c674;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
  white-space: nowrap;
}
</style>
