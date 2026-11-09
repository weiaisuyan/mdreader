import { describe, expect, it } from 'vitest'
import { createWindowRegistry } from '../windowRegistry.js'

function createRegistryWithWindow(windowId = 1001) {
  const registry = createWindowRegistry()
  const win = { id: windowId, webContents: { id: windowId } }
  registry.registerWindow({ windowId, win })
  return { registry, win }
}

describe('windowRegistry 标签组（栏）维度', () => {
  it('不传 groupId 时落默认 main 组，窗口级活动会话按聚焦栏读取', () => {
    const { registry } = createRegistryWithWindow()

    registry.addSession({ windowId: 1001, sessionId: 'session-1' })
    registry.addSession({ windowId: 1001, sessionId: 'session-2' })
    registry.activateSession({ windowId: 1001, sessionId: 'session-2' })

    expect(registry.getGroupIdsByWindowId(1001)).toEqual(['main'])
    expect(registry.getFocusedGroupIdByWindowId(1001)).toBe('main')
    expect(registry.getSessionIdByWindowId(1001)).toBe('session-2')
    expect(registry.getSessionIdsByWindowId(1001)).toEqual(['session-1', 'session-2'])
  })

  it('createGroup 建新栏并聚焦，窗口级绑定随之指向新栏', () => {
    const { registry } = createRegistryWithWindow()

    registry.addSession({ windowId: 1001, sessionId: 'session-1' })
    registry.activateSession({ windowId: 1001, sessionId: 'session-1' })
    expect(registry.getFocusedGroupIdByWindowId(1001)).toBe('main')

    registry.createGroup({ windowId: 1001, groupId: 'right' })

    expect(registry.getGroupIdsByWindowId(1001)).toEqual(['main', 'right'])
    expect(registry.getFocusedGroupIdByWindowId(1001)).toBe('right')
    // 新栏没有标签，窗口级绑定不应该残留旧栏的 session
    expect(registry.getSessionIdByWindowId(1001)).toBe(null)
    expect(registry.getSessionIdsByWindowId(1001)).toEqual(['session-1'])
  })

  it('标签可以挂到指定栏，栏内列表与整窗列表分开统计', () => {
    const { registry } = createRegistryWithWindow()

    registry.addSession({ windowId: 1001, sessionId: 'session-1', groupId: 'main' })
    registry.addSession({ windowId: 1001, sessionId: 'session-2', groupId: 'right' })

    expect(registry.getSessionIdsByGroupId({ windowId: 1001, groupId: 'main' })).toEqual(['session-1'])
    expect(registry.getSessionIdsByGroupId({ windowId: 1001, groupId: 'right' })).toEqual(['session-2'])
    expect(registry.getSessionIdsByWindowId(1001)).toEqual(['session-1', 'session-2'])
  })

  it('激活标签会把焦点交给它所在的栏', () => {
    const { registry } = createRegistryWithWindow()

    registry.addSession({ windowId: 1001, sessionId: 'session-1', groupId: 'main' })
    registry.addSession({ windowId: 1001, sessionId: 'session-2', groupId: 'right' })
    registry.activateGroup({ windowId: 1001, groupId: 'main' })

    registry.activateSession({ windowId: 1001, sessionId: 'session-2' })

    expect(registry.getFocusedGroupIdByWindowId(1001)).toBe('right')
    expect(registry.getSessionIdByWindowId(1001)).toBe('session-2')
    expect(registry.getActiveSessionIdByGroupId({ windowId: 1001, groupId: 'main' })).toBe('session-1')
  })

  it('moveSessionToGroup 跨栏搬家后旧栏不再持有该标签', () => {
    const { registry } = createRegistryWithWindow()

    registry.addSession({ windowId: 1001, sessionId: 'session-1', groupId: 'main' })
    registry.addSession({ windowId: 1001, sessionId: 'session-2', groupId: 'main' })
    registry.createGroup({ windowId: 1001, groupId: 'right' })

    registry.moveSessionToGroup({ sessionId: 'session-2', windowId: 1001, groupId: 'right' })

    expect(registry.getSessionIdsByGroupId({ windowId: 1001, groupId: 'main' })).toEqual(['session-1'])
    expect(registry.getSessionIdsByGroupId({ windowId: 1001, groupId: 'right' })).toEqual(['session-2'])
  })

  it('移除某栏最后一个标签时整组消失，焦点顺延到相邻栏', () => {
    const { registry } = createRegistryWithWindow()

    registry.addSession({ windowId: 1001, sessionId: 'session-1', groupId: 'main' })
    registry.addSession({ windowId: 1001, sessionId: 'session-2', groupId: 'right' })
    registry.activateSession({ windowId: 1001, sessionId: 'session-2' })

    expect(registry.removeSession({ windowId: 1001, sessionId: 'session-2' })).toBe(true)

    expect(registry.getGroupIdsByWindowId(1001)).toEqual(['main'])
    expect(registry.getFocusedGroupIdByWindowId(1001)).toBe('main')
    expect(registry.getSessionIdByWindowId(1001)).toBe('session-1')
  })

  it('removeGroup 交回该栏标签并让窗口级绑定顺延', () => {
    const { registry } = createRegistryWithWindow()

    registry.addSession({ windowId: 1001, sessionId: 'session-1', groupId: 'main' })
    registry.addSession({ windowId: 1001, sessionId: 'session-2', groupId: 'right' })
    registry.activateGroup({ windowId: 1001, groupId: 'right' })

    expect(registry.removeGroup({ windowId: 1001, groupId: 'right' })).toEqual(['session-2'])

    expect(registry.getGroupIdsByWindowId(1001)).toEqual(['main'])
    expect(registry.getFocusedGroupIdByWindowId(1001)).toBe('main')
    expect(registry.getSessionIdByWindowId(1001)).toBe('session-1')
  })
})
