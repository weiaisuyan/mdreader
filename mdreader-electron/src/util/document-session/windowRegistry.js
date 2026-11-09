const DEFAULT_GROUP_ID = 'main'

function normalizeWindowId(windowId) {
  if (typeof windowId === 'number' && Number.isFinite(windowId)) {
    return String(windowId)
  }

  if (typeof windowId === 'string' && windowId.trim() !== '') {
    return windowId.trim()
  }

  throw new TypeError('windowId 必须是数字或非空字符串')
}

function normalizeGroupId(groupId) {
  if (groupId === undefined || groupId === null) {
    return DEFAULT_GROUP_ID
  }

  if (typeof groupId !== 'string' || groupId.trim() === '') {
    throw new TypeError('groupId 必须是非空字符串')
  }

  return groupId.trim()
}

function assertWindowReference(win) {
  if (win) {
    return
  }

  throw new TypeError('win 必须存在')
}

function assertSessionId(sessionId) {
  if (typeof sessionId === 'string' && sessionId.trim() !== '') {
    return
  }

  throw new TypeError('sessionId 必须是非空字符串')
}

/**
 * 只维护窗口身份映射真相。
 *
 * registry 负责四件事：
 * 1. `windowId -> win`
 * 2. `windowId -> groupId[]`（该窗口的标签组顺序，即左右栏顺序）
 * 3. `windowId -> groupId -> sessionId[]`（每栏持有的标签顺序）
 * 4. `windowId -> sessionId`（聚焦栏的活动会话，供 `getRegistrySessionId` 读取）
 *
 * 这里故意不承载 path、content、保存态等文档状态，
 * 避免把旧 winInfo 兼容结构继续带进新的 runtime 边界。
 *
 * 与 store 的关系：两边是并行映射，group 结构必须同步演进，
 * 否则会出现「registry 说 A 栏、store 说 B 栏」的错位，
 * 表现为偶发的切换失效或关错栏。
 */
