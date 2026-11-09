/**
 * 标签拖拽的落点意图（跨栏搬运 / 编辑区左右半区分栏）。
 *
 * 标签条在顶栏（`EditorTabStrip`），编辑区在下面（`EditorWorkspace`），
 * 两者是兄弟节点、没有父子关系，所以拖拽过程中的“正在拖哪个标签”“落在哪一侧”
 * 走这个模块级的轻量状态中转，不引入新的 IPC 或 store 字段。
 *
 * 只存“意图”，不存“结果”：真正的建栏/搬标签由 `EditorWorkspace` 消费后发命令。
 */
import { reactive } from 'vue'

export const PANE_DROP_SIDE_LEFT = 'left'
export const PANE_DROP_SIDE_RIGHT = 'right'

export const editorPaneDropState = reactive({
  /** 是否正在拖标签（越过拖拽阈值后才为 true） */
  dragging: false,
  /** 正在拖的会话 id */
  sessionId: null,
  /** 被拖标签原来所在的栏（单栏时为 null），用来排除「落回自己这一栏」 */
  sourceGroupId: null,
  /** 当前指针落在编辑区的哪一半：'left' | 'right' | null */
  side: null,
  /**
   * 指针落在**另一栏**的标签条上时，那一栏的 groupId。
   * 松手就表示「把这个标签搬进那一栏」，与左右半区分栏互斥。
   */
  targetGroupId: null,
  /** 松手时的落点，由 `EditorWorkspace` 消费后清空 */
  pendingDrop: null,
  /**
   * 当前投放预览（画在**目标栏**内部的半屏覆盖层）。
   *
   * 结构：`{ paneId, side, kind }`
   * - `kind = 'split'`：画半屏预览 + 「松手：在这一栏左侧/右侧新开一栏」
   * - `kind = 'limit'`：画居中的「最多支持 N 栏」提示，不画半屏
   * - `null`：不显示任何预览
   *
   * 由 `EditorWorkspace` 在 dragover / 拖标签指针移动时写入，
   * `EditorPaneGrid` 直接读取渲染 —— 预览必须画在**目标栏**里，
   * 才能让「松手会插在哪一侧」一目了然。
   */
  hover: null,
})

/**
 * 开始一次标签拖拽。
 *
 * @param {string} sessionId 被拖动的会话 id
 * @param {string | null} [groupSourceId] 被拖标签原来所在的栏；单栏传 null
 */
export function startEditorPaneDrag(sessionId, groupSourceId = null) {
  editorPaneDropState.dragging = true
  editorPaneDropState.sessionId = sessionId ?? null
  editorPaneDropState.sourceGroupId = groupSourceId ?? null
  editorPaneDropState.side = null
  editorPaneDropState.targetGroupId = null
  editorPaneDropState.pendingDrop = null
}

/**
 * 更新指针当前落在哪一侧。
 *
 * @param {'left' | 'right' | null} side 侧别
 */
export function setEditorPaneDropSide(side) {
  editorPaneDropState.side = side
  // 左右半区与跨栏落点互斥：落进编辑区就不再提示跨栏
  if (side) {
    editorPaneDropState.targetGroupId = null
  }
}

/**
 * 更新指针当前悬停在另一栏的标签条上。
 *
 * @param {string | null} groupId 目标栏的 groupId；null 表示不在任何别的栏上
 */
export function setEditorPaneDropTargetGroupId(groupId) {
  editorPaneDropState.targetGroupId = groupId ?? null
  if (groupId) {
    // 悬停在别栏标签条上时，编辑区半区高亮必须让位
    editorPaneDropState.side = null
  }
}

/**
 * 记录一次“松手落在编辑区”的落点，等 `EditorWorkspace` 处理。
 *
 * @param {{sessionId: string, clientX: number, clientY: number}} drop 落点
 */
export function queueEditorPaneDrop(drop) {
  if (!drop?.sessionId) {
    return
  }
  editorPaneDropState.pendingDrop = {
    sessionId: drop.sessionId,
    clientX: drop.clientX,
    clientY: drop.clientY,
    /**
     * 把「从哪一栏拖出来的」一起快照进去。
     *
     * 消费方（`EditorWorkspace` 的 watch）会先 `clearEditorPaneDrag()` 再处理落点，
     * 那一步会把 `sourceGroupId` 清空 —— 不在这里带上，消费时就永远读到 null，
     * 「同栏拖到边缘分栏」这类需要比较源栏的逻辑会全部失效。
     */
    sourceGroupId: editorPaneDropState.sourceGroupId,
  }
}

/** 清空所有拖拽状态（拖拽取消、或落点已被消费） */
export function clearEditorPaneDrag() {
  editorPaneDropState.dragging = false
  editorPaneDropState.sessionId = null
  editorPaneDropState.sourceGroupId = null
  editorPaneDropState.side = null
  editorPaneDropState.targetGroupId = null
  editorPaneDropState.pendingDrop = null
  editorPaneDropState.hover = null
}

/**
 * 设置投放预览。
 *
 * 传 `null` 就是「现在不该显示任何预览」—— 这条要覆盖所有
 * 「松手其实什么也不会变」的情况（已在本栏的会话、同栏唯一标签等），
 * 否则会画出骗人的半屏。
 *
 * @param {{paneId: (string|null), side: ('left'|'right'|null), kind: string} | null} hover 预览状态
 */
export function setEditorPaneDropHover(hover) {
  if (!hover) {
    editorPaneDropState.hover = null
    return
  }
  const previous = editorPaneDropState.hover
  // 避免每帧都写新对象触发无谓重渲染
  if (previous
    && previous.paneId === hover.paneId
    && previous.side === hover.side
    && previous.kind === hover.kind) {
    return
  }
  editorPaneDropState.hover = { paneId: hover.paneId ?? null, side: hover.side ?? null, kind: hover.kind }
}
