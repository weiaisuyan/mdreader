import fs from 'node:fs'
import path from 'node:path'
import { app, Menu, protocol, screen, shell } from 'electron'
import configUtil from './data/configUtil.js'
import recent from './data/recent.js'
import tabGroup from './data/tabGroup.js'
import windowState from './data/windowState.js'
import { applyWindowsAppIdentity } from './util/appIdentityUtil.js'
import { handleSecondInstanceOpenRequest, handleStartupOpenRequest, resolveOpenTargetFromArgs, resolveSecondInstanceOpenTarget } from './util/appOpenRequestUtil.js'
import sendUtil from './util/channel/sendUtil.js'
import { createDocumentOpenFailureNotificationPublisher } from './util/document-session/documentOpenFailureNotificationUtil.js'
import { initializeDocumentSessionRuntime } from './util/document-session/documentSessionRuntime.js'
import { createDocumentSessionRuntimeComposition } from './util/document-session/documentSessionRuntimeComposition.js'
import windowLifecycleService from './util/document-session/windowLifecycleService.js'
import { createWindowRegistry } from './util/document-session/windowRegistry.js'
import { migrateLegacyUserData } from './util/legacyUserDataMigrationUtil.js'
import logUtil from './util/logUtil.js'
import protocolUtil from './util/protocolUtil.js'
import updateUtil from './util/updateUtil.js'
import { resolveUserDataDir } from './util/userDataPathUtil.js'
import aboutUtil from './util/win/aboutUtil.js'
import exportUtil from './util/win/exportUtil.js'
import guideUtil from './util/win/guideUtil.js'
import settingUtil from './util/win/settingUtil.js'
import './util/channel/ipcMainUtil.js'

app.commandLine.appendSwitch('--disable-http-cache')

/**
 * 用户数据目录：从旧的 wj-markdown-editor 迁到 mdreader。
 *
 * 品牌改名后 productName 变成 mdreader，Electron 默认的 userData 也随之变成
 * `%APPDATA%\mdreader`。直接切过去会让现有用户的 config / 标签组 / 最近文件全部读不到，
 * 表现就是「换个名字，配置和标签全丢」。
 *
 * 所以这里做一次性搬迁：新目录还不存在、旧目录有数据时，整目录复制过去。
 * 三条硬约束：
 * 1. **同步执行** —— 必须早于任何惰性路径解析，否则模块会先拿到旧路径；
 * 2. **只在目标不存在时搬** —— 避免每次启动覆盖用户在新目录里的改动；
 * 3. **复制失败就退回旧目录** —— 宁可目录名不对，也不能让用户数据读不到。
 */
const LEGACY_USER_DATA_DIR = path.join(app.getPath('appData'), 'wj-markdown-editor')
const RENAMED_USER_DATA_DIR = path.join(app.getPath('appData'), 'mdreader')
let resolvedUserDataDir = RENAMED_USER_DATA_DIR
try {
  if (!fs.existsSync(RENAMED_USER_DATA_DIR) && fs.existsSync(LEGACY_USER_DATA_DIR)) {
    fs.cpSync(LEGACY_USER_DATA_DIR, RENAMED_USER_DATA_DIR, { recursive: true })
  }
}
catch (error) {
  // 复制失败：继续用旧目录，保证用户这次仍能看到自己的配置和标签。
  console.warn('[userData] 目录改名迁移失败，回退到旧目录:', error?.message)
  resolvedUserDataDir = LEGACY_USER_DATA_DIR
}
app.setPath('userData', resolvedUserDataDir)
// Windows 系统通知需要稳定的应用身份，避免标题栏回退成 Electron 默认值。
applyWindowsAppIdentity({
  appApi: app,
})
/**
 * 配置应用级 GPU 行为。
 *
 * 如果 windows 系统开启了 GPU渲染，当导出为图片时，在 Windows 机器上会触发 GPU 子进程崩溃，通过关闭硬件加速回退到软件渲染链路
 */
// app.disableHardwareAcceleration()

