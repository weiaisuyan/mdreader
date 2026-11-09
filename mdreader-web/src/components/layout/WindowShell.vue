<script setup>
import { computed } from 'vue'
import { useCommonStore } from '@/stores/counter.js'
import {
  RESIZE_DIRECTIONS,
  resolveResizeCursor,
  resolveResizeZoneStyle,
  startWindowResize,
} from '@/util/windowResizeUtil.js'

/**
 * 窗口外壳：只负责「圆角 + 边缘缩放热区」。
 *
 * 为什么需要它：主进程把窗口设成 `transparent: true` 才能用 CSS 画出比系统更圆润的
 * 四角，而透明窗口在 Windows 上会丢掉系统自带的边缘缩放。所以这里补两件事：
 * 1. 给内容套一层圆角容器（最大化时取消圆角，否则四角会露出透明缺口）；
 * 2. 在四条边与四个角铺缩放热区。
 *
 * 内容本身仍是满尺寸：外壳只加圆角裁剪与 pointer 热区，不参与布局计算。
 */
const store = useCommonStore()

// 最大化/全屏时不能有圆角：窗口已经贴满屏幕，圆角会变成四个透明缺口
const isRounded = computed(() => store.isMaximize !== true && store.isFullScreen !== true)

/**
 * 圆角半径（px）。
 *
 * 必须用**内联 px**，不能写在 scss 里：项目接了 px→rem 转换（rootValue 16），
 * 而用户可把根字号调成 15px，12px 会被算成 0.75rem→11.25px，圆角随字号漂移。
 * 内联样式不过转换器，数值永远等于这里写的值。
 */
/**
 * 圆角半径：窗口的那圈弧完全由这里裁出来。
 *
 * 主进程是 `transparent: true` + `roundedCorners: false`，桌面透出，
 * 所以圆角只能靠 CSS 裁。
 *
 * ⚠️ 必须写**显式 px**：内联样式不过 postcss-pxtorem，数值永远等于这里写的值；
 * 用 `border-radius: inherit` 会受根字号影响而漂移。
 */
const CORNER_RADIUS_PX = 0

/**
 * 窗口边框宽度。
 *
 * ⚠️ 这段历史坑很深，按顺序记：
 * 1. 写 `1px`：postcss-pxtorem 配了 `propList: ['*']`，连内联 style 的 px 也会转，
 *    编译后变 `0.0625rem`。
 * 2. 写 `0.0625rem`：用户根字号是 **15px**（不是默认 16px），换算回来只有 0.9375px，
 *    浏览器算出 0.666667px —— 1.5 倍屏上不到 1 物理像素，肉眼完全看不见。
 *
 * 结论：不能按 16px 假设。按实测根字号 15px 反算。
 * 当前 1.5px（0.1rem）：2px 偏粗，1.5px 在 1.5 倍屏上是 2.25 物理像素，
 * 边界清晰但不抢视觉。
 */
const BORDER_WIDTH_REM = '0.1rem'

/**
 * 内容与边框之间的横向留白。
 *
 * 用户反馈「左右两边太贴边了」—— 加了 2.5px 边框后，内容直接顶着边框线。
 * 这里给左右各 6px（0.4rem @ 15px 根字号），让内容与边框之间有呼吸感。
 *
 * ⚠️ 必须加在**内层容器**上，不能加在 .wj-window-shell 上：
 * 边框层和缩放热区都是 `position:absolute; inset:0`，绝对定位相对**padding box** 计算，
 * 给 shell 加 padding 会把边框线一起往里推 6px，边框就不在窗口边缘了。
 *
 * 只加左右不加上下：顶部要留给顶栏拖窗口，底部要留给状态栏贴边。
 */
const CONTENT_PADDING_X_REM = '0.4rem'

const shellStyle = computed(() => ({
  borderRadius: isRounded.value ? `${CORNER_RADIUS_PX}px` : '0px',
}))

const contentStyle = computed(() => ({
  paddingLeft: CONTENT_PADDING_X_REM,
  paddingRight: CONTENT_PADDING_X_REM,
}))

