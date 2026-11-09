import { inject, provide } from 'vue'

// 编辑页在「多栏并排」下会有多份实例，每份只负责自己那一栏。
// 这里用 provide/inject 把所属栏 id 交给子树，
// 免得把 paneId 从 EditorView 一路 prop 到 MarkdownEdit 的每一层。
const PANE_ID_KEY = Symbol('wj-editor-pane-id')

/**
 * 向下提供当前栏 id。
 *
 * @param {string | null} paneId 标签组 id；单栏传 null
 * @returns {void}
 */
export function providePaneId(paneId) {
  const normalized = typeof paneId === 'string' && paneId !== '' ? paneId : null
  provide(PANE_ID_KEY, normalized)
}

/**
 * 取当前栏 id。
 *
 * 单栏（没有 provide）时返回 null，调用方据此回落到窗口级数据。
 *
 * @returns {string | null} 标签组 id
 */
export function usePaneId() {
  const paneId = inject(PANE_ID_KEY, null)
  return typeof paneId === 'string' && paneId !== '' ? paneId : null
}

/**
 * 取某一栏的标签、活动会话与完整快照。
 *
 * store 提供 `getPaneGroupSnapshot` 时以它为准（真机上单栏会补出一个虚拟栏，
 * 多栏则按 groups 拆）；调用方只 mock 了快照字段时退化成「一栏 = 整窗快照」，
 * 保证单栏语义与改造前一致。
 *
 * @param {object} store 公共 store
 * @param {string | null} paneId 栏 id；单栏传 null
 * @returns {{ groupId: string, tabs: Array<object>, activeSessionId: string | null, snapshot: object | null }} 该栏数据
 */
export function resolvePaneGroupSnapshot(store, paneId) {
  if (typeof store?.getPaneGroupSnapshot === 'function') {
    return store.getPaneGroupSnapshot(paneId)
  }

  const snapshot = store?.documentSessionSnapshot ?? null
  return {
    groupId: typeof paneId === 'string' && paneId !== '' ? paneId : 'main',
    tabs: Array.isArray(snapshot?.tabs) ? snapshot.tabs : [],
    // 单会话快照只带 sessionId，两者都认：正文归属不能在首帧丢掉。
    activeSessionId: snapshot?.activeSessionId ?? snapshot?.sessionId ?? null,
    snapshot,
  }
}

export default {
  providePaneId,
  usePaneId,
  resolvePaneGroupSnapshot,
}