// 注册自定义协议特权（必须在 app.whenReady() 之前调用）
try {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'wj',
      privileges: {
        standard: true, // 标准 URL 行为
        secure: true, // HTTPS 级别安全
        supportFetchAPI: true, // 支持 Fetch API
        corsEnabled: false, // 禁用 CORS
        bypassCSP: false, // 不绕过 CSP
        stream: true, // 支持流式传输（Range 请求）
      },
    },
  ])
} catch (error) {
  console.error('[Protocol] CRITICAL: Failed to register wj:// protocol privileges')
  console.error('[Protocol] Error details:', {
    name: error.name,
    message: error.message,
    stack: error.stack,
  })
  console.error('[Protocol] Application may not function correctly without protocol registration')
  // 不阻止应用启动，但记录严重错误
}

/**
 * 启动参数里的 Markdown 打开目标。
 *
 * Linux 上 electron-builder 生成的 .desktop 用 `%U` 传参，文件管理器双击 Markdown 时
 * 拿到的是 `file:///home/u/a.md` 这样的 URI。必须在进入路径解析前就转成本地路径，
 * 否则会被当成相对路径拼到 cwd 后面，表现为“应用起来了但只开了一个空白草稿”。
 */
function getOpenOnFilePath() {
  return resolveOpenTargetFromArgs(process.argv)
}

let documentSessionRuntime = null
const windowRegistry = createWindowRegistry()

windowLifecycleService.configure({
  registry: windowRegistry,
})

function initializeAppDocumentSessionRuntime() {
  if (documentSessionRuntime) {
    return documentSessionRuntime
  }

  documentSessionRuntime = initializeDocumentSessionRuntime({
    ...createDocumentSessionRuntimeComposition({
      registry: windowRegistry,
      getConfig: () => configUtil.getConfig(),
      recentStore: recent,
      sendToRenderer: (win, payload) => {
        sendUtil.send(win, payload)
      },
      showItemInFolder: shell.showItemInFolder,
    }),
    ...windowLifecycleService.getDocumentSessionRuntimeHostDeps(),
    publishOpenFailureSystemNotification: createDocumentOpenFailureNotificationPublisher({
      getConfig: () => configUtil.getConfig(),
      resolveWindowById: windowId => windowRegistry.getWindowById(windowId),
      listWindows: () => windowLifecycleService.listWindows(),
    }),
  })

  return documentSessionRuntime
}

const lock = app.requestSingleInstanceLock({
  filePath: getOpenOnFilePath(),
  // second-instance 打开相对路径时，首实例必须拿到发起实例自己的工作目录，
  // 才能把 `docs/demo.md` 这类路径解析到正确的绝对目标上。
  baseDir: process.cwd(),
})

