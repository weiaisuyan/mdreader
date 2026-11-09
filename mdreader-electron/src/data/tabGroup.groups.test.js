import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  ensureDirMock,
  ensureDirSyncMock,
  pathExistsMock,
  readFileMock,
  writeFileMock,
  writeFileSyncMock,
} = vi.hoisted(() => {
  return {
    ensureDirMock: vi.fn(),
    ensureDirSyncMock: vi.fn(),
    pathExistsMock: vi.fn(),
    readFileMock: vi.fn(),
    writeFileMock: vi.fn(),
    writeFileSyncMock: vi.fn(),
  }
})

vi.mock('electron', () => {
  return {
    app: {
      isPackaged: false,
      getAppPath: vi.fn(() => 'D:/code/wj-markdown-editor/mdreader-electron'),
      getPath: vi.fn(() => 'C:/Users/robot/Documents'),
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

describe('tabGroup v2 多栏存档', () => {
  let consoleErrorSpy

  beforeEach(async () => {
    vi.resetModules()
    ensureDirMock.mockReset().mockResolvedValue(undefined)
    ensureDirSyncMock.mockReset()
    pathExistsMock.mockReset().mockResolvedValue(false)
    readFileMock.mockReset()
    writeFileMock.mockReset().mockResolvedValue(undefined)
    writeFileSyncMock.mockReset()
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  it('单栏存档必须继续写成旧形态，不能给单栏用户多套一层壳', async () => {
    const tabGroup = (await import('./tabGroup.js')).default

    await tabGroup.save({ tabs: ['D:/docs/a.md'], activeIndex: 0 })

    const persisted = JSON.parse(writeFileMock.mock.calls[0][1])
    expect(persisted).toEqual({ tabs: ['D:/docs/a.md'], activeIndex: 0 })
    expect(persisted.version).toBeUndefined()
  })

  it('多栏存档必须写成 v2 形态，每栏标签与焦点栏都要落盘', async () => {
    const tabGroup = (await import('./tabGroup.js')).default

    await tabGroup.save({
      version: 2,
      groups: [
        { tabs: ['D:/docs/a.md', 'D:/docs/b.md'], activeIndex: 1 },
        { tabs: ['D:/docs/c.md'], activeIndex: 0 },
      ],
      focusedGroupIndex: 1,
    })

    const persisted = JSON.parse(writeFileMock.mock.calls[0][1])
    expect(persisted).toEqual({
      version: 2,
      groups: [
        { tabs: ['D:/docs/a.md', 'D:/docs/b.md'], activeIndex: 1 },
        { tabs: ['D:/docs/c.md'], activeIndex: 0 },
      ],
      focusedGroupIndex: 1,
    })
  })

  it('get 返回焦点栏的单栏视图，getGroups 返回完整多栏形态', async () => {
    const tabGroup = (await import('./tabGroup.js')).default

    await tabGroup.save({
      version: 2,
      groups: [
        { tabs: ['D:/docs/a.md'], activeIndex: 0 },
        { tabs: ['D:/docs/b.md', 'D:/docs/c.md'], activeIndex: 1 },
      ],
      focusedGroupIndex: 1,
    })

    expect(tabGroup.get()).toEqual({
      tabs: ['D:/docs/b.md', 'D:/docs/c.md'],
      activeIndex: 1,
    })
    expect(tabGroup.getGroups()).toEqual({
      version: 2,
      groups: [
        { tabs: ['D:/docs/a.md'], activeIndex: 0 },
        { tabs: ['D:/docs/b.md', 'D:/docs/c.md'], activeIndex: 1 },
      ],
      focusedGroupIndex: 1,
    })
  })

  it('旧形态存档读入后必须变成一个标签组，并保持标签与活动下标', async () => {
    pathExistsMock.mockResolvedValue(true)
    readFileMock.mockResolvedValue(JSON.stringify({
      tabs: ['D:/docs/a.md', 'D:/docs/b.md'],
      activeIndex: 1,
    }))
    const tabGroup = (await import('./tabGroup.js')).default

    await tabGroup.initTabGroup()

    expect(tabGroup.getGroups()).toEqual({
      version: 2,
      groups: [
        { tabs: ['D:/docs/a.md', 'D:/docs/b.md'], activeIndex: 1 },
      ],
      focusedGroupIndex: 0,
    })
    expect(tabGroup.get()).toEqual({
      tabs: ['D:/docs/a.md', 'D:/docs/b.md'],
      activeIndex: 1,
    })
  })

  it('多栏存档读入时，同一路径不能同时出现在两栏里', async () => {
    pathExistsMock.mockResolvedValue(true)
    readFileMock.mockResolvedValue(JSON.stringify({
      version: 2,
      groups: [
        { tabs: ['D:/docs/a.md', 'D:/docs/b.md'], activeIndex: 0 },
        { tabs: ['D:/docs/B.md', 'D:/docs/c.md'], activeIndex: 1 },
      ],
      focusedGroupIndex: 0,
    }))
    const tabGroup = (await import('./tabGroup.js')).default

    await tabGroup.initTabGroup()

    const groups = tabGroup.getGroups().groups
    expect(groups[0].tabs).toEqual(['D:/docs/a.md', 'D:/docs/b.md'])
    expect(groups[1].tabs).toEqual(['D:/docs/c.md'])
    // 去重后活动下标要跟着夹紧，不能指向已不存在的标签。
    expect(groups[1].activeIndex).toBe(0)
  })

  it('focusedGroupIndex 越界时夹紧到最后一个标签组', async () => {
    const tabGroup = (await import('./tabGroup.js')).default

    await tabGroup.save({
      version: 2,
      groups: [
        { tabs: ['D:/docs/a.md'], activeIndex: 0 },
        { tabs: ['D:/docs/b.md'], activeIndex: 0 },
      ],
      focusedGroupIndex: 99,
    })

    expect(tabGroup.getGroups().focusedGroupIndex).toBe(1)
    expect(tabGroup.get()).toEqual({ tabs: ['D:/docs/b.md'], activeIndex: 0 })
  })

  it('空标签组存档归一后退回单栏空视图', async () => {
    const tabGroup = (await import('./tabGroup.js')).default

    await tabGroup.save({
      version: 2,
      groups: [
        { tabs: [], activeIndex: 0 },
        { tabs: [], activeIndex: 0 },
      ],
      focusedGroupIndex: 1,
    })

    expect(tabGroup.get()).toEqual({ tabs: [], activeIndex: 0 })
    expect(tabGroup.getGroups().groups).toHaveLength(1)
  })

  it('saveSync 多栏存档必须同步写出 v2 形态', async () => {
    const tabGroup = (await import('./tabGroup.js')).default

    tabGroup.saveSync({
      version: 2,
      groups: [
        { tabs: ['D:/docs/a.md'], activeIndex: 0 },
        { tabs: ['D:/docs/b.md'], activeIndex: 0 },
      ],
      focusedGroupIndex: 0,
    })

    const persisted = JSON.parse(writeFileSyncMock.mock.calls[0][1])
    expect(persisted.version).toBe(2)
    expect(persisted.groups).toHaveLength(2)
  })
})
