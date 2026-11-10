import { beforeEach, describe, expect, it, vi } from 'vitest'
import defaultConfig from '../../data/defaultConfig.js'

const {
  appGetPath,
  appGetVersion,
  readFileMock,
  showOpenDialogMock,
  showSaveDialogMock,
  writeFileMock,
} = vi.hoisted(() => ({
  appGetPath: vi.fn(() => 'C:/Users/tester/Downloads'),
  appGetVersion: vi.fn(() => '1.0.2'),
  readFileMock: vi.fn(),
  showOpenDialogMock: vi.fn(),
  showSaveDialogMock: vi.fn(),
  writeFileMock: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    getPath: appGetPath,
    getVersion: appGetVersion,
  },
  dialog: {
    showOpenDialog: showOpenDialogMock,
    showSaveDialog: showSaveDialogMock,
  },
}))

vi.mock('fs-extra', () => ({
  default: {
    readFile: readFileMock,
    writeFile: writeFileMock,
  },
}))

const { getConfigMock, updateConfigMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(),
  updateConfigMock: vi.fn(),
}))

vi.mock('../../data/configUtil.js', () => ({
  default: {
    getConfig: getConfigMock,
    updateConfig: updateConfigMock,
  },
}))

const configBackupUtil = await import('../configBackupUtil.js')

const {
  CONFIG_BACKUP_FORMAT,
  CONFIG_BACKUP_FORMAT_VERSION,
  createConfigBackupDocument,
  createConfigBackupFileName,
  normalizeImportedConfig,
  parseConfigBackupText,
  serializeConfigBackup,
} = configBackupUtil

function cloneDefaultConfig() {
  return JSON.parse(JSON.stringify(defaultConfig))
}

describe('createConfigBackupDocument', () => {
  it('只包含应用配置本身，不掺入最近文件或标签页数据', () => {
    const config = cloneDefaultConfig()
    const document = createConfigBackupDocument({
      config,
      appVersion: '1.0.2',
      exportedAt: '2026-11-10T05:00:00.000Z',
    })

    expect(document).toEqual({
      format: CONFIG_BACKUP_FORMAT,
      formatVersion: CONFIG_BACKUP_FORMAT_VERSION,
      app: 'mdreader',
      appVersion: '1.0.2',
      exportedAt: '2026-11-10T05:00:00.000Z',
      config,
    })
    expect(Object.keys(document)).toEqual([
      'format',
      'formatVersion',
      'app',
      'appVersion',
      'exportedAt',
      'config',
    ])
    expect(document).not.toHaveProperty('recent')
    expect(document).not.toHaveProperty('tabGroup')
    expect(document).not.toHaveProperty('logs')
  })

  it('配置不是对象时直接拒绝', () => {
    expect(() => createConfigBackupDocument({ config: null })).toThrow(/config-backup-config-missing/)
  })
})

describe('serializeConfigBackup / parseConfigBackupText', () => {
  it('序列化后可以原样解析回来', () => {
    const config = cloneDefaultConfig()
    const text = serializeConfigBackup(createConfigBackupDocument({
      config,
      appVersion: '1.0.2',
      exportedAt: '2026-11-10T05:00:00.000Z',
    }))

    expect(text.endsWith('\n')).toBe(true)

    const parsed = parseConfigBackupText(text)
    expect(parsed.appVersion).toBe('1.0.2')
    expect(parsed.exportedAt).toBe('2026-11-10T05:00:00.000Z')
    expect(parsed.config).toEqual(config)
  })

  it('非 JSON 文本应报解析失败', () => {
    expect(() => parseConfigBackupText('not json')).toThrow(/config-backup-parse-failed/)
  })

  it('format 不匹配应拒绝', () => {
    expect(() => parseConfigBackupText(JSON.stringify({
      format: 'other-app-backup',
      formatVersion: 1,
      config: cloneDefaultConfig(),
    }))).toThrow(/config-backup-format-mismatch/)
  })

  it('formatVersion 不支持应拒绝', () => {
    expect(() => parseConfigBackupText(JSON.stringify({
      format: CONFIG_BACKUP_FORMAT,
      formatVersion: 99,
      config: cloneDefaultConfig(),
    }))).toThrow(/config-backup-version-unsupported/)
  })

  it('缺少 config 应拒绝', () => {
    expect(() => parseConfigBackupText(JSON.stringify({
      format: CONFIG_BACKUP_FORMAT,
      formatVersion: CONFIG_BACKUP_FORMAT_VERSION,
    }))).toThrow(/config-backup-config-missing/)
  })
})

