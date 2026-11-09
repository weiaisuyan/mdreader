import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'
import configUtil from '../../data/configUtil.js'
import recent from '../../data/recent.js'
import { getDocumentSessionRuntime } from '../document-session/documentSessionRuntime.js'
import windowLifecycleService from '../document-session/windowLifecycleService.js'
import fileUploadUtil from '../fileUploadUtil.js'
import imgUtil from '../imgUtil.js'
import resourceFileUtil from '../resourceFileUtil.js'
import updateUtil from '../updateUtil.js'
import aboutUtil from '../win/aboutUtil.js'
import exportUtil from '../win/exportUtil.js'
import guideUtil from '../win/guideUtil.js'
import screenshotsUtil from '../win/screenshotsUtil.js'
import settingUtil from '../win/settingUtil.js'
import sendUtil from './sendUtil.js'

// 窗口最小尺寸。
//
// 原来是写死的 800×600，但布局实际需要多少宽度取决于是几栏、侧栏是否展开 ——
// 写死 800 的后果：二栏布局下窗口缩到 800 就停住，此时左栏还剩 300 多像素没缩到底，
// 用户看到的就是「缩到最小宽度之后还能再缩吗？缩不了了」。
//
// 现在改成由渲染层按实际布局算出最小内容宽度（见 resolveMinContentWidth），
// 通过 `set-min-content-width` 同步过来；这里保留一个绝对下限兜底。
const MIN_WINDOW_WIDTH = 800
const MIN_WINDOW_HEIGHT = 600
// 绝对下限：即使渲染层算出更小的值，窗口也不能比这更窄（否则顶栏按钮会挤爆）
const ABSOLUTE_MIN_WINDOW_WIDTH = 420

// 拖动窗口时的亚像素余量（按 windowId 存）。
// 渲染层发的是 DIP 位移，setPosition 收物理像素，150% 缩放下每帧差 0.5px；
// 余量攒着跨帧累加，否则长时间拖动会让窗口尺寸被系统反复矫正而胀大。
const moveWindowRemainderMap = new Map()

// 拖动窗口状态（按 windowId 存）：记录「鼠标相对窗口左上角的偏移」与「尺寸快照」。
// 拖动全程由主进程用 screen.getCursorScreenPoint() 自己读鼠标，渲染层不传坐标 ——
// 这样位移计算与 setBounds 处于同一坐标系，彻底消除 150% DPI 下的换算误差。
const windowDragStateMap = new Map()

/**
 * 每个窗口的动态最小宽度（按 windowId 存）。
 *
 * ⚠️ 不能存在 windowContext 上：`resolveWindowContextByBrowserWindow` 每次调用都返回
 * **新对象**，写在上面下一次就丢了（这次真踩了，导致窗口一直卡在 800）。
 */
const dynamicMinWidthMap = new Map()

function executeRuntimeUiCommand(windowContext, command, payload) {
  return getDocumentSessionRuntime().executeUiCommand(windowContext?.windowId || null, command, payload)
}

function executeRuntimeSyncQuery(windowContext, command, payload) {
  const windowId = windowContext?.windowId || null
  if (windowId == null) {
    // 兼容旧同步查询语义：窗口上下文缺失时平稳返回空值，
    // 让 renderer 继续回退到 rawPath，而不是把异常抛回同步 IPC 调用栈。
    return null
  }
  return getDocumentSessionRuntime().executeSyncQuery(windowId, command, payload)
}

function getCurrentDocumentPath(windowContext) {
  return windowLifecycleService.getDocumentContext(windowContext?.windowId || null)?.path || null
}

function resolveWindowContextByBrowserWindow(win) {
  const windowId = windowLifecycleService.getWindowIdByWin(win)
  if (windowId) {
    return {
      windowId,
      win: windowLifecycleService.getWindowById(windowId) || win,
    }
  }

  const parentWin = win?.getParentWindow?.() || null
  const parentWindowId = windowLifecycleService.getWindowIdByWin(parentWin)
  if (parentWindowId) {
    return {
      windowId: parentWindowId,
      win: windowLifecycleService.getWindowById(parentWindowId) || parentWin,
    }
  }

  return {
    windowId: null,
    win: null,
  }
}

function resolveWindowContextFromSender(sender) {
  const win = BrowserWindow.fromWebContents(sender)
  return resolveWindowContextByBrowserWindow(win)
}

function createWindowMessageNotifier(win) {
  return (message) => {
    sendUtil.send(win, { event: 'message', data: message })
  }
}

