<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useCommonStore } from '@/stores/counter.js'
import { createSetConfigPathRequest, sendConfigMutationRequest } from '@/util/config/configMutationCommandUtil.js'
import { setFocusedPreparationProviderKey } from '@/util/document-session/currentWindowOpenPreparationService.js'
import { MAX_PANE_COUNT, MIN_PANE_WIDTH, PANE_GUTTER_WIDTH, resolvePaneGridTemplateColumns } from '@/util/document-session/paneLayoutUtil.js'
import { editorPaneDropState } from '@/util/document-session/editorPaneDropState.js'
import PaneDropPreview from '@/components/layout/PaneDropPreview.vue'
import { requestDocumentActivateGroup } from '@/util/document-session/rendererDocumentCommandUtil.js'
import { createTabInCurrentWindow } from '@/util/document-session/rendererTabCommandService.js'
import EditorView from '@/views/EditorView.vue'

// 栏与栏之间的分隔条宽度由 paneLayoutUtil 统一给出：
// 顶栏标签条里的 gutter 用同一个常量，上下才能连成一条线。

const store = useCommonStore()
const { t } = useI18n()

// 渲染哪几栏完全由主进程快照决定：
// store.paneGroupList 在单栏时是“窗口快照的虚拟栏”，多栏时就是真实标签组。
const panes = computed(() => store.paneGroupList)
const focusedGroupId = computed(() => store.focusedGroupId)

const paneGridRef = ref(null)

/** 栏数上限，模板里给「最多 N 栏」提示用 */
const maxPaneCount = MAX_PANE_COUNT

/**
 * 取某一栏当前的投放预览。
 *
 * 预览只画在**指针所在的那一栏**里：`hover.paneId` 对不上就返回 null，
 * 其它栏不显示任何东西。这样「松手会插在哪一侧」不会看错栏。
 *
 * @param {string} groupId 栏 id
 * @returns {{paneId: (string|null), side: ('left'|'right'|null), kind: string} | null} 预览状态
 */
function resolvePaneHover(groupId) {
  const hover = editorPaneDropState.hover
  if (!hover || hover.paneId !== groupId) {
    return null
  }
  return hover
}

/**
 * 把「部分栏有宽度、部分栏是 null」的混合存档规范化。
 *
 * 混合状态在 `minmax(160px, 权重fr)` 下必然失衡：null 变成 1fr，
 * 与其它栏的像素权重（几百）量纲差几百倍 —— 实测 [283, null] 渲染成
 * `283fr : 1fr`，左栏吃掉 1592px、右栏挤在最小 160px，
 * 看上去就是「左栏不缩、只有右栏在动」。
 *
 * 处理方式：**全部转成 null（均分）**。不能拿当前渲染宽度去补 ——
 * 那些宽度本身就是被错误权重算出来的，写回去等于把错误固化。
 */
function normalizeMixedPaneWidths() {
  const widthList = Array.isArray(store.paneLayout?.widths) ? store.paneLayout.widths : []
  if (widthList.length < 2) {
    return
  }
  const hasFinite = widthList.some(width => Number.isFinite(width))
  const hasNull = widthList.some(width => !Number.isFinite(width))
  if (!hasFinite || !hasNull) {
    return
  }

  store.setPaneLayout({
    count: panes.value.length,
    widths: new Array(panes.value.length).fill(null),
  })
}

watch(paneGridRef, (element) => {
  if (element) {
    nextTick(normalizeMixedPaneWidths)
  }
}, { immediate: true, flush: 'post' })

watch(() => panes.value.length, () => {
  nextTick(normalizeMixedPaneWidths)
})

onBeforeUnmount(() => {
  if (typeof activeResizeCleanup === 'function') {
    activeResizeCleanup()
  }
})

/**
 * 列模板完全交给 CSS。
 *
 * 没有任何 JS 宽度计算、没有 ResizeObserver、没有基准宽度：
 * `minmax(160px, Nfr)` 原生就实现「未触底前按比例同缩、触底后钉住其余继续缩」，
 * 且窗口缩放走浏览器渲染管线，平滑无跳变。
 */
const gridTemplateColumns = computed(() => resolvePaneGridTemplateColumns(
  { count: panes.value.length, widths: store.paneLayout.widths },
  PANE_GUTTER_WIDTH,
  // 列数必须跟实际渲染的栏数一致：真实栏数一旦超过配置上限，
  // 归一化会把列数夹回上限，导致多出来的栏被挤到下一行。
  panes.value.length,
))

// 拖动分隔条期间的容器宽度缓存，用来把鼠标位移换算成左栏宽度。
// 当前这次拖拽的收尾函数：下一次按下时先调用它，防止旧监听器叠加生效。
let activeResizeCleanup = null

