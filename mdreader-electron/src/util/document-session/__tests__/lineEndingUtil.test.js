import { describe, expect, it } from 'vitest'
import { createBoundFileSession, createDraftSession } from '../documentSessionFactory.js'
import { deriveDocumentSnapshot } from '../documentSnapshotUtil.js'
import { applyLineEnding, detectLineEnding } from '../lineEndingUtil.js'

describe('lineEndingUtil', () => {
  it('detectLineEnding 应识别 CRLF / LF / 空串', () => {
    expect(detectLineEnding('')).toBe('lf')
    expect(detectLineEnding('a\nb\n')).toBe('lf')
    expect(detectLineEnding('a\r\nb\r\n')).toBe('crlf')
    // 老式单独 \r 换行也归到 crlf，避免写回时被拆成两个字符
    expect(detectLineEnding('a\rb')).toBe('crlf')
    expect(detectLineEnding(null)).toBe('lf')
  })

  it('applyLineEnding 应在两种风格之间无损转换且幂等', () => {
    expect(applyLineEnding('a\nb', 'crlf')).toBe('a\r\nb')
    expect(applyLineEnding('a\r\nb', 'lf')).toBe('a\nb')
    expect(applyLineEnding('a\rb', 'lf')).toBe('a\nb')
    expect(applyLineEnding('a\nb', 'lf')).toBe('a\nb')
    const once = applyLineEnding('a\r\nb\nc', 'crlf')
    expect(applyLineEnding(once, 'crlf')).toBe(once)
    // 非字符串输入统一收敛成空串，避免命令层收到 null 时炸掉
    expect(applyLineEnding(null, 'crlf')).toBe('')
  })
})

describe('cRLF 文件不应因为换行风格被误判为脏', () => {
  const crlfDiskContent = '# 标题\r\n\r\n第一段\r\n\r\n第二段\r\n'
  const lfEditorContent = '# 标题\n\n第一段\n\n第二段\n'

  it('磁盘是 CRLF：渲染层按 LF 回传后，按磁盘风格展开应与基线一致', () => {
    const session = createBoundFileSession({
      sessionId: 'crlf-session',
      path: 'C:/docs/crlf.md',
      content: crlfDiskContent,
    })

    expect(session.diskSnapshot.lineEnding).toBe('crlf')
    // 刚打开时编辑器快照就是磁盘原文，不应脏
    expect(deriveDocumentSnapshot(session).dirty).toBe(false)

    // 模拟命令层收到渲染层用 LF 回传的全文（编辑器内部总是 LF）
    session.editorSnapshot.content = applyLineEnding(
      lfEditorContent,
      session.diskSnapshot.lineEnding,
    )
    session.editorSnapshot.revision = 1

    const snapshot = deriveDocumentSnapshot(session)
    expect(snapshot.dirty).toBe(false)
    expect(snapshot.saved).toBe(true)
    // 保存时要写回的内容仍是 CRLF，用户文件换行风格不被改变
    expect(snapshot.content).toBe(crlfDiskContent)
  })

  it('lF 文件与草稿不受影响', () => {
    const lfSession = createBoundFileSession({
      sessionId: 'lf-session',
      path: 'C:/docs/lf.md',
      content: lfEditorContent,
    })
    expect(lfSession.diskSnapshot.lineEnding).toBe('lf')
    lfSession.editorSnapshot.content = applyLineEnding(lfEditorContent, lfSession.diskSnapshot.lineEnding)
    expect(deriveDocumentSnapshot(lfSession).dirty).toBe(false)

    const draft = createDraftSession({ sessionId: 'draft-session' })
    expect(draft.diskSnapshot.lineEnding).toBe('lf')
    draft.editorSnapshot.content = applyLineEnding('', draft.diskSnapshot.lineEnding)
    expect(deriveDocumentSnapshot(draft).dirty).toBe(false)
  })

  it('真正改动的内容仍然要判定为脏', () => {
    const session = createBoundFileSession({
      sessionId: 'edit-session',
      path: 'C:/docs/crlf.md',
      content: crlfDiskContent,
    })
    session.editorSnapshot.content = applyLineEnding(
      '# 标题\n\n第一段（改过）\n\n第二段\n',
      session.diskSnapshot.lineEnding,
    )
    session.editorSnapshot.revision = 1
    expect(deriveDocumentSnapshot(session).dirty).toBe(true)
  })
})