/**
 * 顶栏按钮依赖 renderer store 的窗口状态镜像。
 * 当宿主命令是 no-op 或 renderer 已经漂移时，需要主动回灌一次真实窗口状态来纠偏。
 */
function republishHostWindowState(windowContext) {
  const windowId = windowContext?.windowId ?? null
  if (windowId == null) {
    return null
  }

  return windowLifecycleService.publishHostWindowStateByWindowId(windowId)
}

async function uploadImage(windowContext, data) {
  const config = configUtil.getConfig()
  const documentPath = getCurrentDocumentPath(windowContext)
  const notify = createWindowMessageNotifier(windowContext.win)
  if (!imgUtil.check({
    win: windowContext.win,
    documentPath,
    data,
    config,
    notify,
  })) {
    return
  }
  data.name = data.name ? data.name : 'image.png'
  if (!path.extname(data.name)) {
    data.name += '.png'
  }
  return imgUtil.save({
    win: windowContext.win,
    documentPath,
    data,
    config,
    notify,
  })
}

/**
 * 资源打开失败后，统一经由 session bridge 下发一次性提示。
 *
 * 路径解析、query/hash 回退和未保存文档判定都必须交给 documentResourceService，
 * IPC 层只负责把结构化结果翻译成当前 renderer 已收口的 `window.effect.message` 契约。
 */
async function handleResourceOpen(windowContext, data) {
  const openResult = await executeRuntimeUiCommand(windowContext, 'document.resource.open-in-folder', data)
  if (!openResult) {
    return openResult
  }

  if (openResult.ok !== true) {
    const messageKey = resourceFileUtil.getLocalResourceFailureMessageKey(openResult.reason)
    if (messageKey) {
      windowLifecycleService.publishWindowMessage(windowContext.windowId, {
        type: 'warning',
        content: messageKey,
      })
    }
    return openResult
  }

  if (openResult.opened !== true && openResult.reason === 'not-found') {
    windowLifecycleService.publishWindowMessage(windowContext.windowId, {
      type: 'warning',
      content: 'message.theFileDoesNotExist',
    })
  }
  return openResult
}

/**
 * 配置类更新 IPC 统一透传结构化结果。
 */
async function executeConfigUpdate(updateAction) {
  const result = await updateAction()
  if (result?.ok !== true) {
    return result
  }

  return result
}

