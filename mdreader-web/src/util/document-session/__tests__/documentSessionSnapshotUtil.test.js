import assert from 'node:assert/strict'

import {
  createDefaultExternalFileChangeState,
  deriveDocumentSessionStoreState,
  getDocumentSessionSnapshotIdentity,
  normalizeDocumentSessionSnapshot,
} from '../documentSessionSnapshotUtil.js'

const { test } = await import('node:test')

test('recent-missing 快照应只保留当前 store 仍在消费的派生字段，展示路径等细节继续留在 snapshot 真相里', () => {
  const storeState = deriveDocumentSessionStoreState({
    revision: 2,
    sessionId: 'session-1',
    content: '# current',
    fileName: 'Untitled',
    displayPath: 'C:/docs/missing.md',
    recentMissingPath: 'C:/docs/missing.md',
    windowTitle: 'wj-markdown-editor',
    saved: false,
    dirty: true,
    exists: false,
    isRecentMissing: true,
    closePrompt: {
      visible: true,
      reason: 'unsaved-changes',
      allowForceClose: true,
    },
    externalPrompt: {
      visible: true,
      version: 3,
      fileName: 'Untitled',
      localContent: '# local',
      externalContent: '# disk',
    },
    resourceContext: {
      documentPath: null,
      saved: false,
      exists: false,
    },
  })

  assert.equal(storeState.fileName, 'Untitled')
  assert.equal(storeState.saved, false)
  assert.equal('displayPath' in storeState, false)
  assert.equal('recentMissingPath' in storeState, false)
  assert.equal('exists' in storeState, false)
  assert.equal('closePrompt' in storeState, false)
  assert.equal('closePromptVisible' in storeState, false)
  assert.equal('externalPromptVisible' in storeState, false)
  assert.equal(storeState.externalFileChange.visible, true)
  assert.equal(storeState.documentSessionSnapshot.recentMissingPath, 'C:/docs/missing.md')
  assert.equal(storeState.documentSessionSnapshot.displayPath, 'C:/docs/missing.md')
  assert.deepEqual(storeState.documentSessionSnapshot.closePrompt, {
    visible: true,
    reason: 'unsaved-changes',
    allowForceClose: true,
    scope: 'window',
    unsavedTabCount: 0,
  })
  assert.equal(storeState.documentSessionSnapshot.revision, 2)
})

test('外部修改 prompt 为同一版本时应保留 loading，新版本则必须重置 loading', () => {
  const currentExternalFileChange = {
    ...createDefaultExternalFileChangeState(),
    visible: true,
    loading: true,
    fileName: 'note.md',
    version: 7,
    localContent: '# local',
    externalContent: '# old-disk',
  }

  const sameVersionState = deriveDocumentSessionStoreState({
    sessionId: 'session-2',
    content: '# local',
    fileName: 'note.md',
    displayPath: 'C:/docs/note.md',
    recentMissingPath: null,
    windowTitle: 'note.md',
    saved: false,
    dirty: true,
    exists: true,
    isRecentMissing: false,
    closePrompt: null,
    externalPrompt: {
      visible: true,
      version: 7,
      fileName: 'note.md',
      localContent: '# local',
      externalContent: '# old-disk',
    },
    resourceContext: {
      documentPath: 'C:/docs/note.md',
      saved: false,
      exists: true,
    },
  }, currentExternalFileChange)

  const nextVersionState = deriveDocumentSessionStoreState({
    sessionId: 'session-2',
    content: '# local',
    fileName: 'note.md',
    displayPath: 'C:/docs/note.md',
    recentMissingPath: null,
    windowTitle: 'note.md',
    saved: false,
    dirty: true,
    exists: true,
    isRecentMissing: false,
    closePrompt: null,
    externalPrompt: {
      visible: true,
      version: 8,
      fileName: 'note.md',
      localContent: '# local',
      externalContent: '# new-disk',
    },
    resourceContext: {
      documentPath: 'C:/docs/note.md',
      saved: false,
      exists: true,
    },
  }, currentExternalFileChange)

  assert.equal(sameVersionState.externalFileChange.loading, true)
  assert.equal(nextVersionState.externalFileChange.loading, false)
  assert.equal(nextVersionState.externalFileChange.version, 8)
})

test('normalizeDocumentSessionSnapshot 会把 revision 恢复成有效值', () => {
  assert.equal(normalizeDocumentSessionSnapshot({ revision: 'nope' }).revision, 0)
  assert.equal(normalizeDocumentSessionSnapshot({ revision: -1 }).revision, 0)
  assert.equal(normalizeDocumentSessionSnapshot({ revision: 5 }).revision, 5)
})

