import path from 'node:path'
import fsExtra from 'fs-extra'
import { USER_DATA_SUBDIR } from './userDataPathConstants.js'

// 旧版本把用户数据统一写在 `文档/wj-markdown-editor` 下，
// 迁移目标目录由 resolveUserDataDir 决定（生产态即 app.getPath('userData')/data）。
const LEGACY_DIR_NAME = 'wj-markdown-editor'
const MIGRATION_MARKER = '.migrated-from-documents'
const SESSION_STATE_CLEANUP_MARKER = '.migrated-session-state-cleared'
// 只迁移「用户设置」类数据。
// recent.json / tab-group.json 记录的是上一次会话打开过哪些文档，
// 属于会话状态而不是用户设置：把它们搬过来，等于让新装的应用一启动
// 就自动打开旧机器上的个人笔记，顺带把用户的私人目录暴露在窗口标题上。
const MIGRATABLE_FILE_NAMES = new Set(['config.json'])
const SESSION_STATE_FILE_NAMES = ['recent.json', 'tab-group.json']
const MIGRATABLE_DIR_NAMES = new Set(['logs'])
const CORRUPTED_CONFIG_FILE_PATTERN = /^config\.corrupted\..+\.json$/

export { MIGRATION_MARKER, SESSION_STATE_CLEANUP_MARKER }

function isMigratableEntry(entryName) {
  return MIGRATABLE_FILE_NAMES.has(entryName)
    || MIGRATABLE_DIR_NAMES.has(entryName)
    || CORRUPTED_CONFIG_FILE_PATTERN.test(entryName)
}

export function resolveLegacyUserDataDir({ app }) {
  return path.resolve(app.getPath('documents'), LEGACY_DIR_NAME)
}

/**
 * 清理旧版本遗留在数据目录里的会话状态（最近文件、标签组）。
 *
 * 1.0.1 及更早的迁移逻辑会把 recent.json / tab-group.json 一起搬进新数据目录，
 * 导致「装完第一次启动就自动恢复上次的标签页」。1.0.2 起不再迁移这两个文件，
 * 但对已经用旧版本迁移过的安装，必须一次性清掉，否则升级后照样会恢复旧标签。
 *
 * 用独立 marker 保证只清一次：用户之后正常使用产生的标签组不会被误删。
 */
export async function clearMigratedSessionState({
  fs = fsExtra,
  targetDir,
  logger = console,
}) {
  const normalizedTargetDir = path.resolve(targetDir)
  const cleanupMarkerPath = path.join(normalizedTargetDir, SESSION_STATE_CLEANUP_MARKER)
  if (await fs.pathExists(cleanupMarkerPath)) {
    return { status: 'already-cleared', removedEntries: [] }
  }

  const removedEntries = []
  for (const entryName of SESSION_STATE_FILE_NAMES) {
    const entryPath = path.join(normalizedTargetDir, entryName)
    try {
      if (await fs.pathExists(entryPath)) {
        await fs.remove(entryPath)
        removedEntries.push(entryName)
      }
    }
    catch (error) {
      // 清理失败不能阻塞启动，最多是这一次仍然恢复旧标签。
      logger.warn?.('[migration] 清理遗留会话状态失败:', entryName, error)
    }
  }

  await fs.ensureDir(normalizedTargetDir)
  await fs.writeFile(cleanupMarkerPath, new Date().toISOString(), 'utf-8')
  if (removedEntries.length > 0) {
    logger.info?.('[migration] 已清理旧版本遗留的会话状态:', removedEntries)
  }
  return { status: 'cleared', removedEntries }
}

/**
 * 把旧文档目录下的用户数据迁移到新的用户数据目录。
 *
 * 约定：
 * 1. 目标目录已有同名条目时以目标为准，不覆盖（新目录的数据更新）
 * 2. 全部条目处理成功后才写 marker；失败不写，下次启动重试
 * 3. marker 存在时不再回看旧目录，避免用户删掉新配置后旧文件“复活”
 * 4. 迁移成功后删除旧目录，同一份配置不允许存在两个位置
 * 5. 会话状态（recent.json / tab-group.json）不迁移，并清理旧版本已迁移的残留
 */
export async function migrateLegacyUserData({
  app,
  fs = fsExtra,
  targetDir,
  logger = console,
}) {
  const normalizedTargetDir = path.resolve(targetDir)
  const legacyDir = resolveLegacyUserDataDir({ app })

  // 开发态目标就是应用目录下的 data 子目录；目标与旧目录重合时也不存在迁移意义。
  if (legacyDir === normalizedTargetDir || path.resolve(app.getAppPath(), USER_DATA_SUBDIR) === normalizedTargetDir) {
    return { status: 'skipped' }
  }

  // 必须在 initTabGroup / initRecent 之前完成：它们读盘时就认这一次结果。
  const sessionStateCleanup = await clearMigratedSessionState({
    fs,
    targetDir: normalizedTargetDir,
    logger,
  })

  const markerPath = path.join(normalizedTargetDir, MIGRATION_MARKER)
  if (await fs.pathExists(markerPath)) {
    return { status: 'already-migrated', sessionState: sessionStateCleanup.status }
  }

  if (!await fs.pathExists(legacyDir)) {
    await writeMigrationMarker()
    return { status: 'no-legacy-data', sessionState: sessionStateCleanup.status }
  }

  const migratedEntries = []
  try {
    const legacyEntries = await fs.readdir(legacyDir)
    for (const entryName of legacyEntries) {
      if (!isMigratableEntry(entryName)) {
        continue
      }

      const sourcePath = path.join(legacyDir, entryName)
      const targetPath = path.join(normalizedTargetDir, entryName)
      const isDirectoryEntry = MIGRATABLE_DIR_NAMES.has(entryName)
      if (!isDirectoryEntry && await fs.pathExists(targetPath)) {
        continue
      }

      await fs.ensureDir(normalizedTargetDir)
      await fs.copy(sourcePath, targetPath, { overwrite: false, errorOnExist: false })
      migratedEntries.push(entryName)
    }

    await writeMigrationMarker()
  }
  catch (error) {
    // 迁移失败不写 marker，旧目录保持原样，下次启动重试。
    logger.error?.('[migration] 旧用户数据迁移失败，下次启动重试:', error)
    return { status: 'failed', error }
  }

  try {
    await fs.remove(legacyDir)
  }
  catch (error) {
    // 清理失败不影响迁移结果，旧目录最多留一份副本。
    logger.warn?.('[migration] 旧用户数据目录清理失败:', error)
  }

  logger.info?.('[migration] 已迁移旧用户数据:', migratedEntries)
  return { status: 'migrated', migratedEntries, sessionState: sessionStateCleanup.status }

  async function writeMigrationMarker() {
    await fs.ensureDir(normalizedTargetDir)
    await fs.writeFile(markerPath, new Date().toISOString(), 'utf-8')
  }
}
