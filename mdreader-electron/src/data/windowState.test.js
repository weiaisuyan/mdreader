import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  ensureDirMock,
  ensureDirSyncMock,
  pathExistsMock,
  readFileMock,
  writeFileMock,
  writeFileSyncMock,
  resolveUserDataDirMock,
} = vi.hoisted(() => {
  return {
    ensureDirMock: vi.fn(),
    ensureDirSyncMock: vi.fn(),
    pathExistsMock: vi.fn(),
    readFileMock: vi.fn(),
    writeFileMock: vi.fn(),
    writeFileSyncMock: vi.fn(),
    resolveUserDataDirMock: vi.fn(() => 'C:/Users/robot/AppData/Roaming/mdreader/data'),
  }
})

vi.mock('electron', () => {
  return {
    app: {
      getPath: vi.fn(() => 'C:/Users/robot/AppData/Roaming/mdreader'),
      getAppPath: vi.fn(() => 'D:/code/mdreader-electron'),
    },
  }
})

vi.mock('fs-extra', () => {
  return {
    default: {
      ensureDir: ensureDirMock,
      ensureDirSync: ensureDirSyncMock,
      pathExists: pathExistsMock,
      readFile: readFileMock,
      writeFile: writeFileMock,
      writeFileSync: writeFileSyncMock,
    },
  }
})

vi.mock('../util/userDataPathUtil.js', () => {
  return {
    resolveUserDataDir: resolveUserDataDirMock,
  }
})

const USER_DATA_DIR = 'C:/Users/robot/AppData/Roaming/mdreader/data'
const EXPECTED_FILE_PATH = path.resolve(USER_DATA_DIR, 'window-state.json')

async function importWindowState() {
  vi.resetModules()
  const module = await import('./windowState.js')
  return module
}

describe('windowState 窗口大小/位置存储', () => {
  let consoleErrorSpy

  beforeEach(() => {
    ensureDirMock.mockReset().mockResolvedValue(undefined)
    ensureDirSyncMock.mockReset()
    pathExistsMock.mockReset()
    readFileMock.mockReset()
    writeFileMock.mockReset().mockResolvedValue(undefined)
    writeFileSyncMock.mockReset()
    resolveUserDataDirMock.mockReset().mockReturnValue(USER_DATA_DIR)
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  it('没有存档文件时 get() 返回 null', async () => {
    pathExistsMock.mockResolvedValue(false)
    const { default: windowState } = await importWindowState()
    await windowState.initWindowState()
    expect(windowState.get()).toBeNull()
  })

  it('正常存档会被读取，并把浮点坐标取整', async () => {
    pathExistsMock.mockResolvedValue(true)
    readFileMock.mockResolvedValue(JSON.stringify({
      x: 40.4,
      y: 60.6,
      width: 1200.5,
      height: 800.2,
      isMaximized: true,
    }))
    const { default: windowState } = await importWindowState()
    await windowState.initWindowState()
    expect(windowState.get()).toEqual({
      x: 40,
      y: 61,
      width: 1201,
      height: 800,
      isMaximized: true,
    })
  })

  it('尺寸小于建窗最小值的存档视为脏数据', async () => {
    pathExistsMock.mockResolvedValue(true)
    readFileMock.mockResolvedValue(JSON.stringify({ x: 0, y: 0, width: 320, height: 200 }))
    const { default: windowState } = await importWindowState()
    await windowState.initWindowState()
    expect(windowState.get()).toBeNull()
  })

  it('存档 JSON 损坏时退回 null，不抛错', async () => {
    pathExistsMock.mockResolvedValue(true)
    readFileMock.mockResolvedValue('{ not json')
    const { default: windowState } = await importWindowState()
    await expect(windowState.initWindowState()).resolves.toBeNull()
    expect(windowState.get()).toBeNull()
  })

  it('save() 会先建目录再写 window-state.json', async () => {
    const { default: windowState } = await importWindowState()
    await windowState.save({ x: 10, y: 20, width: 1000, height: 700, isMaximized: false })
    expect(ensureDirMock).toHaveBeenCalledWith(USER_DATA_DIR)
    expect(writeFileMock).toHaveBeenCalledWith(
      EXPECTED_FILE_PATH,
      JSON.stringify({ x: 10, y: 20, width: 1000, height: 700, isMaximized: false }, null, 2),
      'utf-8',
    )
    expect(windowState.get()).toEqual({ x: 10, y: 20, width: 1000, height: 700, isMaximized: false })
  })

  it('saveSync() 同步写盘，供关窗链路使用', async () => {
    const { default: windowState } = await importWindowState()
    windowState.saveSync({ x: 1, y: 2, width: 900, height: 650, isMaximized: true })
    expect(ensureDirSyncMock).toHaveBeenCalledWith(USER_DATA_DIR)
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      EXPECTED_FILE_PATH,
      JSON.stringify({ x: 1, y: 2, width: 900, height: 650, isMaximized: true }, null, 2),
      'utf-8',
    )
  })

  it('非法数据写入后存档为 null，避免把脏数据留在盘上', async () => {
    const { default: windowState } = await importWindowState()
    await windowState.save({ x: Number.NaN, y: 0, width: 1000, height: 700 })
    expect(writeFileMock).toHaveBeenCalledWith(EXPECTED_FILE_PATH, 'null', 'utf-8')
    expect(windowState.get()).toBeNull()
  })
})
