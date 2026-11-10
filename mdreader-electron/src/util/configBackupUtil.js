import path from 'node:path'
import { app, dialog } from 'electron'
import fsExtra from 'fs-extra'
import { repairConfig } from '../data/config/configRepairUtil.js'
import { validateConfigShape } from '../data/config/configSchema.js'
import configUtil from '../data/configUtil.js'
import defaultConfig from '../data/defaultConfig.js'

/**
 * 配置备份：只导出/导入应用设置本身（config.json 的内容）。
 *
 * 明确边界（用户红线）：
 * - 不包含 recent.json（最近打开的文件列表）、tab-group.json（上次的标签页）与 logs 日志，
 *   这三者都带用户的笔记路径；
 * - 不扫描工作目录，不读取任何 Markdown 文件；
 * - 备份文件里只有 config 一棵设置树，导入时也只会写回 config.json。
 */

export const CONFIG_BACKUP_FORMAT = 'mdreader-config-backup'
export const CONFIG_BACKUP_FORMAT_VERSION = 1
export const CONFIG_BACKUP_APP_NAME = 'mdreader'
export const CONFIG_BACKUP_FILE_EXTENSION = 'json'

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function createBackupError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

/**
 * 组装备份文件内容。
 *
 * @param {object} options
 * @param {object} options.config 当前应用配置（configUtil.getConfig() 的返回值）。
 * @param {string} [options.appVersion] 导出时应用版本，仅作溯源信息。
 * @param {string} [options.exportedAt] 导出时间，ISO 字符串。
 * @returns {object} 可直接序列化的备份文档。
 */
export function createConfigBackupDocument({ config, appVersion = '', exportedAt = new Date().toISOString() }) {
  if (!isPlainObject(config)) {
    throw createBackupError('config-backup-config-missing')
  }

  return {
    format: CONFIG_BACKUP_FORMAT,
    formatVersion: CONFIG_BACKUP_FORMAT_VERSION,
    app: CONFIG_BACKUP_APP_NAME,
    appVersion: typeof appVersion === 'string' ? appVersion : '',
    exportedAt: typeof exportedAt === 'string' ? exportedAt : new Date().toISOString(),
    config: cloneJson(config),
  }
}

export function serializeConfigBackup(backupDocument) {
  // 末尾补换行，方便用户用编辑器打开时正常显示，也便于 git diff。
  return `${JSON.stringify(backupDocument, null, 2)}\n`
}

/**
 * 解析并校验备份文件文本。
 *
 * @param {string} rawText 备份文件内容。
 * @returns {{ appVersion: string, exportedAt: string, config: object }} 解析结果。
 */
export function parseConfigBackupText(rawText) {
  let parsed = null

  try {
    parsed = JSON.parse(rawText)
  }
  catch {
    throw createBackupError('config-backup-parse-failed')
  }

  if (!isPlainObject(parsed)) {
    throw createBackupError('config-backup-format-mismatch')
  }

  if (parsed.format !== CONFIG_BACKUP_FORMAT) {
    throw createBackupError('config-backup-format-mismatch')
  }

  if (parsed.formatVersion !== CONFIG_BACKUP_FORMAT_VERSION) {
    throw createBackupError('config-backup-version-unsupported')
  }

  if (!isPlainObject(parsed.config)) {
    throw createBackupError('config-backup-config-missing')
  }

  return {
    appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : '',
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '',
    config: cloneJson(parsed.config),
  }
}

/**
 * 把导入的配置对齐到当前版本的默认配置。
 *
 * 旧版本备份可能缺字段、也可能带当前版本已经删掉的字段：先用 repairConfig 补齐/裁剪，
 * 再走一次结构校验，保证写回磁盘的一定是完整合法配置。
 *
 * @param {object} rawConfig 备份文件里的配置。
 * @param {object} [defaults] 默认配置，测试可注入。
 * @returns {object} 可直接写回的完整配置。
 */
export function normalizeImportedConfig(rawConfig, defaults = defaultConfig) {
  if (!isPlainObject(rawConfig)) {
    throw createBackupError('config-backup-config-missing')
  }

  const normalizedConfig = repairConfig(cloneJson(rawConfig), defaults)

  try {
    validateConfigShape(normalizedConfig)
  }
  catch {
    throw createBackupError('config-backup-config-invalid')
  }

  return normalizedConfig
}

/**
 * 生成默认文件名：mdreader-config-20261110-130145.json。
 */
export function createConfigBackupFileName(now = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `mdreader-config-${datePart}-${timePart}.${CONFIG_BACKUP_FILE_EXTENSION}`
}

function resolveParentWindow(windowContext) {
  const win = windowContext?.win
  return win && typeof win.isDestroyed === 'function' && win.isDestroyed() ? null : (win ?? null)
}

async function showSaveDialog(parentWindow, options) {
  return parentWindow
    ? await dialog.showSaveDialog(parentWindow, options)
    : await dialog.showSaveDialog(options)
}

async function showOpenDialog(parentWindow, options) {
  return parentWindow
    ? await dialog.showOpenDialog(parentWindow, options)
    : await dialog.showOpenDialog(options)
}

export default {
  channel: {
    'config-backup-export': async (windowContext) => {
      const parentWindow = resolveParentWindow(windowContext)
      const backupDocument = createConfigBackupDocument({
        config: configUtil.getConfig(),
        appVersion: app.getVersion(),
      })

      const saveResult = await showSaveDialog(parentWindow, {
        title: 'Export Config Backup',
        defaultPath: path.join(app.getPath('downloads'), createConfigBackupFileName()),
        filters: [{ name: 'JSON', extensions: [CONFIG_BACKUP_FILE_EXTENSION] }],
      })

      if (saveResult?.canceled === true || !saveResult?.filePath) {
        return { status: 'canceled' }
      }

      try {
        await fsExtra.writeFile(saveResult.filePath, serializeConfigBackup(backupDocument), 'utf8')
      }
      catch {
        return { status: 'failed', reason: 'config-backup-write-failed' }
      }

      return { status: 'exported', filePath: saveResult.filePath }
    },
    'config-backup-import': async (windowContext) => {
      const parentWindow = resolveParentWindow(windowContext)

      const openResult = await showOpenDialog(parentWindow, {
        title: 'Import Config Backup',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: [CONFIG_BACKUP_FILE_EXTENSION] }],
      })

      const filePath = Array.isArray(openResult?.filePaths) ? openResult.filePaths[0] : undefined

      if (openResult?.canceled === true || !filePath) {
        return { status: 'canceled' }
      }

      let importedConfig = null

      try {
        const rawText = await fsExtra.readFile(filePath, 'utf8')
        importedConfig = normalizeImportedConfig(parseConfigBackupText(rawText).config)
      }
      catch (error) {
        return { status: 'invalid', reason: error?.code ?? 'config-backup-invalid' }
      }

      const updateResult = await configUtil.updateConfig({
        operations: [
          { type: 'replace', config: importedConfig },
        ],
      })

      if (updateResult?.ok === false) {
        return { status: 'failed', reason: updateResult.reason ?? 'config-write-failed' }
      }

      return {
        status: 'imported',
        filePath,
        config: updateResult?.config ?? importedConfig,
      }
    },
  },
}