/**
 * 把栏布局归成可比较的字符串，用来判断「这次拖动到底有没有改变宽度」。
 *
 * @param {object | null | undefined} layout 栏布局
 * @returns {string} 可比较的序列化结果
 */
function resolveComparablePaneLayout(layout) {
  const widthList = Array.isArray(layout?.widths) ? layout.widths : []
  return JSON.stringify({
    count: Number.isInteger(layout?.count) ? layout.count : 1,
    widths: widthList.map(width => (Number.isFinite(width) ? Math.round(width) : null)),
  })
}

/**
 * 把栏布局写回 config.json。
 *
 * 拖动过程中只改内存（否则每帧写一次配置会把 config.json 写成流水账），
 * 松手时再落一次盘；值没变则直接跳过。
 *
 * @param {object} layout 归一后的栏布局
 * @returns {Promise<void>} 写盘结束
 */
async function persistPaneLayout(layout) {
  if (resolveComparablePaneLayout(layout) === resolveComparablePaneLayout(store.config?.paneLayout)) {
    return
  }
  try {
    // 必须送纯对象：直接传 store.paneLayout 是 Vue 响应式代理，
    // 过 IPC 的结构化克隆会抛 "An object could not be cloned."，写盘静默失败。
    const payload = {
      count: layout.count,
      widths: Array.isArray(layout.widths)
        ? layout.widths.map(width => (Number.isFinite(width) ? Math.round(width) : null))
        : [],
    }
    await sendConfigMutationRequest(createSetConfigPathRequest(['paneLayout'], payload))
  } catch {
    // 写盘失败只影响「下次启动的栏宽记忆」，不能打断当前编辑。
  }
}

/**
 * 把焦点交给某一栏。
 *
 * 文件树、标题、目录监听都跟随窗口级活动会话，
 * 所以用户点了哪一栏，必须让主进程把该栏的活动标签顶成窗口级活动会话。
 *
 * @param {string} groupId 标签组 id
 */
function focusPane(groupId) {
  if (typeof groupId !== 'string' || groupId === '') {
    return
  }
  setFocusedPreparationProviderKey(groupId)
  if (groupId === focusedGroupId.value) {
    return
  }
  requestDocumentActivateGroup(groupId)
}

/**
 * 在指定的空栏里新建一个标签。
 *
 * 先把焦点交给这一栏，再复用标签栏「双击空白新建」的同一条命令，
 * 保证新建出来的标签一定落在这栏，而不是跑到隔壁。
 *
 * @param {string} groupId 标签组 id
 * @returns {Promise<void>} 命令发送结束
 */
async function createTabInPane(groupId) {
  focusPane(groupId)
  await createTabInCurrentWindow()
}

/**
 * 开始拖动某一栏右侧的分隔条。
 *
 * @param {number} index 分隔条左侧那一栏的下标
 * @param {PointerEvent} event 指针事件
 */
function handleGutterPointerDown(index, event) {
  if (event.button !== 0) {
    return
  }

  const gridElement = paneGridRef.value
  if (!gridElement) {
    return
  }

  // 上一次拖拽如果没收到 pointerup（在窗口外松手、事件被吞），监听器会一直留在 window 上。
  // 之后再拖，那些旧监听器会因为「鼠标 pointerId 都是 1」而全部继续生效，
  // 表现为「拖 1px 动 N px」、一拖就冲到最左/最右（用户报的「左右不是一半一半、左栏更大」）。
  // 所以每次按下都先把上一轮清干净，并且用本次拖拽自己的 pointerId 做判定。
  if (typeof activeResizeCleanup === 'function') {
    activeResizeCleanup()
  }

  event.preventDefault()
  const dragPointerId = event.pointerId
  const paneElementList = gridElement.querySelectorAll('[data-pane-id]')
  const startWidth = paneElementList[index]?.getBoundingClientRect().width ?? 0
  const startX = event.clientX
  const totalWidth = gridElement.getBoundingClientRect().width

  function cleanupResizeListeners() {
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', handlePointerUp)
    window.removeEventListener('pointercancel', handlePointerUp)
    window.removeEventListener('blur', handlePointerUp)
    if (activeResizeCleanup === cleanupResizeListeners) {
      activeResizeCleanup = null
    }
  }

  function handlePointerMove(moveEvent) {
    if (moveEvent.pointerId !== dragPointerId) {
      return
    }
    const nextWidth = startWidth + (moveEvent.clientX - startX)
    // 两栏都要留住最小可用宽度：右栏至少 MIN_PANE_WIDTH，左侧同理。
    const maxWidth = Math.max(MIN_PANE_WIDTH, totalWidth - PANE_GUTTER_WIDTH - MIN_PANE_WIDTH)
    const clampedWidth = Math.min(Math.max(nextWidth, MIN_PANE_WIDTH), maxWidth)

    // 拖动期间把**所有栏的实际像素宽度**写进 store（一个都不留 null）。
    //
    // 为什么不能留 null：列模板是 `minmax(160px, 权重fr)`，null 会变成 1fr，
    // 与其它栏的「像素权重」量纲差了几百倍 —— 实测 [1438, null] 被渲染成
    // 1438fr : 1fr，右栏永远挤在 160px，看起来就是「左栏不缩、只有右栏在动」。
    const actualWidths = Array.from(paneElementList).map(
      element => Math.round(element.getBoundingClientRect().width),
    )
    actualWidths[index] = Math.round(clampedWidth)
    store.setPaneLayout({ count: panes.value.length, widths: actualWidths })
  }

  function handlePointerUp(upEvent) {
    if (upEvent.pointerId !== dragPointerId) {
      return
    }
    cleanupResizeListeners()

    // 松手：用实测像素再写一次，同样全部写实（不留 null）
    const gridElement = paneGridRef.value
    if (gridElement) {
      const actualWidths = Array.from(gridElement.querySelectorAll('[data-pane-id]')).map(
        element => Math.round(element.getBoundingClientRect().width),
      )
      store.setPaneLayout({ count: panes.value.length, widths: actualWidths })
    }

    persistPaneLayout(store.paneLayout).then(() => {})
  }

  activeResizeCleanup = cleanupResizeListeners
  window.addEventListener('pointermove', handlePointerMove)
  window.addEventListener('pointerup', handlePointerUp)
  window.addEventListener('pointercancel', handlePointerUp)
  // 失焦（例如 Alt+Tab 切走再松手）也要收尾，否则监听器同样会残留
  window.addEventListener('blur', handlePointerUp)
}