/**
 * 边框层样式。
 *
 * 用绝对定位 div + border 画（不用 outline / box-shadow）：
 * - `outline` 在 overflow:hidden 容器里被裁，实测只剩上/右两边；
 * - `box-shadow: inset` 属于背景层，被顶栏和编辑区整片盖住，四边全无；
 * - 独立的 div 在文档流之上（z-index），四边完整。
 *
 * ⚠️ 圆角必须**显式写同一个 px 值**，不能用 `border-radius: inherit`：
 * 继承来的 16px 会被 postcss-pxtorem 转成 rem 后按 15px 根字号还原成 15px，
 * 与父级 16px 差 1px —— 四角会露出一小截直角（用户反馈的「多出来的直角」就是这个）。
 *
 * 这个 div 是 absolute + inset:0 + pointer-events:none，不占内容宽、不挡点击。
 */
const borderStyle = computed(() => ({
  position: 'absolute',
  inset: '0',
  zIndex: 60,
  pointerEvents: 'none',
  border: `${BORDER_WIDTH_REM} solid var(--wj-window-border)`,
  borderRadius: `${CORNER_RADIUS_PX}px`,
}))

const zoneList = RESIZE_DIRECTIONS.map(direction => ({
  direction,
  style: resolveResizeZoneStyle(direction),
  cursor: resolveResizeCursor(direction),
}))

function handleZonePointerDown(direction, event) {
  startWindowResize(direction, event)
}
</script>

<template>
  <div
    class="wj-window-shell relative h-full w-full overflow-hidden"
    :class="{ 'wj-window-shell--rounded': isRounded }"
    :style="shellStyle"
    data-testid="window-shell"
    :data-rounded="String(isRounded)"
  >
    <div class="wj-window-shell__content" :style="contentStyle">
      <slot />
    </div>

    <!-- 窗口边框：用绝对定位的 div 画，不用 outline/box-shadow/border。
         outline 在 overflow:hidden 容器里会被裁掉一半（实测左右下三边全无）；
         box-shadow inset 会被子元素整片盖住；border 会占内容宽让栅格偏移。
         这个 div 放在最上层、pointer-events:none，四边完整可见且不挡交互。 -->
    <div
      class="wj-window-shell__border"
      :style="borderStyle"
      data-testid="window-shell-border"
      aria-hidden="true"
    />

    <!-- 边缘缩放热区：透明窗口没有系统缩放，只能自己铺 -->
    <div
      v-for="zone in zoneList"
      :key="zone.direction"
      :data-testid="`window-resize-zone-${zone.direction}`"
      class="wj-window-shell__resize-zone"
      :style="{ ...zone.style, cursor: zone.cursor }"
      @pointerdown="handleZonePointerDown(zone.direction, $event)"
    />
  </div>
</template>

<style scoped lang="scss">
.wj-window-shell {
  // 透明窗口下，这层就是「可见的窗口本体」：圆角由它裁，底色由它铺。
  background-color: var(--wj-markdown-bg-primary);
}

// 内容层：承担左右留白（边框层/热区是 absolute，不能加在 shell 上）
.wj-window-shell__content {
  width: 100%;
  height: 100%;
}

// 窗口边框：见 <script> 里的 shellStyle（内联 px，避开 px→rem 转换）。
// 这里不再写 CSS —— 写 1px 会被转成 0.667px，看不见。
//
// 历史坑记录：
// 1. 不能用 .wj-window-shell 上的 box-shadow：inset 阴影属于元素自身背景层，
//    会被后面的子元素整片盖住，实测左右边缘像素 diff = 0。
// 2. 不能用 border：会占掉 1px 内容宽，让栅格整体偏移。
// 3. 必须 outline-offset: -1px：画在外侧那一半会被窗口边界裁掉，只剩顶部一条。
.wj-window-shell--rounded {
  // 实际半径由 JS 以内联 px 写入（避开 px→rem 转换导致随字号漂移），
  // 这里只保留「需要圆角」这个语义类的占位，不写具体数值。
}

.wj-window-shell__resize-zone {
  // 纯热区：不能挡住内容的滚动条交互（只在最外 5px）
  background: transparent;
  -webkit-app-region: no-drag;
}

// 最大化/全屏时热区要收起来：窗口已经贴满屏幕，再留热区会挡住屏幕边缘的
// 任务栏自动隐藏、以及窗口顶部的按钮点击。
.wj-window-shell[data-rounded='false'] .wj-window-shell__resize-zone {
  display: none;
}
</style>