test('缺省快照也应被归一化为稳定结构，避免 renderer 再自行拼默认值', () => {
  const snapshot = normalizeDocumentSessionSnapshot(null)

  assert.deepEqual(snapshot, {
    sessionId: null,
    kind: 'markdown',
    content: '',
    fileName: 'Untitled',
    displayPath: null,
    recentMissingPath: null,
    windowTitle: 'wj-markdown-editor',
    saved: true,
    dirty: false,
    exists: false,
    isRecentMissing: false,
    tabs: [],
    activeSessionId: null,
    // 多栏信息在单栏窗口恒为 null：主进程单栏不下发 groups，
    // 渲染层据此走「一份快照就是一栏」的老路径。
    activeGroupId: null,
    groups: null,
    closePrompt: null,
    externalPrompt: null,
    revision: 0,
    resourceContext: {
      documentPath: null,
      saved: true,
      exists: false,
    },
  })
})

test('标签归一化必须保留 fileMissing 与 hasPendingExternalChange，否则标签栏拿不到文件状态', () => {
  const snapshot = normalizeDocumentSessionSnapshot({
    sessionId: 'session-9',
    fileName: 'deleted.md',
    tabs: [
      {
        sessionId: 'session-9',
        fileName: 'deleted.md',
        displayPath: 'C:/docs/deleted.md',
        dirty: true,
        fileMissing: true,
        hasPendingExternalChange: true,
      },
      {
        sessionId: 'session-10',
        fileName: 'alive.md',
        displayPath: 'C:/docs/alive.md',
        dirty: false,
        fileMissing: false,
        hasPendingExternalChange: true,
      },
      // 旧快照没有这些字段时必须收敛成 false，不能被当成“已缺失”或“有未决变更”。
      { sessionId: 'session-11', fileName: 'legacy.md' },
    ],
  })

  assert.equal(snapshot.tabs[0].fileMissing, true)
  assert.equal(snapshot.tabs[1].fileMissing, false)
  assert.equal(snapshot.tabs[2].fileMissing, false)
  assert.equal(snapshot.tabs[0].hasPendingExternalChange, true)
  assert.equal(snapshot.tabs[1].hasPendingExternalChange, true)
  assert.equal(snapshot.tabs[2].hasPendingExternalChange, false)
  assert.deepEqual(Object.keys(snapshot.tabs[0]).sort(), [
    'dirty',
    'displayPath',
    'fileMissing',
    'fileName',
    'hasPendingExternalChange',
    'isRecentMissing',
    'kind',
    'sessionId',
  ])
})

test('getDocumentSessionSnapshotIdentity 会统一提取 sessionId 与 revision，非法 revision 回退为 0', () => {
  assert.deepEqual(getDocumentSessionSnapshotIdentity({
    sessionId: 'session-8',
    revision: 12,
  }), {
    sessionId: 'session-8',
    revision: 12,
  })

  assert.deepEqual(getDocumentSessionSnapshotIdentity({
    sessionId: null,
    revision: 'nope',
  }), {
    sessionId: null,
    revision: 0,
  })

  assert.deepEqual(getDocumentSessionSnapshotIdentity(undefined), {
    sessionId: null,
    revision: 0,
  })
})

test('多栏快照必须保留每一栏自己的标签与正文，否则多栏只会在主进程里存在', () => {
  const snapshot = normalizeDocumentSessionSnapshot({
    sessionId: 'session-left',
    activeSessionId: 'session-left',
    activeGroupId: 'group-2',
    groups: [
      {
        groupId: 'main',
        activeSessionId: 'session-left',
        tabs: [{ sessionId: 'session-left', fileName: 'left.md' }],
        snapshot: { sessionId: 'session-left', content: '# left' },
      },
      {
        groupId: 'group-2',
        activeSessionId: null,
        tabs: [],
        snapshot: null,
      },
    ],
  })

  assert.equal(snapshot.activeGroupId, 'group-2')
  assert.deepEqual(snapshot.groups.map(group => group.groupId), ['main', 'group-2'])
  assert.equal(snapshot.groups[0].snapshot.content, '# left')
  assert.equal(snapshot.groups[0].tabs[0].fileName, 'left.md')
  // 空栏的正文快照保持 null：渲染层据此显示空态，而不是借用隔壁正文。
  assert.equal(snapshot.groups[1].snapshot, null)
  assert.deepEqual(snapshot.groups[1].tabs, [])
})

test('单栏快照不带分栏信息时，分组字段归一成 null 而不是空数组', () => {
  const snapshot = normalizeDocumentSessionSnapshot({
    sessionId: 'session-1',
    tabs: [],
    groups: [],
  })

  assert.equal(snapshot.groups, null)
  assert.equal(snapshot.activeGroupId, null)
})
