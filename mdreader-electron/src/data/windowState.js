import path from 'node:path'
import fs from 'fs-extra'
import { resolveUserDataDir } from '../util/userDataPathUtil.js'

/**
 * 主窗口大小与位置。
 *
 * 为什么单独一个文件、不塞进 config.json：
 * 1. 窗口几何是**会话状态**，和「上次打开了哪些标签」(tab-group.json) 同类，
 *    不是用户设置；配置备份（configBackupUtil）只导设置，不该带上屏幕坐标；
 * 2. config.json 的 schema 是完整对象校验（additionalProperties:false + required 全字段），
 *    往里面加字段要同时改 schema / 默认值 / mutation 白名单，任何一处漏改都会变成
 *    「写盘被拒 → 弹配置内容无效」——正是 1.0.4 修掉的那类问题，没必要再碰一次。
 *
 * 只记「常规窗口」的矩形：最大化/全屏时不覆盖 size，恢复时先还原矩形再最大化，
 * 这样用户取消最大化还能回到原来的大小。
 */
const STATE_FILE_NAME = 'window-state.json'

// 与建窗时的 minWidth / minHeight 保持一致，小于这个值的存档视为脏数据。
const MIN_WINDOW_WIDTH = 800
const MIN_WINDOW_HEIGHT = 600

let windowState = null

function getUserDataRoot() {
  return resolveUserDataDir()
}

function getWindowStatePath() {
  return path.resolve(getUserDataRoot(), STATE_FILE_NAME)
}

function toFiniteInteger(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null
}

function normalizeWindowState(rawState) {
  if (!rawState || typeof rawState !== 'object') {
    return null
  }

  const x = toFiniteInteger(rawState.x)
  const y = toFiniteInteger(rawState.y)
  const width = toFiniteInteger(rawState.width)
  const height = toFiniteInteger(rawState.height)

  if (x === null || y === null || width === null || height === null) {
    return null
  }

  if (width < MIN_WINDOW_WIDTH || height < MIN_WINDOW_HEIGHT) {
    return null
  }

  return {
    x,
    y,
    width,
    height,
    isMaximized: rawState.isMaximized === true,
  }
}

async function initWindowState() {
  try {
    const filePath = getWindowStatePath()
    if (!await fs.pathExists(filePath)) {
      windowState = null
      return get()
    }
    const rawContent = await fs.readFile(filePath, 'utf-8')
    windowState = normalizeWindowState(JSON.parse(rawContent))
  }
  catch {
    // 窗口几何只是启动观感的附属持久化，读失败退回「按默认尺寸居中」，不能阻塞启动。
    windowState = null
  }
  return get()
}

function get() {
  return windowState ? { ...windowState } : null
}

async function save(nextWindowState) {
  windowState = normalizeWindowState(nextWindowState)
  try {
    await fs.ensureDir(getUserDataRoot())
    await fs.writeFile(getWindowStatePath(), JSON.stringify(windowState, null, 2), 'utf-8')
  }
  catch (error) {
    console.error('[window-state] save failed:', error)
  }
  return get()
}

/**
 * 同步写盘，只给关窗链路用。
 *
 * 最后一个窗口关闭时进程可能立即退出，异步写盘会被截断。
 */
function saveSync(nextWindowState) {
  windowState = normalizeWindowState(nextWindowState)
  try {
    fs.ensureDirSync(getUserDataRoot())
    fs.writeFileSync(getWindowStatePath(), JSON.stringify(windowState, null, 2), 'utf-8')
  }
  catch (error) {
    console.error('[window-state] saveSync failed:', error)
  }
  return get()
}

export { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, normalizeWindowState }

export default {
  initWindowState,
  get,
  save,
  saveSync,
}
