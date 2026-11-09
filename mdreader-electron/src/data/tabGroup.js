import path from 'node:path'
import fs from 'fs-extra'
import { resolveUserDataDir } from '../util/userDataPathUtil.js'

/**
 * 上次打开的标签组。
 *
 * 这份记录只服务“重启后恢复打开了哪些文档”，与 `recent.json` 是两件事：
 * 1. `recent` 是全局的最近文件路径历史，有 `recentMax` 上限，服务最近文件菜单
 * 2. 这里只记一个窗口的标签顺序与活动标签，不套 `recentMax`，
 *    否则“开了 15 个标签重启只回来 10 个”
 *
 * 多栏并排（2026-11）把这里升级成“窗口 → 多个标签组”：
 * - 内存里规范形态是 v2：`{ version:2, groups:[{tabs,activeIndex}], focusedGroupIndex }`
 * - 单栏时**写盘/对外仍沿用旧的 `{ tabs, activeIndex }`**，旧文件零改动可读，
 *   也不会让“用单栏的人磁盘上多出一层壳”
 * - 只有真的分了栏才写 v2，读盘时两种形态都认
 */
// 路径必须惰性求值：
// 1. windowLifecycleService 会在导入阶段连带引入本模块，部分测试环境只提供了最小的 electron mock
// 2. 启动早期的旧数据迁移必须在目录解析之前完成
function getUserDataRoot() {
  return resolveUserDataDir()
}

function getTabGroupPath() {
  return path.resolve(getUserDataRoot(), 'tab-group.json')
}

const EMPTY_TAB_GROUP = {
  tabs: [],
  activeIndex: 0,
}

const TAB_GROUP_SCHEMA_VERSION = 2

function createEmptyTabGroups() {
  return {
    version: TAB_GROUP_SCHEMA_VERSION,
    groups: [{ ...EMPTY_TAB_GROUP }],
    focusedGroupIndex: 0,
  }
}

let tabGroups = createEmptyTabGroups()

function isWindowsComparablePath(targetPath) {
  return /^[a-z]:[\\/]/i.test(targetPath) || targetPath.startsWith('\\\\')
}

/**
 * 标签组去重用的路径比较键。
 *
 * 只有 Windows（以及 Windows 形状的盘符 / UNC 路径）需要折叠大小写与分隔符：
 * - NTFS 默认大小写不敏感，`C:/docs/A.md` 与 `c:\docs\a.md` 指向同一文件
 * - Linux 上 `README.md` 与 `readme.md` 是两个不同文件，`\` 还是合法文件名字符，
 *   无条件 `toLowerCase()` 或 `\`→`/` 替换都会把不同文档判成同一路径，
 *   进而在写盘时静默丢掉一个标签
 *
 * 这里不复用 `toComparableDocumentPath()`：它的 POSIX 分支同样会执行 `\`→`/`，
 * 对 Linux 上文件名含反斜杠的文档不安全。
 */
function toComparableTabPath(targetPath) {
  if (isWindowsComparablePath(targetPath) || process.platform === 'win32') {
    return path.win32.normalize(targetPath.replaceAll('/', '\\')).toLowerCase()
  }
  return targetPath
}

function normalizeTabGroup(rawTabGroup, seenPathKey = new Set()) {
  if (!rawTabGroup || typeof rawTabGroup !== 'object') {
    return { ...EMPTY_TAB_GROUP }
  }

  const tabList = (Array.isArray(rawTabGroup.tabs) ? rawTabGroup.tabs : [])
    .map((item) => {
      return typeof item === 'string' && item.trim() !== '' ? item.trim() : null
    })
    .filter((item) => {
      if (!item) {
        return false
      }
      // 同一路径在整份存档里只允许出现一次：
      // 一个文档不可能同时作为两个标签打开，重复会让恢复时出现“幽灵标签”。
      const comparableKey = toComparableTabPath(item)
      if (seenPathKey.has(comparableKey)) {
        return false
      }
      seenPathKey.add(comparableKey)
      return true
    })

  const rawActiveIndex = Number.isInteger(rawTabGroup.activeIndex) ? rawTabGroup.activeIndex : 0
  const activeIndex = tabList.length === 0
    ? 0
    : Math.min(Math.max(rawActiveIndex, 0), tabList.length - 1)

  return {
    tabs: tabList,
    activeIndex,
  }
}

/**
 * 把任意历史形态的存档归一成 v2 内存形态。
 *
 * 认两种输入：
 * - 旧形态 `{ tabs, activeIndex }`（单栏时代的文件）
 * - v2 形态 `{ version:2, groups:[{tabs,activeIndex}], focusedGroupIndex }`
 */
