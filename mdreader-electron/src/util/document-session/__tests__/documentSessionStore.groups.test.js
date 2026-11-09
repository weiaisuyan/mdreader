import { describe, expect, it } from 'vitest'
import { createDocumentSessionStore } from '../documentSessionStore.js'

function createSession(sessionId, path = `/tmp/${sessionId}.md`) {
  return {
    sessionId,
    documentSource: { path },
    editorSnapshot: { content: `正文-${sessionId}` },
  }
}

function setup() {
  const store = createDocumentSessionStore()
  const sessionA = store.createSession(createSession('session-a'))
  const sessionB = store.createSession(createSession('session-b'))
  return { store, sessionA, sessionB }
}

describe('documentSessionStore 标签组（栏）维度', () => {
  it('不传 groupId 时标签落到默认 main 组，窗口级入口按聚焦栏读取', () => {
    const { store } = setup()

    store.addSessionToWindow({ windowId: 1, sessionId: 'session-a' })
    store.addSessionToWindow({ windowId: 1, sessionId: 'session-b' })
    store.activateSession({ windowId: 1, sessionId: 'session-b' })

    expect(store.getGroupIdsByWindowId(1)).toEqual(['main'])
    expect(store.getFocusedGroupIdByWindowId(1)).toBe('main')
    expect(store.getSessionIdsByWindowId(1)).toEqual(['session-a', 'session-b'])
    expect(store.getSessionByWindowId(1).sessionId).toBe('session-b')
  })

  it('createGroup 新建空栏并聚焦它，整窗标签列表保持不变', () => {
    const { store } = setup()

    store.addSessionToWindow({ windowId: 1, sessionId: 'session-a' })
    store.activateSession({ windowId: 1, sessionId: 'session-a' })
    store.createGroup({ windowId: 1, groupId: 'right' })

    expect(store.getGroupIdsByWindowId(1)).toEqual(['main', 'right'])
    expect(store.getFocusedGroupIdByWindowId(1)).toBe('right')
    expect(store.getSessionIdsByGroupId({ windowId: 1, groupId: 'right' })).toEqual([])
    expect(store.getSessionIdsByWindowId(1)).toEqual(['session-a'])
    // 聚焦栏是空栏时，窗口级入口退到第一个有文档的栏，而不是返回 null
    // （标题、文件管理器、目录监听都依赖它，null 会让整窗失效）
    expect(store.getSessionByWindowId(1).sessionId).toBe('session-a')
  })

  it('标签可以挂到指定栏，栏内列表与整窗列表分开统计', () => {
    const { store } = setup()

    store.addSessionToWindow({ windowId: 1, sessionId: 'session-a', groupId: 'main' })
    store.addSessionToWindow({ windowId: 1, sessionId: 'session-b', groupId: 'right' })

    expect(store.getSessionIdsByGroupId({ windowId: 1, groupId: 'main' })).toEqual(['session-a'])
    expect(store.getSessionIdsByGroupId({ windowId: 1, groupId: 'right' })).toEqual(['session-b'])
    expect(store.getSessionIdsByWindowId(1)).toEqual(['session-a', 'session-b'])
  })

  it('激活某个标签会把焦点交给它所在的栏', () => {
    const { store } = setup()

    store.addSessionToWindow({ windowId: 1, sessionId: 'session-a', groupId: 'main' })
    store.addSessionToWindow({ windowId: 1, sessionId: 'session-b', groupId: 'right' })
    expect(store.getFocusedGroupIdByWindowId(1)).toBe('main')

    store.activateSession({ windowId: 1, sessionId: 'session-b' })

    expect(store.getFocusedGroupIdByWindowId(1)).toBe('right')
    expect(store.getActiveSessionIdByGroupId({ windowId: 1, groupId: 'right' })).toBe('session-b')
    expect(store.getActiveSessionIdByGroupId({ windowId: 1, groupId: 'main' })).toBe('session-a')
  })

  it('移除整栏会交回该栏标签、把焦点顺延到相邻栏，窗口级列表同步收缩', () => {
    const { store } = setup()

    store.addSessionToWindow({ windowId: 1, sessionId: 'session-a', groupId: 'main' })
    store.addSessionToWindow({ windowId: 1, sessionId: 'session-b', groupId: 'right' })
    store.activateGroup({ windowId: 1, groupId: 'right' })

    expect(store.removeGroupFromWindow({ windowId: 1, groupId: 'right' })).toEqual(['session-b'])
    expect(store.getGroupIdsByWindowId(1)).toEqual(['main'])
    expect(store.getFocusedGroupIdByWindowId(1)).toBe('main')
    expect(store.getSessionIdsByWindowId(1)).toEqual(['session-a'])
    // 会话本身还在，只是不再属于任何窗口
    expect(store.getSession('session-a')).not.toBe(null)
    expect(store.getWindowIdBySessionId('session-b')).toBe(null)
  })

  it('moveSessionToGroup 是搬家不是复制：会话身份不变，旧栏不再持有它', () => {
    const { store } = setup()

    store.addSessionToWindow({ windowId: 1, sessionId: 'session-a', groupId: 'main' })
    store.addSessionToWindow({ windowId: 1, sessionId: 'session-b', groupId: 'main' })
    store.createGroup({ windowId: 1, groupId: 'right' })

    store.moveSessionToGroup({ sessionId: 'session-b', windowId: 1, groupId: 'right' })

    expect(store.getSessionIdsByGroupId({ windowId: 1, groupId: 'main' })).toEqual(['session-a'])
    expect(store.getSessionIdsByGroupId({ windowId: 1, groupId: 'right' })).toEqual(['session-b'])
    expect(store.getGroupIdBySessionId('session-b')).toBe('right')
    expect(store.getSession('session-b').editorSnapshot.content).toBe('正文-session-b')
  })

  it('窗口级 reorderWindowSessions 只调顺序、不跨栏搬迁', () => {
    const { store } = setup()

    store.addSessionToWindow({ windowId: 1, sessionId: 'session-a', groupId: 'main' })
    store.addSessionToWindow({ windowId: 1, sessionId: 'session-b', groupId: 'right' })

    store.reorderWindowSessions({ windowId: 1, sessionIds: ['session-b', 'session-a'] })

    expect(store.getSessionIdsByGroupId({ windowId: 1, groupId: 'main' })).toEqual(['session-b'])
    expect(store.getSessionIdsByGroupId({ windowId: 1, groupId: 'right' })).toEqual(['session-a'])
  })

  it('reorderGroupSessions 只在该栏内重排，集合不一致时抛错', () => {
    const { store } = setup()

    store.addSessionToWindow({ windowId: 1, sessionId: 'session-a' })
    store.addSessionToWindow({ windowId: 1, sessionId: 'session-b' })

    expect(store.reorderGroupSessions({ windowId: 1, sessionIds: ['session-b', 'session-a'] }))
      .toEqual(['session-b', 'session-a'])
    expect(() => store.reorderGroupSessions({ windowId: 1, sessionIds: ['session-a'] }))
      .toThrow(/要求 sessionIds 与该栏标签集合一致/)
  })

  it('摘除某栏最后一个标签时整组消失，焦点顺延；窗口一组不剩则窗口状态清空', () => {
    const { store } = setup()

    store.addSessionToWindow({ windowId: 1, sessionId: 'session-a', groupId: 'main' })
    store.addSessionToWindow({ windowId: 1, sessionId: 'session-b', groupId: 'right' })
    store.activateGroup({ windowId: 1, groupId: 'right' })

    store.destroySession('session-b')

    expect(store.getGroupIdsByWindowId(1)).toEqual(['main'])
    expect(store.getFocusedGroupIdByWindowId(1)).toBe('main')

    store.destroySession('session-a')

    expect(store.getGroupIdsByWindowId(1)).toEqual([])
    expect(store.getSessionIdsByWindowId(1)).toEqual([])
    expect(store.getSessionByWindowId(1)).toBe(null)
  })

  it('groupId 必须是非空字符串，前后空白会被归一', () => {
    const { store } = setup()
    store.addSessionToWindow({ windowId: 1, sessionId: 'session-a' })

    expect(() => store.createGroup({ windowId: 1, groupId: 7 })).toThrow(/groupId 必须是非空字符串/)
    expect(store.createGroup({ windowId: 1, groupId: ' right ' })).toBe('right')
    expect(store.getGroupIdsByWindowId(1)).toEqual(['main', 'right'])
  })

  it('getWindowGroupSnapshotState 按栏顺序返回各栏活动标签', () => {
    const { store } = setup()

    store.addSessionToWindow({ windowId: 1, sessionId: 'session-a', groupId: 'main' })
    store.addSessionToWindow({ windowId: 1, sessionId: 'session-b', groupId: 'right' })
    store.activateSession({ windowId: 1, sessionId: 'session-b' })

    expect(store.getWindowGroupSnapshotState(1)).toEqual({
      focusedGroupId: 'right',
      groups: [
        { groupId: 'main', sessionIds: ['session-a'], activeSessionId: 'session-a' },
        { groupId: 'right', sessionIds: ['session-b'], activeSessionId: 'session-b' },
      ],
    })
  })
})
