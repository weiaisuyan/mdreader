import { toComparableDocumentPath } from './documentOpenTargetUtil.js'

/**
 * 窗口内默认标签组 id。
 *
 * 单栏窗口只有这一组；多栏窗口的第一组也复用它，
 * 这样 `tab-group.json` 旧文件与所有「不传 groupId」的旧调用点都不用改。
 */
const DEFAULT_GROUP_ID = 'main'

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${fieldName} 必须是非空字符串`)
  }
}

function assertWindowId(windowId) {
  if (typeof windowId === 'number' && Number.isFinite(windowId)) {
    return
  }

  if (typeof windowId === 'string' && windowId.trim() !== '') {
    return
  }

  throw new TypeError('windowId 必须是数字或非空字符串')
}

/**
 * groupId 一律归一成字符串。
 *
 * windowId 在这个 store 里允许数字（Electron 会直接传 BrowserWindow.id），
 * 但 groupId 是纯内部键，混入数字会让 `Map.get` 静默分裂成两份状态，
 * 表现为「有时能切栏、有时不能」，排查成本极高，因此在入口处就收口。
 */
function normalizeGroupId(groupId) {
  if (groupId === undefined || groupId === null) {
    return DEFAULT_GROUP_ID
  }

  assertNonEmptyString(groupId, 'groupId')
  return groupId.trim()
}

/**
 * 创建文档会话 store。
 *
 * 存储分四层：
 * 1. `sessionMap`：全局会话注册表，按 sessionId 索引
 * 2. `windowGroupMap`：窗口持有的标签组（栏）顺序、聚焦组，以及每组内的标签顺序与活动标签
 * 3. `sessionGroupMap`：会话 → 所属 groupId
 * 4. `sessionWindowMap`：会话 → 所属 windowId
 *
 * 一个窗口可以有多栏，每栏是一个标签组，每组各有自己的活动标签；
 * 同一时刻只有一栏是「聚焦栏」，`getSessionByWindowId` /
 * `getActiveSessionIdByWindowId` / `getSessionIdsByWindowId` 这些窗口级入口
 * 一律按「聚焦栏」解释，这样所有按窗口取文档的既有链路不需要改写。
 */
export function createDocumentSessionStore() {
  const sessionMap = new Map()
  const windowGroupMap = new Map()
  const sessionGroupMap = new Map()
  const sessionWindowMap = new Map()

  function getSession(sessionId) {
    return sessionMap.get(sessionId) || null
  }

  function getWindowState(windowId) {
    return windowGroupMap.get(windowId) || null
  }

  function ensureWindowState(windowId) {
    let state = windowGroupMap.get(windowId)
    if (!state) {
      state = { groupIds: [], focusedGroupId: null, groupStates: new Map() }
      windowGroupMap.set(windowId, state)
    }
    return state
  }

  /**
   * 确保窗口里的某个标签组存在。
   *
   * 新组会被追加到栏顺序末尾；窗口原本没有任何组时，它自动成为聚焦栏——
   * 否则窗口会停在「有标签组但没有聚焦栏」的中间态，窗口级入口全部返回 null。
   */
  function ensureGroupState(windowId, groupId, insertAt = null) {
    const windowState = ensureWindowState(windowId)
    let groupState = windowState.groupStates.get(groupId)
    if (!groupState) {
      groupState = { sessionIds: [], activeSessionId: null }
      windowState.groupStates.set(groupId, groupState)
      /**
       * 插入位置：拖拽分栏时新栏要出现在**目标栏的左边或右边**，
       * 而不是永远追加到最右边 —— 否则「拖到中间那栏，松手却跑到最后一栏」。
       *
       * 越界一律回落到追加，避免调用方传错值把栏列表搞乱。
       */
      if (Number.isInteger(insertAt) && insertAt >= 0 && insertAt <= windowState.groupIds.length) {
        windowState.groupIds.splice(insertAt, 0, groupId)
      } else {
        windowState.groupIds.push(groupId)
      }
    }
    if (windowState.focusedGroupId === null) {
      windowState.focusedGroupId = groupId
    }
    return { windowState, groupState }
  }

  /**
   * 决定这次操作落在哪一栏。
   *
   * 显式 groupId 优先；不传时用聚焦栏；窗口还没有任何栏时落到默认组。
   */
  function resolveGroupId({ windowId, groupId }) {
    if (groupId !== undefined && groupId !== null) {
      return normalizeGroupId(groupId)
    }
    const windowState = getWindowState(windowId)
    return windowState?.focusedGroupId ?? DEFAULT_GROUP_ID
  }

  function requireGroupState({ windowId, groupId }) {
    const resolvedGroupId = resolveGroupId({ windowId, groupId })
    const windowState = getWindowState(windowId)
    const groupState = windowState?.groupStates.get(resolvedGroupId) || null
    return { resolvedGroupId, windowState, groupState }
  }

  function getGroupActiveSessionId({ windowId, groupId }) {
    const { resolvedGroupId, windowState } = requireGroupState({ windowId, groupId })
    return readGroupActiveSessionId(windowState, resolvedGroupId)
  }

  /**
   * 把会话从它当前所属的标签组里摘掉。
   *
   * 摘掉的是活动标签时，活动指针交给同组相邻标签：
   * 优先接管原位置上的下一个标签，没有就退到最后一个。
   * 组被摘空则整组消失并把聚焦权交给相邻栏；窗口一组不剩才删掉窗口状态。
   */
  function detachSessionFromWindow(sessionId) {
    const windowId = sessionWindowMap.get(sessionId)
    if (windowId === undefined) {
      return null
    }

    const groupId = sessionGroupMap.get(sessionId)
    sessionWindowMap.delete(sessionId)
    sessionGroupMap.delete(sessionId)

    const windowState = getWindowState(windowId)
    if (!windowState) {
      return windowId
    }

    const groupState = groupId === undefined ? null : windowState.groupStates.get(groupId)
    if (!groupState) {
      return windowId
    }

    const index = groupState.sessionIds.indexOf(sessionId)
    if (index >= 0) {
      groupState.sessionIds.splice(index, 1)
    }

    if (groupState.activeSessionId === sessionId) {
      const fallbackIndex = index >= 0
        ? Math.min(index, groupState.sessionIds.length - 1)
        : 0
      groupState.activeSessionId = groupState.sessionIds[fallbackIndex] ?? null
    }

    if (groupState.sessionIds.length === 0) {
      removeGroupState(windowId, groupId)
    }

    return windowId
  }

  /**
   * 移除一个标签组的记账信息（不销毁会话）。
   *
   * 聚焦栏被移除时，聚焦权顺延到原位置上的下一栏，没有就退到最后一栏。
   */
  function removeGroupState(windowId, groupId) {
    const windowState = getWindowState(windowId)
    if (!windowState) {
      return []
    }

    const groupState = windowState.groupStates.get(groupId)
    if (!groupState) {
      return []
    }

    const removedSessionIds = [...groupState.sessionIds]
    windowState.groupStates.delete(groupId)
    const index = windowState.groupIds.indexOf(groupId)
    if (index >= 0) {
      windowState.groupIds.splice(index, 1)
    }

    for (const sessionId of removedSessionIds) {
      sessionGroupMap.delete(sessionId)
      sessionWindowMap.delete(sessionId)
    }

    if (windowState.focusedGroupId === groupId) {
      const fallbackIndex = index >= 0
        ? Math.min(index, windowState.groupIds.length - 1)
        : 0
      windowState.focusedGroupId = windowState.groupIds[fallbackIndex] ?? null
    }

    if (windowState.groupIds.length === 0) {
      windowGroupMap.delete(windowId)
    }

    return removedSessionIds
  }

  /**
   * 把一个已注册的会话挂到窗口的某个标签组上。
   *
   * `index` 可选，用于在组内指定位置插入（例如拖拽排序或恢复顺序）；
   * 不传时追加到组末尾。`groupId` 不传时落到聚焦栏。
   * 重复挂载同一个会话不会产生第二个标签。
   */
  function addSessionToWindow({ windowId, sessionId, index = null, groupId = null }) {
    // 这里不能把 windowId 限死为字符串。
    // Electron 主链路会直接传 BrowserWindow.id，它本身就是数字；
    // store 只需要把它当作稳定键值保存，不应该在这里引入额外的类型收窄。
    assertWindowId(windowId)
    assertNonEmptyString(sessionId, 'sessionId')
    if (!sessionMap.has(sessionId)) {
      throw new Error(`sessionId 不存在，无法挂载到窗口: ${sessionId}`)
    }

    const ownerWindowId = sessionWindowMap.get(sessionId)
    if (ownerWindowId !== undefined && ownerWindowId !== windowId) {
      throw new Error(`sessionId 已属于其他窗口，不能重复挂载: ${sessionId}`)
    }

    const targetGroupId = resolveGroupId({ windowId, groupId })
    const { groupState } = ensureGroupState(windowId, targetGroupId)

    if (!groupState.sessionIds.includes(sessionId)) {
      const canInsert = Number.isInteger(index) && index >= 0 && index <= groupState.sessionIds.length
      if (canInsert) {
        groupState.sessionIds.splice(index, 0, sessionId)
      }
      else {
        groupState.sessionIds.push(sessionId)
      }
    }
    sessionGroupMap.set(sessionId, targetGroupId)
    sessionWindowMap.set(sessionId, windowId)
    return getSession(sessionId)
  }

  function activateSession({ windowId, sessionId }) {
    assertWindowId(windowId)
    assertNonEmptyString(sessionId, 'sessionId')
    if (sessionWindowMap.get(sessionId) !== windowId) {
      throw new Error(`sessionId 未挂载到该窗口，无法激活: ${sessionId}`)
    }

    const groupId = sessionGroupMap.get(sessionId)
    const windowState = getWindowState(windowId)
    const groupState = groupId === undefined ? null : windowState?.groupStates.get(groupId)
    if (!groupState || !groupState.sessionIds.includes(sessionId)) {
      throw new Error(`sessionId 未挂载到该窗口，无法激活: ${sessionId}`)
    }

    groupState.activeSessionId = sessionId
    // 激活某个标签 = 把焦点交给它所在的栏（Obsidian 的行为，也是唯一不会让
    // 「快照说 A 栏、registry 说 B 栏」的自洽规则）。
    windowState.focusedGroupId = groupId
    return getSession(sessionId)
  }

  function getSessionIdsByWindowId(windowId) {
    const windowState = getWindowState(windowId)
    if (!windowState) {
      return []
    }

    return windowState.groupIds.flatMap((groupId) => {
      const groupState = windowState.groupStates.get(groupId)
      return groupState ? [...groupState.sessionIds] : []
    })
  }

  /**
   * 组内活动会话。
   *
   * 组内没有活动标签时退回组内第一个标签：多栏下「切到某栏却看不到任何文档」
   * 只会让用户以为栏坏了，退让一个可见标签比返回 null 更安全。
   */
  function readGroupActiveSessionId(windowState, groupId) {
    const groupState = windowState?.groupStates.get(groupId)
    if (!groupState) {
      return null
    }
    return groupState.activeSessionId ?? groupState.sessionIds[0] ?? null
  }

  /**
   * 窗口级活动会话 = 聚焦栏的活动会话。
   *
   * 聚焦栏是刚拆出来的空栏时，退到第一个有文档的栏：窗口级入口被标题、文件管理器、
   * 目录监听等十几条链路共用，返回 null 会让它们整体失效（表现为整窗没标题、
   * 文件树空白、监听丢失），比「读到邻栏文档」的错误代价大得多。
   */
  function readWindowLevelActiveSessionId(windowState) {
    if (!windowState) {
      return null
    }

    const focusedActiveSessionId = readGroupActiveSessionId(windowState, windowState.focusedGroupId)
    if (focusedActiveSessionId) {
      return focusedActiveSessionId
    }

    for (const groupId of windowState.groupIds) {
      const activeSessionId = readGroupActiveSessionId(windowState, groupId)
      if (activeSessionId) {
        return activeSessionId
      }
    }

    return null
  }

  return {
    createSession(session) {
      assertNonEmptyString(session?.sessionId, 'session.sessionId')
      if (sessionMap.has(session.sessionId)) {
        throw new Error(`sessionId 已存在，不能重复注册: ${session.sessionId}`)
      }
      sessionMap.set(session.sessionId, session)
      return session
    },
    replaceSession(session) {
      assertNonEmptyString(session?.sessionId, 'session.sessionId')
      if (!sessionMap.has(session.sessionId)) {
        throw new Error(`sessionId 不存在，无法替换: ${session.sessionId}`)
      }
      sessionMap.set(session.sessionId, session)
      return session
    },
    destroySession(sessionId) {
      assertNonEmptyString(sessionId, 'sessionId')
      detachSessionFromWindow(sessionId)
      return sessionMap.delete(sessionId)
    },
    addSessionToWindow,
    activateSession,
    getSessionIdsByWindowId,
    removeSessionFromWindow({ windowId, sessionId }) {
      assertWindowId(windowId)
      assertNonEmptyString(sessionId, 'sessionId')
      if (sessionWindowMap.get(sessionId) !== windowId) {
        return false
      }
      detachSessionFromWindow(sessionId)
      return true
    },
    /**
     * 兼容入口：绑定窗口与会话，等价于“挂到聚焦栏末尾并激活”。
     *
     * 单会话时代所有调用点都走这里；多栏落地后它仍然是
     * “新建/打开一个文档并让它成为活动标签”的语义。
     */
    bindWindowToSession({ windowId, sessionId, groupId = null }) {
      addSessionToWindow({ windowId, sessionId, groupId })
      return activateSession({ windowId, sessionId })
    },
    reorderWindowSessions({ windowId, sessionIds }) {
      assertWindowId(windowId)
      if (!Array.isArray(sessionIds)) {
        throw new TypeError('sessionIds 必须是数组')
      }
      const windowState = getWindowState(windowId)
      if (!windowState) {
        return []
      }
      const current = getSessionIdsByWindowId(windowId)
      const isSameSet = sessionIds.length === current.length
        && new Set(sessionIds).size === sessionIds.length
        && sessionIds.every(sessionId => current.includes(sessionId))
      if (!isSameSet) {
        throw new Error('reorderWindowSessions 要求 sessionIds 与当前标签集合一致')
      }

      // 窗口级重排只调顺序、不跨栏搬迁：按各栏现有标签数依次切片写回，
      // 这样「整窗重排」不会悄悄把某个标签挪进另一栏。
      let cursor = 0
      for (const groupId of windowState.groupIds) {
        const groupState = windowState.groupStates.get(groupId)
        if (!groupState) {
          continue
        }
        const size = groupState.sessionIds.length
        groupState.sessionIds = sessionIds.slice(cursor, cursor + size)
        cursor += size
      }

      return getSessionIdsByWindowId(windowId)
    },
    getSessionByWindowId(windowId) {
      assertWindowId(windowId)
      const activeSessionId = readWindowLevelActiveSessionId(getWindowState(windowId))
      return activeSessionId ? getSession(activeSessionId) : null
    },
    getActiveSessionIdByWindowId(windowId) {
      return readWindowLevelActiveSessionId(getWindowState(windowId))
    },
    getSessionsByWindowId(windowId) {
      return getSessionIdsByWindowId(windowId)
        .map(sessionId => getSession(sessionId))
        .filter(Boolean)
    },
    getWindowIdBySessionId(sessionId) {
      return sessionWindowMap.get(sessionId) ?? null
    },
    findSessionByComparablePath(targetPath) {
      const comparablePath = toComparableDocumentPath(targetPath)
      if (!comparablePath) {
        return null
      }

      for (const session of sessionMap.values()) {
        const sessionPath = toComparableDocumentPath(session?.documentSource?.path || null)
        if (sessionPath && sessionPath === comparablePath) {
          return session
        }
      }

      return null
    },
    getSession,

    // ---- 标签组（栏）维度：多栏并排专用的增量接口 ----

    /**
     * 在窗口里新建一个空标签组并聚焦它。
     *
     * 已存在同名组时不重复创建，只把它设为聚焦栏——
     * 恢复布局时「先建组再往里放标签」和「标签先到、组后建」都会走到这里。
     */
    createGroup({ windowId, groupId, insertAt = null }) {
      assertWindowId(windowId)
      const normalizedGroupId = normalizeGroupId(groupId)
      const { windowState } = ensureGroupState(windowId, normalizedGroupId, insertAt)
      windowState.focusedGroupId = normalizedGroupId
      return normalizedGroupId
    },
    getGroupIdsByWindowId(windowId) {
      const windowState = getWindowState(windowId)
      return windowState ? [...windowState.groupIds] : []
    },
    getFocusedGroupIdByWindowId(windowId) {
      return getWindowState(windowId)?.focusedGroupId ?? null
    },
    activateGroup({ windowId, groupId }) {
      assertWindowId(windowId)
      const normalizedGroupId = normalizeGroupId(groupId)
      const windowState = getWindowState(windowId)
      if (!windowState?.groupStates.has(normalizedGroupId)) {
        throw new Error(`groupId 未挂载到该窗口，无法聚焦: ${normalizedGroupId}`)
      }
      windowState.focusedGroupId = normalizedGroupId
      return normalizedGroupId
    },
    getGroupIdBySessionId(sessionId) {
      return sessionGroupMap.get(sessionId) ?? null
    },
    getSessionIdsByGroupId({ windowId, groupId = null }) {
      const windowState = getWindowState(windowId)
      const { groupState } = requireGroupState({ windowId, groupId })
      if (!windowState || !groupState) {
        return []
      }
      return [...groupState.sessionIds]
    },
    getActiveSessionIdByGroupId({ windowId, groupId = null }) {
      return getGroupActiveSessionId({ windowId, groupId })
    },
    getSessionByGroupId({ windowId, groupId = null }) {
      const activeSessionId = getGroupActiveSessionId({ windowId, groupId })
      return activeSessionId ? getSession(activeSessionId) : null
    },
    /**
     * 把一个标签搬到另一栏（同窗口或跨窗口）。
     *
     * 语义是「搬家」而不是「复制」：会话仍是同一个会话，正文、脏态、保存态都不变，
     * 改变的只有它属于哪一栏、在第几个位置。
     */
    moveSessionToGroup({ sessionId, windowId, groupId = null, index = null }) {
      assertWindowId(windowId)
      assertNonEmptyString(sessionId, 'sessionId')
      if (!sessionMap.has(sessionId)) {
        throw new Error(`sessionId 不存在，无法移动到标签组: ${sessionId}`)
      }

      const targetGroupId = resolveGroupId({ windowId, groupId })
      detachSessionFromWindow(sessionId)
      addSessionToWindow({ windowId, sessionId, index, groupId: targetGroupId })
      return getSession(sessionId)
    },
    /**
     * 移除整栏的记账信息，返回被移出的会话 id。
     *
     * 只摘除归属关系，不销毁会话：销毁与否由生命周期层决定
     * （关窗时还要先走未保存裁决）。
     */
    removeGroupFromWindow({ windowId, groupId }) {
      assertWindowId(windowId)
      return removeGroupState(windowId, normalizeGroupId(groupId))
    },
    reorderGroupSessions({ windowId, groupId = null, sessionIds }) {
      assertWindowId(windowId)
      if (!Array.isArray(sessionIds)) {
        throw new TypeError('sessionIds 必须是数组')
      }
      const { groupState } = requireGroupState({ windowId, groupId })
      if (!groupState) {
        return []
      }
      const current = groupState.sessionIds
      const isSameSet = sessionIds.length === current.length
        && new Set(sessionIds).size === sessionIds.length
        && sessionIds.every(sessionId => current.includes(sessionId))
      if (!isSameSet) {
        throw new Error('reorderGroupSessions 要求 sessionIds 与该栏标签集合一致')
      }
      groupState.sessionIds = [...sessionIds]
      return [...groupState.sessionIds]
    },
    /**
     * 取整个窗口的分栏视图，供快照投影使用。
     *
     * 返回顺序即栏顺序；`focusedGroupId` 用来决定哪一栏是「窗口级入口」。
     */
    getWindowGroupSnapshotState(windowId) {
      const windowState = getWindowState(windowId)
      if (!windowState) {
        return { focusedGroupId: null, groups: [] }
      }

      const groups = windowState.groupIds.map((groupId) => {
        const groupState = windowState.groupStates.get(groupId)
        return {
          groupId,
          sessionIds: groupState ? [...groupState.sessionIds] : [],
          activeSessionId: readGroupActiveSessionId(windowState, groupId),
        }
      })

      return { focusedGroupId: windowState.focusedGroupId, groups }
    },
  }
}

export default {
  createDocumentSessionStore,
  DEFAULT_GROUP_ID,
}