</script>

<template>
  <div
    ref="paneGridRef"
    class="grid h-full min-h-0 min-w-0 w-full"
    data-testid="editor-pane-grid"
    :style="{ gridTemplateColumns }"
  >
    <template
      v-for="(pane, index) in panes"
      :key="pane.groupId"
    >
      <section
        class="wj-editor-pane relative h-full min-h-0 min-w-0 flex flex-col overflow-hidden"
        :class="pane.groupId === focusedGroupId ? 'wj-editor-pane-focused' : ''"
        data-testid="editor-pane"
        :data-pane-id="pane.groupId"
        :data-focused="pane.groupId === focusedGroupId ? 'true' : 'false'"
      >
        <!--
          编辑区空白**不切换焦点**：焦点只由「点击标签」决定。
          原来这里挂了 @click="focusPane"，点正文空白就会把激活栏抢过去，
          用户只是想点一下编辑器，栏的激活状态却变了。
        -->
        <div
          class="h-0 min-h-0 flex-1"
          data-testid="editor-pane-body"
        >
          <EditorView
            v-if="pane.tabs.length > 0"
            :pane-id="pane.groupId"
          />
          <div
            v-else
            class="h-full flex flex-col items-center justify-center gap-3"
            data-testid="editor-pane-empty"
          >
            <span class="text-sm op-60">{{ t('emptyPaneTitle') }}</span>
            <a-button
              size="small"
              data-testid="editor-pane-empty-create"
              @click.stop="createTabInPane(pane.groupId)"
            >
              {{ t('emptyPaneAction') }}
            </a-button>
          </div>
        </div>

        <!--
          投放预览：画在**目标栏内部**，半屏宽、靠左或靠右 ——
          就是新栏将要占的位置，所见即所得。纯装饰，不接收指针事件。
        -->
        <PaneDropPreview
          v-if="resolvePaneHover(pane.groupId)"
          :side="resolvePaneHover(pane.groupId).side"
          :limit="resolvePaneHover(pane.groupId).kind === 'limit'"
          :limit-count="maxPaneCount"
        />
      </section>
      <div
        v-if="index < panes.length - 1"
        class="wj-pane-gutter h-full cursor-col-resize"
        data-testid="editor-pane-gutter"
        @pointerdown="handleGutterPointerDown(index, $event)"
      />
    </template>
  </div>
</template>

<style scoped lang="scss">
.wj-pane-gutter {
  // 视觉上是一条窄缝，hover 时高亮，避免多栏之间看不出边界。
  background: var(--wj-border-color, rgba(128, 128, 128, 0.18));
  transition: background-color 0.15s ease;
}

.wj-pane-gutter:hover {
  background: var(--wj-primary-color, #1677ff);
}

.wj-editor-pane-focused {
  // 焦点栏高亮只做很轻的一层，避免抢走正文注意力。
  box-shadow: inset 0 0 0 1px var(--wj-primary-color, rgba(22, 119, 255, 0.35));
}

</style>