const handlerList = {
  ...settingUtil.channel,
  ...aboutUtil.channel,
  ...guideUtil.channel,
  'export-start': (windowContext, data) => {
    const exportRequest = typeof data === 'string'
      ? { type: data, target: 'file' }
      : (data || {})

    return exportUtil.createExportWin({
      parentWindow: windowContext.win,
      documentContext: windowLifecycleService.getDocumentContext(windowContext.windowId),
      type: exportRequest.type,
      target: exportRequest.target,
      notify: createWindowMessageNotifier(windowContext.win),
    })
  },
  'export-end': (windowContext, data) => {
    return exportUtil.doExport({
      data,
      notify: createWindowMessageNotifier(windowContext.win),
    })
  },
  'open-dir-select': () => {
    const dirList = dialog.showOpenDialogSync({
      title: 'Select Folder',
      properties: ['openDirectory'],
    })
    return dirList && dirList.length > 0 ? dirList[0] : undefined
  },
  'minimize': (windowContext) => {
    windowContext.win.minimize()
  },
  'maximize': (windowContext) => {
    windowContext.win.maximize()
    republishHostWindowState(windowContext)
  },
  /**
   * 移动窗口。
   *
   * 圆角窗口必须 transparent，而 Windows 的透明窗口会丢掉系统自带的标题栏拖动与
   * 双击最大化，所以拖动改成渲染层驱动：指针移动 → 这里 setPosition。
   *
   * ⚠️ 支持两种模式：
   * - `{ dx, dy }`（**推荐**）：相对位移。以主进程当前真实位置为基准累加。
   * - `{ x, y }`：绝对坐标（旧协议，保留兼容）。
   *
   * 为什么推荐相对位移：渲染层的 `window.screenX` 是**客户区**坐标，而 `setPosition`
   * 设置的是**外框**坐标。150% DPI 缩放下两者差约 9px（外框有透明边距），
   * 用绝对坐标时每帧都从「客户区坐标」重新算目标，误差逐帧累积 ——
   * 实测拖 150px 窗口宽高各涨 18/14px，拖得越远胀得越大。
   * 相对位移每帧只取增量，以主进程真实位置为基准，不会累积。
   *
   * @param {object} windowContext 窗口上下文
   * @param {{ x?: number, y?: number, dx?: number, dy?: number }} data 目标位置或位移
   */
  'move-window': (windowContext, data) => {
    const win = windowContext.win
    if (!win || win.isDestroyed?.() || win.isMaximized?.() === true || win.isFullScreen?.() === true) {
      return
    }
    // 绝对坐标：直接落位（旧协议，保留兼容）
    if (Number.isFinite(data?.x) && Number.isFinite(data?.y) && !Number.isFinite(data?.dx) && !Number.isFinite(data?.dy)) {
      win.setPosition(Math.round(data.x), Math.round(data.y))
      return
    }

    // ---- 拖动：全程只在主进程里算，不用渲染层传来的坐标 ----
    //
    // 之前 6 个版本都在「渲染层 screenX ↔ 主进程 DIP/物理像素」之间换算，
    // 150% DPI + transparent + frame:false 下怎么算都会让宽度跟着 +dx。
    // 根因是两套坐标系不同源：渲染层的 screenX 是 CSS 像素、主进程 setBounds 收 DIP，
    // 窗口还有透明边框偏移 —— 换算式永远对不齐。
    //
    // 现在改成：主进程用 screen.getCursorScreenPoint() 自己读鼠标（与 setBounds 同一坐标系），
    // 渲染层只发 `move-window-start` / `move-window` / `move-window-end` 三个信号，
    // **一个坐标都不传**。这样位移完全在同一坐标系里做差，不存在换算误差。
    //
    // 尺寸锁死：每帧都用 setBounds 一次写全 x/y/width/height，
    // 宽高取「按下那一刻」的快照，任何情况下都不变。
    const key = windowContext?.windowId ?? 'default'
    const dragState = windowDragStateMap.get(key)

    if (data?.phase === 'start') {
      const bounds = win.getBounds()
      const cursor = screen.getCursorScreenPoint()
      windowDragStateMap.set(key, {
        // 记下「鼠标屏幕坐标 − 窗口左上角」的偏移，之后每帧保持这个偏移不变
        offsetX: cursor.x - bounds.x,
        offsetY: cursor.y - bounds.y,
        // 尺寸快照：整个拖动过程只用这一份，绝不重新读取
        width: bounds.width,
        height: bounds.height,
      })
      return
    }

    if (data?.phase === 'end') {
      windowDragStateMap.delete(key)
      return
    }

    if (!dragState) {
      return
    }

    const cursor = screen.getCursorScreenPoint()
    win.setBounds({
      x: Math.round(cursor.x - dragState.offsetX),
      y: Math.round(cursor.y - dragState.offsetY),
      width: dragState.width,
      height: dragState.height,
    }, false)
  },
  /**
   * 边缘缩放。
   *
   * 圆角窗口必须 `transparent: true`，而透明窗口在 Windows 上会丢掉系统自带的
   * 边缘拖拽缩放（鼠标放到窗口边缘不会有缩放光标）。这里由渲染层在边缘放热区，
   * 拖动时把期望的屏幕矩形发过来，主进程用 setBounds 落地。
   *
   * @param {object} windowContext 窗口上下文
   * @param {{ x?: number, y?: number, width?: number, height?: number }} data 目标矩形
   */
  /**
   * 同步「内容区最小宽度」。
   *
   * 布局需要多少宽度取决于栏数与侧栏显隐（单栏 482px、双栏 646px、四栏 974px…），
   * 写死一个 800 会让某些布局缩不到底。渲染层每次布局变化时把值算好发过来，
   * 主进程据此更新窗口的 minWidth。
   *
   * @param {object} windowContext 窗口上下文
   * @param {number} data 内容区最小宽度（px）
   */
  'set-min-content-width': (windowContext, data) => {
    const win = windowContext.win
    if (!win || win.isDestroyed?.()) {
      return
    }
    const requested = Number(data)
    if (!Number.isFinite(requested) || requested <= 0) {
      return
    }
    const nextMinWidth = Math.max(ABSOLUTE_MIN_WINDOW_WIDTH, Math.round(requested))
    // 按 windowId 存（windowContext 每次都是新对象，存上面会丢）
    dynamicMinWidthMap.set(windowContext?.windowId ?? 'default', nextMinWidth)
    win.setMinimumSize?.(nextMinWidth, MIN_WINDOW_HEIGHT)
  },
  'resize-window': (windowContext, data) => {
    const win = windowContext.win
    if (!win || win.isDestroyed?.() || win.isMaximized?.() === true || win.isFullScreen?.() === true) {
      return
    }
    const current = win.getBounds()
    const next = {
      x: Number.isFinite(data?.x) ? Math.round(data.x) : current.x,
      y: Number.isFinite(data?.y) ? Math.round(data.y) : current.y,
      width: Number.isFinite(data?.width) ? Math.round(data.width) : current.width,
      height: Number.isFinite(data?.height) ? Math.round(data.height) : current.height,
    }
    // 用动态下限：布局需要多宽就允许缩到多宽（渲染层定期同步），
    // 没有同步过时退回默认值。
    const effectiveMinWidth = Math.max(
      ABSOLUTE_MIN_WINDOW_WIDTH,
      Number.isFinite(dynamicMinWidthMap.get(windowContext?.windowId ?? 'default'))
        ? dynamicMinWidthMap.get(windowContext?.windowId ?? 'default')
        : MIN_WINDOW_WIDTH,
    )
    next.width = Math.max(next.width, effectiveMinWidth)
    next.height = Math.max(next.height, MIN_WINDOW_HEIGHT)
    win.setBounds(next)
  },
  'restore': (windowContext) => {
    if (windowContext.win.isMinimized?.() === true) {
      windowContext.win.restore()
    } else if (windowContext.win.isFullScreen?.() === true) {
      windowContext.win.setFullScreen(false)
    } else if (windowContext.win.isMaximized?.() === true) {
      windowContext.win.unmaximize()
    }
    republishHostWindowState(windowContext)
  },
  'full-screen': (windowContext, flag) => {
    if (typeof flag !== 'boolean') {
      return
    }
    windowContext.win.setFullScreen(flag)
  },
  'always-on-top': (windowContext, isAlwaysOnTop) => {
    windowContext.win.setAlwaysOnTop(isAlwaysOnTop)
  },
  'close': (windowContext) => {
    windowContext.win.close()
  },
  'force-close': (windowContext) => {
    windowLifecycleService.requestForceClose(windowContext.windowId)
    windowContext.win.close()
  },
  'document.open-in-folder': async (windowContext, data) => {
    // 标签右键菜单会显式给出目标路径：那个标签可能不是活动标签，
    // 回退到“当前活动文档”会打开错误文件所在的目录。
    const explicitPath = typeof data?.path === 'string' && data.path.trim() !== ''
      ? data.path.trim()
      : null

    if (explicitPath) {
      if (fs.existsSync(explicitPath) !== true) {
        return {
          ok: false,
          opened: false,
          reason: 'not-found',
          path: explicitPath,
        }
      }
      shell.showItemInFolder(explicitPath)
      return {
        ok: true,
        opened: true,
        reason: 'opened',
        path: explicitPath,
      }
    }

    const documentContext = windowLifecycleService.getDocumentContext(windowContext.windowId)
    if (!documentContext.path || !documentContext.exists) {
      return {
        ok: false,
        opened: false,
        reason: 'document-not-saved',
        path: null,
      }
    }
    shell.showItemInFolder(documentContext.path)
    return {
      ok: true,
      opened: true,
      reason: 'opened',
      path: documentContext.path,
    }
  },
  'document.resource.open-in-folder': async (windowContext, data) => await handleResourceOpen(windowContext, data),
  'document.resource.copy-absolute-path': async (windowContext, data) => await executeRuntimeUiCommand(windowContext, 'document.resource.copy-absolute-path', data),
  'document.resource.copy-link': async (windowContext, data) => await executeRuntimeUiCommand(windowContext, 'document.resource.copy-link', data),
  'document.resource.copy-image': async (windowContext, data) => await executeRuntimeUiCommand(windowContext, 'document.resource.copy-image', data),
  'document.resource.save-as': async (windowContext, data) => await executeRuntimeUiCommand(windowContext, 'document.resource.save-as', data),
  // renderer 已经切到新的 session 命令名，这里只保留直连入口。
  'document.save-copy': async windowContext => await executeRuntimeUiCommand(windowContext, 'document.save-copy', null),
  'document.save': async windowContext => await executeRuntimeUiCommand(windowContext, 'document.save', null),
  // 必须透传 data：payload.scope === 'tab' 决定“保存并关闭”关的是标签还是整个窗口，
  // 丢掉它会让关单个标签的确认弹窗退化成关窗口，保存完成后直接退出程序。
  'document.save-and-close': async (windowContext, data) => await executeRuntimeUiCommand(windowContext, 'document.save-and-close', data),
  'document.get-session-snapshot': async (windowContext) => {
    return await executeRuntimeUiCommand(windowContext, 'document.get-session-snapshot', null)
  },
  'file-manager.get-directory-state': async (windowContext, data) => {
    return await executeRuntimeUiCommand(windowContext, 'file-manager.get-directory-state', data)
  },
  'file-manager.open-directory': async (windowContext, data) => {
    return await executeRuntimeUiCommand(windowContext, 'file-manager.open-directory', data)
  },
  'file-manager.sync-current-directory-options': async (windowContext, data) => {
    return await executeRuntimeUiCommand(windowContext, 'file-manager.sync-current-directory-options', data)
  },
  'file-manager.create-folder': async (windowContext, data) => {
    return await executeRuntimeUiCommand(windowContext, 'file-manager.create-folder', data)
  },
  'file-manager.create-markdown': async (windowContext, data) => {
    return await executeRuntimeUiCommand(windowContext, 'file-manager.create-markdown', data)
  },
  'document.edit': async (windowContext, data) => await executeRuntimeUiCommand(windowContext, 'document.edit', data),
  // 渲染层收敛完正文后的回流：主进程据此结束“关窗口前等待正文”的挂起。
  // 不走命令流：它只结算宿主侧的 Promise，不推进任何会话状态。
  'document.flush-ack': async (windowContext, data) => {
    return windowLifecycleService.handleFlushAck(windowContext?.windowId, data)
  },
  'document.cancel-close': async windowContext => await executeRuntimeUiCommand(windowContext, 'document.cancel-close', null),
  'document.confirm-force-close': async windowContext => await executeRuntimeUiCommand(windowContext, 'document.confirm-force-close', null),
  'document.external.apply': async (windowContext, data) => await executeRuntimeUiCommand(windowContext, 'document.external.apply', data),
  'document.external.ignore': async (windowContext, data) => await executeRuntimeUiCommand(windowContext, 'document.external.ignore', data),
  'create-new': async (windowContext) => {
    // “新建”现在只新建当前窗口的草稿标签；
    // 没有可用窗口时（例如从菜单触发）才回退成新开窗口。
    const created = windowContext?.windowId != null
      ? await windowLifecycleService.createDraftTab(windowContext.windowId)
      : false
    if (!created) {
      await windowLifecycleService.createNew()
    }
  },
  'create-new-window': async () => {
    await windowLifecycleService.createNew()
  },
  'document.request-open-dialog': async (windowContext) => {
    return await executeRuntimeUiCommand(windowContext, 'document.request-open-dialog', null)
  },
  'document.resolve-open-target': async (windowContext, data) => {
    return await executeRuntimeUiCommand(windowContext, 'document.resolve-open-target', data)
  },
  'document.prepare-open-path-in-current-window': async (windowContext, data) => {
    return await executeRuntimeUiCommand(windowContext, 'document.prepare-open-path-in-current-window', data)
  },
  'document.open-path': async (windowContext, data) => {
    return await executeRuntimeUiCommand(windowContext, 'document.open-path', data)
  },
  'document.open-path-in-current-window': async (windowContext, data) => {
    return await executeRuntimeUiCommand(windowContext, 'document.open-path-in-current-window', data)
  },
  'document.activate-tab': async (windowContext, data) => {
    return await executeRuntimeUiCommand(windowContext, 'document.activate-tab', data)
  },
  'document.close-tab': async (windowContext, data) => {
    return await executeRuntimeUiCommand(windowContext, 'document.close-tab', data)
  },
  'document.close-tabs': async (windowContext, data) => {
    return await executeRuntimeUiCommand(windowContext, 'document.close-tabs', data)
  },
  'document.move-tab-to-new-window': async (windowContext, data) => {
    return await executeRuntimeUiCommand(windowContext, 'document.move-tab-to-new-window', data)
  },
  'document.reorder-tabs': async (windowContext, data) => {
    return await executeRuntimeUiCommand(windowContext, 'document.reorder-tabs', data)
  },
  // 多栏并排：标签组维度的四个入口，与窗口级标签命令并列。
  'document.create-group': async (windowContext, data) => {
    return await executeRuntimeUiCommand(windowContext, 'document.create-group', data)
  },
  'document.activate-group': async (windowContext, data) => {
    return await executeRuntimeUiCommand(windowContext, 'document.activate-group', data)
  },
  'document.move-tab-to-group': async (windowContext, data) => {
    return await executeRuntimeUiCommand(windowContext, 'document.move-tab-to-group', data)
  },
  'document.close-group': async (windowContext, data) => {
    return await executeRuntimeUiCommand(windowContext, 'document.close-group', data)
  },
  'get-config': () => {
    return configUtil.getConfig()
  },
  'upload-image': async (windowContext, data) => {
    return await uploadImage(windowContext, data)
  },
  'document.resource.delete-local': async (windowContext, data) => await executeRuntimeUiCommand(windowContext, 'document.resource.delete-local', data),
  'resource.get-info': async (windowContext, data) => await executeRuntimeUiCommand(windowContext, 'resource.get-info', data),
  'screenshot': (windowContext, data) => {
    return new Promise((resolve) => {
      const startCapture = () => {
        return new Promise((resolveInner) => {
          screenshotsUtil.startCapture((base64) => {
            uploadImage(windowContext, { mode: 'local', base64, name: 'image.png' }).then((res) => {
              resolveInner(res)
            })
          }, () => {
            if (data.hide === true) {
              windowContext.win.show()
            }
          })
        })
      }
      if (data.hide === true) {
        windowContext.win.minimize()
        setTimeout(() => {
          startCapture().then((res) => {
            resolve(res)
          })
        }, 200)
      } else {
        startCapture().then((res) => {
          resolve(res)
        })
      }
    })
  },
  'config.update': async (_windowContext, data) => {
    return await executeConfigUpdate(async () => await configUtil.updateConfig(data, recent))
  },
  'app-info': () => {
    return { name: 'wj-markdown-editor', version: app.getVersion() }
  },
  'get-default-config': () => {
    return configUtil.getDefaultConfig()
  },
  'get-app-info': () => {
    return { name: 'wj-markdown-editor', version: app.getVersion() }
  },
  'check-update': async () => {
    return await updateUtil.checkUpdate(windowLifecycleService.listWindows())
  },
  'download-update': () => {
    updateUtil.downloadUpdate(aboutUtil.get())
  },
  'cancel-download-update': () => {
    updateUtil.cancelDownloadUpdate()
  },
  'execute-update': () => {
    updateUtil.executeUpdate()
  },
  'recent.clear': async windowContext => await executeRuntimeUiCommand(windowContext, 'recent.clear', null),
  'recent.remove': async (windowContext, data) => await executeRuntimeUiCommand(windowContext, 'recent.remove', data),
  'recent.get-list': async windowContext => await executeRuntimeUiCommand(windowContext, 'recent.get-list', null),
  'file-upload': (windowContext, filePath) => {
    return fileUploadUtil.save({
      win: windowContext.win,
      documentPath: getCurrentDocumentPath(windowContext),
      filePath,
      config: configUtil.getConfig(),
      notify: createWindowMessageNotifier(windowContext.win),
    })
  },
  'get-global-theme': () => {
    return configUtil.getConfig().theme.global
  },
  // 启动恢复跳过列表是一次性提示：渲染层启动后主动消费一次，
  // 主进程返回后立即清空，组件重挂载/页面刷新都不会重复弹窗。
  'window.consume-startup-skipped-tabs': (windowContext) => {
    return windowLifecycleService.consumeStartupSkippedPathList(windowContext.windowId)
  },
}

const handlerListSync = {
  'convert-to-absolute-path': (windowContext, filePath) => {
    if (path.isAbsolute(filePath)) {
      return filePath
    }
    const documentContext = windowLifecycleService.getDocumentContext(windowContext.windowId)
    if (documentContext.path) {
      return path.resolve(path.dirname(documentContext.path), filePath)
    }
    return null
  },
  'resource.get-comparable-key': (windowContext, rawPath) => {
    return executeRuntimeSyncQuery(windowContext, 'resource.get-comparable-key', rawPath)
  },
}

ipcMain.handle('sendToMain', async (event, json) => {
  if (handlerList[json.event]) {
    return await handlerList[json.event](resolveWindowContextFromSender(event.sender), json.data)
  }
  return false
})

ipcMain.on('sendToMainSync', (event, json) => {
  if (handlerListSync[json.event]) {
    event.returnValue = handlerListSync[json.event](resolveWindowContextFromSender(event.sender), json.data)
    return
  }
  event.returnValue = null
})