if (!lock) {
  app.quit()
} else {
  /**
   * 把窗口拉回到「看得见」的位置。
   *
   * 触发场景：窗口被拖到屏幕上方/左侧之外（多显示器、高 DPI 下坐标偏差，
   * 或拔掉显示器后窗口仍记着旧坐标）。此后点任务栏、或者再次双击启动，
   * `show()` 只是把窗口标记为可见，它在可视区域之外 —— 用户看到的就是
   * 「点了任务栏，图标闪一下，窗口不出来」。
   *
   * 判定标准：与**任意**一个显示器工作区的重叠至少 100×60，才算看得见。
   * 不满足就按主显示器工作区重新居中，尺寸超出时先收缩到工作区大小。
   */
  function ensureWindowOnScreen(win) {
    if (!win || win.isDestroyed?.()) {
      return
    }
    if (win.isMaximized?.() || win.isFullScreen?.()) {
      return
    }

    const bounds = win.getBounds()
    const displayList = screen.getAllDisplays()
    const overlapped = displayList.some((display) => {
      const area = display.workArea
      const overlapWidth = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
      const overlapHeight = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y)
      return overlapWidth >= 100 && overlapHeight >= 60
    })
    if (overlapped) {
      return
    }

    const area = screen.getPrimaryDisplay().workArea
    const width = Math.min(bounds.width, area.width)
    const height = Math.min(bounds.height, area.height)
    win.setBounds({
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      width,
      height,
    })
    console.warn('[second-instance] 窗口在可视区域之外，已重新居中:', JSON.stringify({ from: bounds, to: win.getBounds() }))
  }

  app.on('second-instance', (event, commandLine, workingDirectory, additionalData) => {
    const openTarget = resolveSecondInstanceOpenTarget({ additionalData, commandLine })
    if (openTarget) {
      if (!additionalData) {
        // 命中上游单实例载荷缺陷（issue #59）时的诊断线索：载荷丢失但已回退 commandLine。
        console.warn('[second-instance] additionalData 为空，已回退 commandLine 解析打开路径:', openTarget.targetPath)
      }
      app.whenReady().then(async () => {
        const runtime = initializeAppDocumentSessionRuntime()
        const openResult = await handleSecondInstanceOpenRequest({
          targetPath: openTarget.targetPath,
          baseDir: openTarget.baseDir || workingDirectory || process.cwd(),
          // 双击文件 / 第二实例属于系统级打开：默认把它作为新标签开进最近活动的编辑窗口，
          // 一个窗口都没有时才新建窗口（由 effect 层回落）。
          openDocumentPath: (targetPath, options) => runtime.openDocumentPathAsTab(targetPath, options),
        })
        if (openResult?.ok !== true) {
          // 打开失败在无窗口上下文时没有弹窗出口，只能留一条日志便于排查。
          console.warn('[second-instance] 打开失败:', openTarget.targetPath, openResult)
        }
      }).then(() => {})
      return
    }
    app.whenReady().then(() => {
      const activeWindow = windowLifecycleService.listWindows()[0] || null
      if (!activeWindow) {
        return
      }
      // 顺序不能反：窗口在可视区域之外时，先 show() 用户什么也看不到；
      // 必须先把位置救回来再显示。
      ensureWindowOnScreen(activeWindow)
      activeWindow.show?.()
      activeWindow.focus?.()
    })
  })
  app.whenReady().then(async () => {
    // 旧数据迁移必须先于日志与配置初始化：
    // logUtil / recent / configRepository 的目录都改成惰性解析，迁移完成后才会指向新目录。
    try {
      await migrateLegacyUserData({ app, targetDir: resolveUserDataDir() })
    }
    catch (error) {
      // 迁移失败不能阻塞启动：新目录照常可用，下次启动重试。
      console.error('[Main] 旧用户数据迁移失败:', error)
    }
    logUtil.init()
    const runtime = initializeAppDocumentSessionRuntime()
    Menu.setApplicationMenu(null)
    await configUtil.initConfig((config) => {
      windowLifecycleService.listWindows().forEach((win) => {
        sendUtil.send(win, { event: 'update-config', data: config })
      })
      if (aboutUtil.get()) {
        sendUtil.send(aboutUtil.get(), { event: 'update-config', data: config })
      }
      if (exportUtil.get()) {
        sendUtil.send(exportUtil.get(), { event: 'update-config', data: config })
      }
      if (guideUtil.get()) {
        sendUtil.send(guideUtil.get(), { event: 'update-config', data: config })
      }
      if (settingUtil.get()) {
        sendUtil.send(settingUtil.get(), { event: 'update-config', data: config })
      }
    })
    await recent.initRecent(configUtil.getConfig().recentMax, (recentList) => {
      runtime.publishRecentListChanged(recentList)
    })
    await tabGroup.initTabGroup()
    // 窗口大小/位置记忆：必须在建首个窗口之前读好，createNew 时才能套用。
    await windowState.initWindowState()

    // 初始化协议处理器，捕获可能的错误
    try {
      protocolUtil.handleProtocol()
    } catch (protocolError) {
      console.error('[Main] CRITICAL: Protocol handler initialization failed')
      console.error('[Main] Error:', protocolError)
      console.error('[Main] Local file access (images, videos, audio) will not work')
      console.error('[Main] Application will continue but with limited functionality')
      // 应用继续运行，但本地资源加载功能将不可用
    }

    const openOnFilePath = getOpenOnFilePath()
    // 启动时恢复标签组的策略：
    // - never：不恢复，直接给空草稿窗口
    // - onStartup：仅直接启动时恢复（双击文件时不恢复）
    // - always：双击文件时也先恢复标签组，再把该文件作为新标签追加进去
    const restoreTabsMode = configUtil.getConfig().restoreTabs || 'onStartup'
    const shouldRestoreTabGroup = restoreTabsMode === 'always'
      || (restoreTabsMode === 'onStartup' && !openOnFilePath)

    let restoredWindowId = null
    if (shouldRestoreTabGroup) {
      // 重启恢复的是“上次打开的标签组”，而不是最近文件列表：
      // 两者是不同的事实，标签组不套 recentMax 上限。
      // 多栏并排后这里要读完整的多栏形态：get() 只给焦点栏，恢复分栏会丢栏。
      const savedTabGroups = typeof tabGroup.getGroups === 'function'
        ? tabGroup.getGroups()
        : { groups: [tabGroup.get()], focusedGroupIndex: 0 }
      const savedGroupList = Array.isArray(savedTabGroups.groups) ? savedTabGroups.groups : []
      const hasRestorableTabs = savedGroupList.some(group => (group?.tabs?.length || 0) > 0)
      if (hasRestorableTabs) {
        // 连 activeIndex 一起传：恢复后活动标签要回到上次停留的那个，
        // 不能总是落在最后一个恢复的标签上。
        const restoreResult = await windowLifecycleService.restoreTabGroups(savedTabGroups)
        if (restoreResult?.ok === true && restoreResult.windowId) {
          restoredWindowId = restoreResult.windowId
          const skippedPathList = Array.isArray(restoreResult.skippedPathList)
            ? restoreResult.skippedPathList
            : []
          if (skippedPathList.length > 0) {
            // 跳过提示由 restoreTabGroup 在窗口可渲染后统一发送，
            // 这里只保留启动日志，避免同一条提示重复推送。
            console.warn('[startup] 部分标签路径已失效，已跳过:', skippedPathList)
          }
        }
        else {
          console.warn('[startup] 标签组恢复失败:', restoreResult)
        }
      }
    }

    if (openOnFilePath) {
      if (restoredWindowId) {
        // always 模式：标签组已恢复，把双击文件作为新标签开进去。
        // openDocumentTabInWindow 内部走 resolveOpenExistingTab：
        // 该文件已经在标签组里时会激活原标签，不会重复打开。
        const openResult = await windowLifecycleService.openDocumentTabInWindow(
          restoredWindowId,
          openOnFilePath,
          { trigger: 'startup' },
        )
        if (openResult?.ok !== true) {
          // 保留已恢复的标签组，再补一个空草稿（createDraftTab 会自动激活它），
          // 并用一次性消息告知用户文件没打开。
          console.warn('[startup] 打开失败，已保留恢复的标签组:', openOnFilePath, openResult)
          await windowLifecycleService.createDraftTab(restoredWindowId)
          windowLifecycleService.publishWindowMessage(restoredWindowId, {
            type: 'warning',
            content: 'message.openDroppedFileFailed',
          })
        }
      }
      else {
        // never / onStartup 模式：只打开双击的那个文件；
        // 读取失败时回退为空草稿窗口。
        await handleStartupOpenRequest({
          targetPath: openOnFilePath,
          baseDir: process.cwd(),
          openDocumentPath: (targetPath, options) => runtime.openDocumentPath(targetPath, options),
          createDraftWindow: () => windowLifecycleService.createNew(null),
        })
      }
    }
    else if (!restoredWindowId) {
      // 空草稿窗口（Untitled）
      await windowLifecycleService.createNew(null)
    }
    await updateUtil.initUpdater(() => windowLifecycleService.listWindows())
  })
}
