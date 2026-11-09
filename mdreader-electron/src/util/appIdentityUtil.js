import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 应用身份标识。改它会让任务栏按钮被 Windows 当成全新应用，
// 进而丢掉旧图标缓存 —— 换品牌时正是靠这一点让任务栏图标立刻刷新。
export const WINDOWS_APP_USER_MODEL_ID = 'com.mdreader.app'

// 系统通知统一复用应用图标，避免不同通知各自维护路径。
export const APP_NOTIFICATION_ICON_PATH = path.resolve(__dirname, '../../icon/256x256.png')

export function applyWindowsAppIdentity({
  appApi,
  platform = process.platform,
  isPackaged = appApi?.isPackaged,
} = {}) {
  if (platform !== 'win32') {
    return false
  }

  // 开发态跑的是 electron.exe，此时同样设置正式版 AUMID 会让 Windows 把
  // 开发态快捷方式（开始菜单里的 Electron.lnk）绑到同一个 AppUserModelID 上；
  // 一旦它被固定过，正式版窗口的任务栏图标就会被 electron.exe 的 Electron 图标顶替。
  // 未打包时不设置身份，由 Windows 按 exe 路径派生，不会污染正式版。
  if (isPackaged !== true) {
    return false
  }

  if (typeof appApi?.setAppUserModelId !== 'function') {
    return false
  }

  appApi.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID)
  return true
}

export default {
  APP_NOTIFICATION_ICON_PATH,
  WINDOWS_APP_USER_MODEL_ID,
  applyWindowsAppIdentity,
}
