import { describe, expect, it } from 'vitest'
import { createDocumentSessionStore } from '../documentSessionStore.js'
import { deriveWindowDocumentSnapshot, deriveWindowGroupsSnapshot } from '../documentWindowSnapshotUtil.js'

function createSession(sessionId, content) {
  return {
    sessionId,
    documentSource: { path: `/tmp/${sessionId}.md`, exists: true },
    editorSnapshot: { content, revision: 0 },
    diskSnapshot: { content, exists: true },
  }
}

function setup() {
  const store = createDocumentSessionStore()
  store.createSession(createSession('session-a', '左栏正文'))
  store.createSession(createSession('session-b', '右栏正文'))
  return store
}

describe('窗口快照的分栏投影', () => {
  it('单栏窗口不下发 groups，顶层字段与改造前一致', () => {
    const store = setup()
    store.addSessionToWindow({ windowId: 1, sessionId: 'session-a' })
    store.activateSession({ windowId: 1, sessionId: 'session-a' })

    const snapshot = deriveWindowDocumentSnapshot({ store, windowId: 1 })

    expect(snapshot.sessionId).toBe('session-a')
    expect(snapshot.tabs.map(tab => tab.sessionId)).toEqual(['session-a'])
    expect('groups' in snapshot).toBe(false)
    expect('activeGroupId' in snapshot).toBe(false)
  })

  it('双栏窗口下发 groups，每栏带各自活动会话的完整快照与标签列表', () => {
    const store = setup()
    store.addSessionToWindow({ windowId: 1, sessionId: 'session-a', groupId: 'main' })
    store.addSessionToWindow({ windowId: 1, sessionId: 'session-b', groupId: 'right' })
    store.activateSession({ windowId: 1, sessionId: 'session-b' })

    const snapshot = deriveWindowDocumentSnapshot({ store, windowId: 1 })

    expect(snapshot.activeGroupId).toBe('right')
    expect(snapshot.groups).toHaveLength(2)
    expect(snapshot.groups.map(group => group.groupId)).toEqual(['main', 'right'])
    expect(snapshot.groups[0].snapshot.content).toBe('左栏正文')
    expect(snapshot.groups[1].snapshot.content).toBe('右栏正文')
    expect(snapshot.groups[0].tabs.map(tab => tab.sessionId)).toEqual(['session-a'])
    // 顶层字段跟随聚焦栏，旧的单栏链路不需要改写
    expect(snapshot.sessionId).toBe('session-b')
    expect(snapshot.tabs.map(tab => tab.sessionId)).toEqual(['session-b'])
  })

  it('刚拆出来的空栏 snapshot 为 null，但仍出现在 groups 里', () => {
    const store = setup()
    store.addSessionToWindow({ windowId: 1, sessionId: 'session-a', groupId: 'main' })
    store.createGroup({ windowId: 1, groupId: 'right' })

    const { activeGroupId, groups } = deriveWindowGroupsSnapshot({ store, windowId: 1 })

    expect(activeGroupId).toBe('right')
    expect(groups.map(group => group.groupId)).toEqual(['main', 'right'])
    expect(groups[1]).toEqual({
      groupId: 'right',
      activeSessionId: null,
      tabs: [],
      snapshot: null,
    })
  })

  it('切换聚焦栏后，顶层投影与 activeGroupId 一起变化', () => {
    const store = setup()
    store.addSessionToWindow({ windowId: 1, sessionId: 'session-a', groupId: 'main' })
    store.addSessionToWindow({ windowId: 1, sessionId: 'session-b', groupId: 'right' })

    store.activateGroup({ windowId: 1, groupId: 'main' })
    const leftFocused = deriveWindowDocumentSnapshot({ store, windowId: 1 })
    expect(leftFocused.activeGroupId).toBe('main')
    expect(leftFocused.sessionId).toBe('session-a')

    store.activateGroup({ windowId: 1, groupId: 'right' })
    const rightFocused = deriveWindowDocumentSnapshot({ store, windowId: 1 })
    expect(rightFocused.activeGroupId).toBe('right')
    expect(rightFocused.sessionId).toBe('session-b')
  })
})