export function createWindowRegistry() {
  const windowMap = new Map()
  const windowIdByWinMap = new Map()
  const sessionBindingMap = new Map()
  const windowGroupMap = new Map()

  function ensureWindowGroupState(normalizedWindowId) {
    let state = windowGroupMap.get(normalizedWindowId)
    if (!state) {
      state = { groupIds: [], focusedGroupId: null, groups: new Map() }
      windowGroupMap.set(normalizedWindowId, state)
    }
    return state
  }

  function ensureGroupState(normalizedWindowId, groupId) {
    const windowState = ensureWindowGroupState(normalizedWindowId)
    let groupState = windowState.groups.get(groupId)
    if (!groupState) {
      groupState = { sessionIds: [], activeSessionId: null }
      windowState.groups.set(groupId, groupState)
      windowState.groupIds.push(groupId)
    }
    if (windowState.focusedGroupId === null) {
      windowState.focusedGroupId = groupId
    }
    return groupState
  }

  function resolveGroupId(normalizedWindowId, groupId) {
    if (groupId !== undefined && groupId !== null) {
      return normalizeGroupId(groupId)
    }
    return windowGroupMap.get(normalizedWindowId)?.focusedGroupId ?? DEFAULT_GROUP_ID
  }

  function readGroupActiveSessionId(groupState) {
    if (!groupState) {
      return null
    }
    return groupState.activeSessionId ?? groupState.sessionIds[0] ?? null
  }

  /**
   * 把聚焦栏的活动会话写回窗口级绑定。
   *
   * `getRegistrySessionId` 只看这一个值，所以每次组内活动标签或聚焦栏变化都必须经过这里。
   */
  function syncSessionBinding(normalizedWindowId) {
    const windowState = windowGroupMap.get(normalizedWindowId)
    const focusedGroupId = windowState?.focusedGroupId
    if (!focusedGroupId) {
      sessionBindingMap.delete(normalizedWindowId)
      return null
    }

    const activeSessionId = readGroupActiveSessionId(windowState.groups.get(focusedGroupId))
    if (activeSessionId) {
      sessionBindingMap.set(normalizedWindowId, activeSessionId)
      return activeSessionId
    }

    sessionBindingMap.delete(normalizedWindowId)
    return null
  }

  function getSessionIds(normalizedWindowId) {
    const windowState = windowGroupMap.get(normalizedWindowId)
    if (!windowState) {
      return []
    }
    return windowState.groupIds.flatMap((groupId) => {
      const groupState = windowState.groups.get(groupId)
      return groupState ? [...groupState.sessionIds] : []
    })
  }

  function removeGroupState(normalizedWindowId, groupId) {
    const windowState = windowGroupMap.get(normalizedWindowId)
    const groupState = windowState?.groups.get(groupId)
    if (!windowState || !groupState) {
      return []
    }

    const removedSessionIds = [...groupState.sessionIds]
    windowState.groups.delete(groupId)
    const index = windowState.groupIds.indexOf(groupId)
    if (index >= 0) {
      windowState.groupIds.splice(index, 1)
    }

    if (windowState.focusedGroupId === groupId) {
      const fallbackIndex = index >= 0
        ? Math.min(index, windowState.groupIds.length - 1)
        : 0
      windowState.focusedGroupId = windowState.groupIds[fallbackIndex] ?? null
    }

    if (windowState.groupIds.length === 0) {
      windowGroupMap.delete(normalizedWindowId)
    }

    syncSessionBinding(normalizedWindowId)
    return removedSessionIds
  }

  function removeSession({ windowId, sessionId }) {
    const normalizedWindowId = normalizeWindowId(windowId)
    assertSessionId(sessionId)
    const windowState = windowGroupMap.get(normalizedWindowId)
    if (!windowState) {
      return false
    }

    let removed = false
    for (const groupId of [...windowState.groupIds]) {
      const groupState = windowState.groups.get(groupId)
      if (!groupState) {
        continue
      }

      const index = groupState.sessionIds.indexOf(sessionId)
      if (index < 0) {
        continue
      }

      groupState.sessionIds.splice(index, 1)
      removed = true
      if (groupState.activeSessionId === sessionId) {
        const fallbackIndex = Math.min(index, groupState.sessionIds.length - 1)
        groupState.activeSessionId = groupState.sessionIds[fallbackIndex] ?? null
      }

      if (groupState.sessionIds.length === 0) {
        removeGroupState(normalizedWindowId, groupId)
      }
      break
    }

    if (!removed) {
      return false
    }

    syncSessionBinding(normalizedWindowId)
    return true
  }

  function addSession({ windowId, sessionId, groupId = null }) {
    const normalizedWindowId = normalizeWindowId(windowId)
    assertSessionId(sessionId)

    if (!windowMap.has(normalizedWindowId)) {
      throw new Error(`windowId 不存在，无法绑定 session: ${normalizedWindowId}`)
    }

    const targetGroupId = resolveGroupId(normalizedWindowId, groupId)
    const groupState = ensureGroupState(normalizedWindowId, targetGroupId)
    if (!groupState.sessionIds.includes(sessionId)) {
      groupState.sessionIds.push(sessionId)
    }
    syncSessionBinding(normalizedWindowId)
    return sessionId
  }

  function activateSession({ windowId, sessionId, groupId = null }) {
    const normalizedWindowId = normalizeWindowId(windowId)
    assertSessionId(sessionId)
    const windowState = windowGroupMap.get(normalizedWindowId)
    if (!windowState) {
      throw new Error(`sessionId 未挂载到该窗口，无法激活: ${sessionId}`)
    }

    // 先按显式 groupId 找，找不到再扫全部栏：标签刚搬栏时调用方可能还传着旧 groupId。
    const preferredGroupId = groupId === undefined || groupId === null
      ? null
      : normalizeGroupId(groupId)
    const candidateGroupIds = preferredGroupId ? [preferredGroupId] : []
    const targetGroupId = [...candidateGroupIds, ...windowState.groupIds]
      .find(id => windowState.groups.get(id)?.sessionIds.includes(sessionId))

    if (!targetGroupId) {
      throw new Error(`sessionId 未挂载到该窗口，无法激活: ${sessionId}`)
    }

    const groupState = windowState.groups.get(targetGroupId)
    groupState.activeSessionId = sessionId
    windowState.focusedGroupId = targetGroupId
    return syncSessionBinding(normalizedWindowId) || sessionId
  }

  return {
    registerWindow({ windowId, win }) {
      const normalizedWindowId = normalizeWindowId(windowId)
      assertWindowReference(win)

      if (windowMap.has(normalizedWindowId)) {
        throw new Error(`windowId 已存在，不能重复注册: ${normalizedWindowId}`)
      }

      if (windowIdByWinMap.has(win)) {
        throw new Error('win 已存在，不能重复注册')
      }

      windowMap.set(normalizedWindowId, win)
      windowIdByWinMap.set(win, normalizedWindowId)
      return win
    },
    unregisterWindow(windowId) {
      const normalizedWindowId = normalizeWindowId(windowId)
      const win = windowMap.get(normalizedWindowId) || null
      const deleted = windowMap.delete(normalizedWindowId)
      if (win) {
        windowIdByWinMap.delete(win)
      }
      sessionBindingMap.delete(normalizedWindowId)
      windowGroupMap.delete(normalizedWindowId)
      return deleted
    },
    /**
     * 把一个会话挂到窗口的某个标签组上（不改变活动会话）。
     *
     * 重复挂载同一个会话不会产生第二个标签；不传 groupId 时落到聚焦栏。
     */
    addSession,
    removeSession,
    activateSession,
    /**
     * 兼容入口：挂载并激活。
     *
     * 单会话时代所有调用点都走这里；多栏落地后它仍然是
     * “新建/打开一个文档并让它成为活动标签”的语义。
     */
    bindSession({ windowId, sessionId, groupId = null }) {
      addSession({ windowId, sessionId, groupId })
      return activateSession({ windowId, sessionId, groupId })
    },
    getWindowById(windowId) {
      return windowMap.get(normalizeWindowId(windowId)) || null
    },
    getSessionIdByWindowId(windowId) {
      return sessionBindingMap.get(normalizeWindowId(windowId)) || null
    },
    getSessionIdsByWindowId(windowId) {
      return getSessionIds(normalizeWindowId(windowId))
    },
    getAllWindows() {
      return Array.from(windowMap.values())
    },

    // ---- 标签组（栏）维度：多栏并排专用的增量接口 ----

    createGroup({ windowId, groupId }) {
      const normalizedWindowId = normalizeWindowId(windowId)
      const normalizedGroupId = normalizeGroupId(groupId)
      ensureGroupState(normalizedWindowId, normalizedGroupId)
      const windowState = windowGroupMap.get(normalizedWindowId)
      windowState.focusedGroupId = normalizedGroupId
      syncSessionBinding(normalizedWindowId)
      return normalizedGroupId
    },
    removeGroup({ windowId, groupId }) {
      const normalizedWindowId = normalizeWindowId(windowId)
      return removeGroupState(normalizedWindowId, normalizeGroupId(groupId))
    },
    activateGroup({ windowId, groupId }) {
      const normalizedWindowId = normalizeWindowId(windowId)
      const normalizedGroupId = normalizeGroupId(groupId)
      const windowState = windowGroupMap.get(normalizedWindowId)
      if (!windowState?.groups.has(normalizedGroupId)) {
        throw new Error(`groupId 未挂载到该窗口，无法聚焦: ${normalizedGroupId}`)
      }
      windowState.focusedGroupId = normalizedGroupId
      syncSessionBinding(normalizedWindowId)
      return normalizedGroupId
    },
    getGroupIdsByWindowId(windowId) {
      const windowState = windowGroupMap.get(normalizeWindowId(windowId))
      return windowState ? [...windowState.groupIds] : []
    },
    getFocusedGroupIdByWindowId(windowId) {
      return windowGroupMap.get(normalizeWindowId(windowId))?.focusedGroupId ?? null
    },
    getSessionIdsByGroupId({ windowId, groupId = null }) {
      const normalizedWindowId = normalizeWindowId(windowId)
      const windowState = windowGroupMap.get(normalizedWindowId)
      const targetGroupId = resolveGroupId(normalizedWindowId, groupId)
      const groupState = windowState?.groups.get(targetGroupId)
      return groupState ? [...groupState.sessionIds] : []
    },
    getActiveSessionIdByGroupId({ windowId, groupId = null }) {
      const normalizedWindowId = normalizeWindowId(windowId)
      const windowState = windowGroupMap.get(normalizedWindowId)
      const targetGroupId = resolveGroupId(normalizedWindowId, groupId)
      return readGroupActiveSessionId(windowState?.groups.get(targetGroupId))
    },
    /**
     * 把一个标签搬到另一栏（同窗口或跨窗口）。
     *
     * 与 store 的语义保持一致：搬家不复制，会话身份不变。
     */
    moveSessionToGroup({ sessionId, windowId, groupId = null }) {
      assertSessionId(sessionId)
      const normalizedWindowId = normalizeWindowId(windowId)
      const targetGroupId = resolveGroupId(normalizedWindowId, groupId)

      // 先把它从任何一栏摘掉（可能是别的窗口），再挂到目标栏
      for (const [ownerWindowId, windowState] of windowGroupMap.entries()) {
        for (const ownerGroupId of [...windowState.groupIds]) {
          if (windowState.groups.get(ownerGroupId)?.sessionIds.includes(sessionId)) {
            removeSession({ windowId: ownerWindowId, sessionId })
          }
        }
      }

      addSession({ windowId: normalizedWindowId, sessionId, groupId: targetGroupId })
      return sessionId
    },
  }
}