function normalizeTabGroups(rawTabGroup) {
  if (!rawTabGroup || typeof rawTabGroup !== 'object') {
    return createEmptyTabGroups()
  }

  const rawGroupList = Array.isArray(rawTabGroup.groups)
    ? rawTabGroup.groups
    : [rawTabGroup]

  // 去重键跨组共享：同一文件不能同时出现在两栏里。
  const seenPathKey = new Set()
  const groupList = rawGroupList
    .map(item => normalizeTabGroup(item, seenPathKey))
    .filter(group => group.tabs.length > 0 || rawGroupList.length === 1)

  if (groupList.length === 0) {
    return createEmptyTabGroups()
  }

  const rawFocusedIndex = Number.isInteger(rawTabGroup.focusedGroupIndex)
    ? rawTabGroup.focusedGroupIndex
    : 0
  const focusedGroupIndex = Math.min(Math.max(rawFocusedIndex, 0), groupList.length - 1)

  return {
    version: TAB_GROUP_SCHEMA_VERSION,
    groups: groupList,
    focusedGroupIndex,
  }
}

/**
 * 对外的单栏视图：取焦点栏的标签与活动下标。
 *
 * 保留这个视图是为了让所有“只需要知道当前打开哪些文档”的旧调用点零改动，
 * 也让单栏用户的存档文件保持旧形态。
 */
function toTabGroupView(tabGroupsValue) {
  const focusedIndex = Math.min(
    Math.max(tabGroupsValue.focusedGroupIndex || 0, 0),
    tabGroupsValue.groups.length - 1,
  )
  const focusedGroup = tabGroupsValue.groups[focusedIndex] || EMPTY_TAB_GROUP
  return {
    tabs: [...focusedGroup.tabs],
    activeIndex: focusedGroup.activeIndex,
  }
}

/**
 * 写盘形态：单栏写旧形态，多栏写 v2。
 *
 * 单栏写旧形态不是“懒得升级”，而是刻意让绝大多数用户的存档保持原样：
 * 旧版本回退、外部工具读取、人工排查都还能用。
 */
function toPersistedTabGroup(tabGroupsValue) {
  if (tabGroupsValue.groups.length <= 1) {
    return toTabGroupView(tabGroupsValue)
  }

  return {
    version: TAB_GROUP_SCHEMA_VERSION,
    groups: tabGroupsValue.groups.map(group => ({
      tabs: [...group.tabs],
      activeIndex: group.activeIndex,
    })),
    focusedGroupIndex: tabGroupsValue.focusedGroupIndex,
  }
}

async function initTabGroup() {
  try {
    const userDataRoot = getUserDataRoot()
    const tabGroupPath = getTabGroupPath()
    await fs.ensureDir(userDataRoot)
    if (!await fs.pathExists(tabGroupPath)) {
      tabGroups = createEmptyTabGroups()
      return get()
    }
    const rawContent = await fs.readFile(tabGroupPath, 'utf-8')
    tabGroups = normalizeTabGroups(JSON.parse(rawContent))
  }
  catch {
    // 标签组只是启动体验的附属持久化，读取失败时退回空组，不能阻塞启动。
    tabGroups = createEmptyTabGroups()
  }
  return get()
}

function get() {
  return toTabGroupView(tabGroups)
}

/**
 * 读完整的 v2 形态（含每一栏的标签与焦点栏）。
 *
 * 多栏恢复必须用这个入口：单栏视图会把“哪一栏有哪些标签”拍平掉，
 * 拿它去恢复等于把分栏布局静默还原成单栏。
 */
function getGroups() {
  return {
    version: TAB_GROUP_SCHEMA_VERSION,
    groups: tabGroups.groups.map(group => ({
      tabs: [...group.tabs],
      activeIndex: group.activeIndex,
    })),
    focusedGroupIndex: tabGroups.focusedGroupIndex,
  }
}

async function writeTabGroups(nextTabGroups) {
  tabGroups = nextTabGroups
  try {
    await fs.ensureDir(getUserDataRoot())
    await fs.writeFile(getTabGroupPath(), JSON.stringify(toPersistedTabGroup(tabGroups), null, 2), 'utf-8')
  }
  catch (error) {
    // 写盘失败只影响下次启动的恢复体验，不影响当前会话。
    console.error('[tab-group] save failed:', error)
  }
  return get()
}

async function save(nextTabGroup) {
  return await writeTabGroups(normalizeTabGroups(nextTabGroup))
}

/**
 * 同步写盘，只给关窗链路用。
 *
 * 最后一个窗口关闭时 `checkWinList()` 会立刻 `app.exit()`，
 * 异步写盘会被进程退出截断，所以关窗必须同步落盘。
 */
function saveSync(nextTabGroup) {
  tabGroups = normalizeTabGroups(nextTabGroup)
  try {
    fs.ensureDirSync(getUserDataRoot())
    fs.writeFileSync(getTabGroupPath(), JSON.stringify(toPersistedTabGroup(tabGroups), null, 2), 'utf-8')
  }
  catch (error) {
    // 写盘失败只影响下次启动的恢复体验，不能阻塞关窗。
    console.error('[tab-group] saveSync failed:', error)
  }
  return get()
}

async function clear() {
  return await save(EMPTY_TAB_GROUP)
}

export default {
  initTabGroup,
  get,
  getGroups,
  save,
  saveSync,
  clear,
}
