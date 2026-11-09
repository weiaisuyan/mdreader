import { attachWindowTabsSnapshot, deriveDocumentSnapshot, deriveDocumentTabSnapshot } from './documentSnapshotUtil.js'

/**
 * 按窗口当前持有的会话顺序生成标签列表。
 *
 * 标签顺序就是用户在标签栏里看到的顺序，必须与 store 记录的标签顺序一致；
 * 这里不做任何排序，避免主进程和渲染层各自维护一套“标签应该怎么排”。
 */
export function deriveWindowTabsSnapshot({ store, windowId }) {
  const sessionIds = store?.getSessionIdsByWindowId?.(windowId) || []
  return sessionIds
    .map(sessionId => store?.getSession?.(sessionId))
    .filter(Boolean)
    .map(session => deriveDocumentTabSnapshot(session))
}

/**
 * 生成窗口的分栏快照：每一栏的标签列表 + 该栏活动会话的完整快照。
 *
 * 多栏并排时，非聚焦栏的编辑器也要渲染正文，所以每栏都必须带上活动会话的完整快照，
 * 而不只是标签列表。单栏窗口下这仍然只产出 `main` 一组，开销与改造前一致。
 *
 * 没有活动会话的栏（刚拆出来的空栏）`snapshot` 为 null，渲染层据此显示空态引导。
 */
export function deriveWindowGroupsSnapshot({ store, windowId }) {
  const windowGroupState = store?.getWindowGroupSnapshotState?.(windowId)
  if (!windowGroupState) {
    return { activeGroupId: null, groups: [] }
  }

  const groups = windowGroupState.groups.map((group) => {
    const activeSession = group.activeSessionId
      ? store?.getSession?.(group.activeSessionId) || null
      : null
    const tabs = group.sessionIds
      .map(sessionId => store?.getSession?.(sessionId))
      .filter(Boolean)
      .map(session => deriveDocumentTabSnapshot(session))

    return {
      groupId: group.groupId,
      activeSessionId: group.activeSessionId || null,
      tabs,
      snapshot: activeSession ? deriveDocumentSnapshot(activeSession) : null,
    }
  })

  return {
    activeGroupId: windowGroupState.focusedGroupId,
    groups,
  }
}

/**
 * 生成窗口级文档快照：聚焦栏活动会话的完整快照 + 该栏标签列表 + 全窗口分栏视图。
 *
 * 命令层、窗口桥、同步查询都必须经过这一个函数产出快照，
 * 否则“命令返回的快照”和“桥里重新推导的快照”结构不一致，
 * 会让 `if-changed` 这类基于快照签名的判断永远认为发生了变化。
 *
 * 顶层 `tabs` / `activeSessionId` 保持“聚焦栏”语义，
 * 这样所有只认识单栏结构的旧链路（标签栏、标题、快捷键）都不需要改写。
 */
export function deriveWindowDocumentSnapshot({ store, windowId }) {
  const session = store?.getSessionByWindowId?.(windowId)

  const { activeGroupId, groups } = deriveWindowGroupsSnapshot({ store, windowId })
  if (!session) {
    return null
  }

  const windowActiveSessionId
    = store?.getActiveSessionIdByWindowId?.(windowId) || session.sessionId || null
  // 顶层标签必须跟着「窗口级活动会话所在的栏」，而不是「当前聚焦的栏」。
  // 刚拆出来的空栏是聚焦栏、但没有任何标签，若让顶层 tabs 跟焦栏，
  // 所有只认识单栏结构的旧链路（标签栏、标题、快捷键）会同时看到空标签列表。
  const activeSessionGroupId = windowActiveSessionId
    ? store?.getGroupIdBySessionId?.(windowActiveSessionId) || null
    : null
  const displayGroup = groups.find(group => group.groupId === (activeSessionGroupId ?? activeGroupId))
    || groups.find(group => group.groupId === activeGroupId)
    || null

  return attachWindowTabsSnapshot({
    snapshot: deriveDocumentSnapshot(session),
    tabs: displayGroup ? displayGroup.tabs : deriveWindowTabsSnapshot({ store, windowId }),
    activeSessionId: windowActiveSessionId,
    activeGroupId,
    // 单栏窗口不下发 groups：多栏快照会把活动正文再复制一份，
    // 而单栏是绝大多数场景，没必要为此让每次推送的体积翻倍。
    // 渲染层以「有没有 groups」判定当前窗口是不是多栏。
    groups: groups.length > 1 ? groups : [],
  })
}

export default {
  deriveWindowDocumentSnapshot,
  deriveWindowGroupsSnapshot,
  deriveWindowTabsSnapshot,
}