describe('normalizeImportedConfig', () => {
  it('缺失字段按默认值补齐', () => {
    const importedConfig = normalizeImportedConfig({ language: 'en-US' })

    expect(importedConfig.language).toBe('en-US')
    expect(importedConfig.fontSize).toBe(defaultConfig.fontSize)
    expect(importedConfig.imageBed.uploader).toBe(defaultConfig.imageBed.uploader)
    expect(Object.keys(importedConfig).sort()).toEqual(Object.keys(defaultConfig).sort())
  })

  it('裁掉当前版本已经不存在的字段', () => {
    const importedConfig = normalizeImportedConfig({
      ...cloneDefaultConfig(),
      removedFieldInNewVersion: true,
    })

    expect(importedConfig).not.toHaveProperty('removedFieldInNewVersion')
  })

  it('值类型非法时应拒绝', () => {
    expect(() => normalizeImportedConfig({
      ...cloneDefaultConfig(),
      fontSize: 'huge',
    })).toThrow(/config-backup-config-invalid/)
  })
})

describe('createConfigBackupFileName', () => {
  it('按时间生成可读文件名', () => {
    expect(createConfigBackupFileName(new Date(2026, 10, 10, 13, 1, 45)))
      .toBe('mdreader-config-20261110-130145.json')
  })
})

describe('config-backup-export channel', () => {
  const exportHandler = configBackupUtil.default.channel['config-backup-export']

  beforeEach(() => {
    getConfigMock.mockReset()
    writeFileMock.mockReset()
    showSaveDialogMock.mockReset()
    getConfigMock.mockReturnValue(cloneDefaultConfig())
  })

  it('用户取消保存时不写文件', async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: true, filePath: '' })

    const result = await exportHandler({ win: null })

    expect(result).toEqual({ status: 'canceled' })
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('保存成功时写出的文件只有配置树', async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: 'C:/tmp/backup.json' })
    writeFileMock.mockResolvedValue(undefined)

    const result = await exportHandler({ win: null })

    expect(result).toEqual({ status: 'exported', filePath: 'C:/tmp/backup.json' })
    expect(writeFileMock).toHaveBeenCalledTimes(1)

    const [filePath, text] = writeFileMock.mock.calls[0]
    expect(filePath).toBe('C:/tmp/backup.json')

    const parsed = JSON.parse(text)
    expect(parsed.format).toBe(CONFIG_BACKUP_FORMAT)
    expect(parsed.appVersion).toBe('1.0.2')
    expect(parsed.config).toEqual(defaultConfig)
    expect(Object.keys(parsed)).toHaveLength(6)
  })

  it('写盘失败时返回失败状态', async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: 'C:/tmp/backup.json' })
    writeFileMock.mockRejectedValue(new Error('disk full'))

    const result = await exportHandler({ win: null })

    expect(result).toEqual({ status: 'failed', reason: 'config-backup-write-failed' })
  })
})

describe('config-backup-import channel', () => {
  const importHandler = configBackupUtil.default.channel['config-backup-import']

  beforeEach(() => {
    readFileMock.mockReset()
    showOpenDialogMock.mockReset()
    updateConfigMock.mockReset()
  })

  it('用户取消选择文件时不动配置', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] })

    const result = await importHandler({ win: null })

    expect(result).toEqual({ status: 'canceled' })
    expect(updateConfigMock).not.toHaveBeenCalled()
  })

  it('导入合法备份时走 replace 整包替换', async () => {
    const config = cloneDefaultConfig()
    config.language = 'en-US'

    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['C:/tmp/backup.json'] })
    readFileMock.mockResolvedValue(serializeConfigBackup(createConfigBackupDocument({ config })))
    updateConfigMock.mockImplementation(async request => ({
      ok: true,
      config: request.operations[0].config,
    }))

    const result = await importHandler({ win: null })

    expect(result.status).toBe('imported')
    expect(updateConfigMock).toHaveBeenCalledTimes(1)

    const [request] = updateConfigMock.mock.calls[0]
    expect(request.operations).toHaveLength(1)
    expect(request.operations[0].type).toBe('replace')
    expect(request.operations[0].config.language).toBe('en-US')
  })

  it('备份文件不合法时返回 invalid 且不写配置', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['C:/tmp/backup.json'] })
    readFileMock.mockResolvedValue('{"format":"other-app-backup"}')

    const result = await importHandler({ win: null })

    expect(result).toEqual({ status: 'invalid', reason: 'config-backup-format-mismatch' })
    expect(updateConfigMock).not.toHaveBeenCalled()
  })

  it('主进程写盘失败时透传失败状态', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['C:/tmp/backup.json'] })
    readFileMock.mockResolvedValue(serializeConfigBackup(createConfigBackupDocument({
      config: cloneDefaultConfig(),
    })))
    updateConfigMock.mockResolvedValue({ ok: false, reason: 'config-write-failed' })

    const result = await importHandler({ win: null })

    expect(result).toEqual({ status: 'failed', reason: 'config-write-failed' })
  })
})
