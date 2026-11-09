import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDocumentCommandService } from '../documentCommandService.js'
import { createBoundFileSession, createDraftSession } from '../documentSessionFactory.js'
import { createDocumentSessionStore } from '../documentSessionStore.js'
import { createSaveCoordinator } from '../saveCoordinator.js'

const { createIdMock } = vi.hoisted(() => {
  return {
    createIdMock: vi.fn(),
  }
})

vi.mock('../../commonUtil.js', () => {
  return {
    default: {
      createId: createIdMock,
    },
  }
})

function createTestContext(config = []) {
  const normalizedConfig = Array.isArray(config)
    ? { autoSave: config }
    : { autoSave: [], ...config }
  const store = createDocumentSessionStore()
  const saveCoordinator = createSaveCoordinator()
  const service = createDocumentCommandService({
    store,
    saveCoordinator,
    getConfig: () => ({
      ...normalizedConfig,
    }),
  })

  return {
    store,
    service,
  }
}

function bindSession(store, session, windowId = 1001) {
  store.createSession(session)
  store.bindWindowToSession({
    windowId,
    sessionId: session.sessionId,
  })
  return windowId
}

describe('documentCommandService 标签组命令', () => {
  beforeEach(() => {
    let jobIndex = 1
    createIdMock.mockReset()
    createIdMock.mockImplementation(() => `job-${jobIndex++}`)
    vi.useFakeTimers()
    vi.setSystemTime(1700000002000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('create-group 必须新建一个空标签组并把焦点交给它，且只产生一个 create-group effect', () => {
    const { store, service } = createTestContext()
    const session = createBoundFileSession({
      sessionId: 'group-create-session',
      path: 'C:/docs/demo.md',
      content: '# 内容',
      stat: null,
      now: 1700000002001,
    })
    const windowId = bindSession(store, session)

    const result = service.dispatch({
      windowId,
      command: 'document.create-group',
    })

    expect(result.effects).toEqual([
      {
        type: 'create-group',
        groupId: 'group-2',
      },
    ])
    expect(store.getGroupIdsByWindowId(windowId)).toEqual(['main', 'group-2'])
    expect(store.getFocusedGroupIdByWindowId(windowId)).toBe('group-2')
    // 新栏必须是空栏：不做“复制当前文档”这种会产生两套编辑器状态的动作。
    expect(store.getSessionIdsByGroupId({ windowId, groupId: 'group-2' })).toEqual([])
    // 原文档仍留在原栏。
    expect(store.getSessionIdsByGroupId({ windowId, groupId: 'main' })).toEqual(['group-create-session'])
  })

  it('create-group 传入已被占用的 groupId 时必须另生成一个，不能合并到已有栏', () => {
    const { store, service } = createTestContext()
    const session = createBoundFileSession({
      sessionId: 'group-create-conflict-session',
      path: 'C:/docs/demo.md',
      content: '# 内容',
      stat: null,
      now: 1700000002001,
    })
    const windowId = bindSession(store, session)

    service.dispatch({ windowId, command: 'document.create-group', payload: { groupId: 'main' } })

    expect(store.getGroupIdsByWindowId(windowId)).toEqual(['main', 'group-2'])
  })

  it('activate-group 切焦点时必须产生 activate-group effect，同栏重复激活不再产生 effect', () => {
    const { store, service } = createTestContext()
    const session = createBoundFileSession({
      sessionId: 'group-activate-session',
      path: 'C:/docs/demo.md',
      content: '# 内容',
      stat: null,
      now: 1700000002001,
    })
    const windowId = bindSession(store, session)
    service.dispatch({ windowId, command: 'document.create-group' })

    const activated = service.dispatch({
      windowId,
      command: 'document.activate-group',
      payload: { groupId: 'main' },
    })

    expect(activated.effects).toEqual([
      {
        type: 'activate-group',
        groupId: 'main',
      },
    ])
    expect(store.getFocusedGroupIdByWindowId(windowId)).toBe('main')

    const repeated = service.dispatch({
      windowId,
      command: 'document.activate-group',
      payload: { groupId: 'main' },
    })

    expect(repeated.effects).toEqual([])
  })

  it('activate-group 目标组不属于该窗口时必须抛错', () => {
    const { store, service } = createTestContext()
    const session = createBoundFileSession({
      sessionId: 'group-activate-invalid-session',
      path: 'C:/docs/demo.md',
      content: '# 内容',
      stat: null,
      now: 1700000002001,
    })
    const windowId = bindSession(store, session)

    expect(() => service.dispatch({
      windowId,
      command: 'document.activate-group',
      payload: { groupId: 'group-x' },
    })).toThrow('activate-group 目标标签组不属于该窗口')
  })

  it('move-tab-to-group 必须把会话搬到目标栏（不复制会话）并产生 move-tab-to-group effect', () => {
    const { store, service } = createTestContext()
    const session = createBoundFileSession({
      sessionId: 'group-move-session',
      path: 'C:/docs/demo.md',
      content: '# 内容',
      stat: null,
      now: 1700000002001,
    })
    const windowId = bindSession(store, session)
    service.dispatch({ windowId, command: 'document.create-group' })

    const moved = service.dispatch({
      windowId,
      command: 'document.move-tab-to-group',
      payload: { sessionId: 'group-move-session', groupId: 'group-2' },
    })

    expect(moved.effects).toEqual([
      {
        type: 'move-tab-to-group',
        sessionId: 'group-move-session',
        groupId: 'group-2',
      },
      // 搬过去之后还要激活它：否则标签进了新栏、那一栏却仍停在原来的标签上
      {
        type: 'activate-tab',
        sessionId: 'group-move-session',
      },
    ])
    expect(store.getSessionIdsByGroupId({ windowId, groupId: 'group-2' })).toEqual(['group-move-session'])
    expect(store.getGroupIdBySessionId('group-move-session')).toBe('group-2')
    // 目标栏的激活标签必须是被搬过去的那个
    expect(store.getActiveSessionIdByGroupId({ windowId, groupId: 'group-2' })).toBe('group-move-session')
    // 会话本身没有被复制成两份。
    expect(store.getSessionIdsByWindowId(windowId)).toEqual(['group-move-session'])
  })

  it('move-tab-to-group 目标栏与当前栏相同时必须是 no-op', () => {
    const { store, service } = createTestContext()
    const session = createBoundFileSession({
      sessionId: 'group-move-noop-session',
      path: 'C:/docs/demo.md',
      content: '# 内容',
      stat: null,
      now: 1700000002001,
    })
    const windowId = bindSession(store, session)

    const result = service.dispatch({
      windowId,
      command: 'document.move-tab-to-group',
      payload: { sessionId: 'group-move-noop-session', groupId: 'main' },
    })

    expect(result.effects).toEqual([])
  })

  it('move-tab-to-group 目标栏不存在时必须抛错', () => {
    const { store, service } = createTestContext()
    const session = createBoundFileSession({
      sessionId: 'group-move-invalid-session',
      path: 'C:/docs/demo.md',
      content: '# 内容',
      stat: null,
      now: 1700000002001,
    })
    const windowId = bindSession(store, session)

    expect(() => service.dispatch({
      windowId,
      command: 'document.move-tab-to-group',
      payload: { sessionId: 'group-move-invalid-session', groupId: 'group-y' },
    })).toThrow('move-tab-to-group 目标标签组不存在')
  })

  it('close-group 关空栏时必须摘除该栏且不销毁任何会话', () => {
    const { store, service } = createTestContext()
    const session = createBoundFileSession({
      sessionId: 'group-close-empty-session',
      path: 'C:/docs/demo.md',
      content: '# 内容',
      stat: null,
      now: 1700000002001,
    })
    const windowId = bindSession(store, session)
    service.dispatch({ windowId, command: 'document.create-group' })

    const closed = service.dispatch({
      windowId,
      command: 'document.close-group',
      payload: { groupId: 'group-2' },
    })

    expect(closed.effects).toEqual([
      {
        type: 'close-group',
        groupId: 'group-2',
      },
    ])
    expect(store.getGroupIdsByWindowId(windowId)).toEqual(['main'])
    expect(store.getSession('group-close-empty-session')).toBeTruthy()
  })

  it('close-group 关有文档的栏时必须走批量关标签（脏文档仍由未保存确认接管）', () => {
    const { store, service } = createTestContext()
    const session = createBoundFileSession({
      sessionId: 'group-close-dirty-session',
      path: 'C:/docs/demo.md',
      content: '# 原始内容',
      stat: null,
      now: 1700000002001,
    })
    const windowId = bindSession(store, session)
    service.dispatch({
      windowId,
      command: 'document.edit',
      payload: { content: '# 改动后内容' },
    })

    const closed = service.dispatch({
      windowId,
      command: 'document.close-group',
      payload: { groupId: 'main' },
    })

    // 脏文档不能被静默丢掉，也不能静默忽略关栏请求：
    // 必须先落到“未保存确认”，且确认框对应的就是这份脏文档。
    expect(closed.effects.some(effect => effect.type === 'show-unsaved-prompt')).toBe(true)
    expect(closed.effects.some(effect => effect.type === 'close-tabs')).toBe(false)
    expect(store.getGroupIdsByWindowId(windowId)).toEqual(['main'])
    expect(store.getSession('group-close-dirty-session')).toBeTruthy()
  })

  it('close-group 关“干净 + 脏”混合栏时必须立刻关掉干净标签，并把脏标签顶到确认框', () => {
    const { store, service } = createTestContext()
    const dirtySession = createBoundFileSession({
      sessionId: 'group-mixed-dirty',
      path: 'C:/docs/dirty.md',
      content: '# 原始内容',
      stat: null,
      now: 1700000002001,
    })
    const windowId = bindSession(store, dirtySession)
    const cleanSession = createBoundFileSession({
      sessionId: 'group-mixed-clean',
      path: 'C:/docs/clean.md',
      content: '# 干净内容',
      stat: null,
      now: 1700000002002,
    })
    store.createSession(cleanSession)
    store.addSessionToWindow({
      windowId,
      sessionId: 'group-mixed-clean',
      groupId: 'main',
    })
    service.dispatch({
      windowId,
      command: 'document.edit',
      payload: { sessionId: 'group-mixed-dirty', content: '# 改动后内容' },
    })

    const closed = service.dispatch({
      windowId,
      command: 'document.close-group',
      payload: { groupId: 'main' },
    })

    expect(closed.effects).toContainEqual({
      type: 'close-tabs',
      sessionIds: ['group-mixed-clean'],
    })
    expect(closed.effects.some(effect => effect.type === 'show-unsaved-prompt')).toBe(true)
  })

  it('close-group 目标栏已不存在时必须静默成功，不能让渲染层吃到异常', () => {
    const { store, service } = createTestContext()
    const session = createBoundFileSession({
      sessionId: 'group-close-missing-session',
      path: 'C:/docs/demo.md',
      content: '# 内容',
      stat: null,
      now: 1700000002001,
    })
    const windowId = bindSession(store, session)

    const closed = service.dispatch({
      windowId,
      command: 'document.close-group',
      payload: { groupId: 'group-zzz' },
    })

    expect(closed.effects).toEqual([])
    expect(store.getGroupIdsByWindowId(windowId)).toEqual(['main'])
  })

  it('reorder-tabs 带 groupId 时必须只和本栏标签比集合，双栏场景不能因整窗集合不等而抛错', () => {
    const { store, service } = createTestContext()
    const firstSession = createBoundFileSession({
      sessionId: 'reorder-group-first',
      path: 'C:/docs/first.md',
      content: '# 1',
      stat: null,
      now: 1700000002001,
    })
    const windowId = bindSession(store, firstSession)
    const secondSession = createDraftSession({
      sessionId: 'reorder-group-second',
      content: '',
      now: 1700000002002,
    })
    store.createSession(secondSession)
    store.addSessionToWindow({
      windowId,
      sessionId: 'reorder-group-second',
      groupId: 'main',
    })

    service.dispatch({ windowId, command: 'document.create-group' })

    expect(() => service.dispatch({
      windowId,
      command: 'document.reorder-tabs',
      payload: {
        groupId: 'main',
        sessionIds: ['reorder-group-second', 'reorder-group-first'],
      },
    })).not.toThrow()

    expect(store.getSessionIdsByGroupId({ windowId, groupId: 'main' }))
      .toEqual(['reorder-group-second', 'reorder-group-first'])
  })
})

describe('documentCommandService 栏数上限', () => {
  beforeEach(() => {
    let jobIndex = 1
    createIdMock.mockReset()
    createIdMock.mockImplementation(() => `job-${jobIndex++}`)
    vi.useFakeTimers()
    vi.setSystemTime(1700000002000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('最多 4 栏：已有 4 栏时 create-group 必须被硬挡，不能建出画不下的第 5 栏', () => {
    const { store, service } = createTestContext()
    const session = createBoundFileSession({
      sessionId: 'group-limit-session',
      path: 'C:/docs/demo.md',
      content: '# 内容',
      stat: null,
      now: 1700000002001,
    })
    const windowId = bindSession(store, session)

    // 直接把状态铺到 4 栏（模拟用户已经手动拆满），再验命令层是否还放行
    store.createGroup({ windowId, groupId: 'group-2' })
    store.createGroup({ windowId, groupId: 'group-3' })
    store.createGroup({ windowId, groupId: 'group-4' })
    expect(store.getGroupIdsByWindowId(windowId)).toHaveLength(4)

    const blocked = service.dispatch({ windowId, command: 'document.create-group' })

    expect(store.getGroupIdsByWindowId(windowId)).toHaveLength(4)
    expect(blocked.effects).toEqual([])
  })

  it('不足 4 栏时 create-group 仍然正常建栏（上限不能误伤正常拆分）', () => {
    const { store, service } = createTestContext()
    const session = createBoundFileSession({
      sessionId: 'group-under-limit-session',
      path: 'C:/docs/demo.md',
      content: '# 内容',
      stat: null,
      now: 1700000002001,
    })
    const windowId = bindSession(store, session)

    const result = service.dispatch({ windowId, command: 'document.create-group' })

    expect(store.getGroupIdsByWindowId(windowId)).toHaveLength(2)
    expect(result.effects).toEqual([{ type: 'create-group', groupId: 'group-2' }])
  })
})
