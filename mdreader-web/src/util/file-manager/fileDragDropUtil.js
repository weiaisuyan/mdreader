import { ref } from 'vue'
import channelUtil from '@/util/channel/channelUtil.js'
import { requestDocumentActivateTab, requestDocumentCloseTab, requestDocumentCreateGroup, requestDocumentMoveTabToGroup, requestDocumentOpenPathInCurrentWindow } from '@/util/document-session/rendererDocumentCommandUtil.js'
import { requestDocumentOpenPathByInteraction } from '@/util/document-session/documentOpenInteractionService.js'
import { MIN_PANE_WIDTH, PANE_GUTTER_WIDTH, halvePaneWidths } from '@/util/document-session/paneLayoutUtil.js'
import { createSetConfigPathRequest, sendConfigMutationRequest } from '@/util/config/configMutationCommandUtil.js'

/**
 * 文件列表 → 编辑区/标签区的拖放打开。
 *
 * 产品规则（用户明确要求）：
 * 1. 拖到某一栏的标签区或编辑区，就在**那一栏**把它显示出来；
 * 2. 同一个窗口里**绝不能同时有两个相同文件的标签**——文件已经在本窗口打开时，
 *    松手只是把那个已有标签切到前台（去重由主进程的 open-path 链路裁决，
 *    渲染层不自己再存一份「打开过谁」的名单，否则双份事实必然漂移）；
 * 3. 不同窗口互不影响：同一个文件可以在多个窗口里各开一个标签，这里不做任何跨窗口限制。
 */
export const FILE_PATH_MIME = 'application/x-wj-file-path'

/** 「这个文件本来就已经打开」类结果：不该再分栏，只聚焦。 */
const ALREADY_OPEN_REASON_SET = new Set([
  'activated-existing-tab',
  'focused-existing-window',
  'noop-current-file',
])

/**
 * 打开目标本身有问题时的提示语 key。
 *
 * 主进程只返回结构化 reason，渲染层必须翻译成一句人话，
 * 否则用户「拖了个已经不存在的文件」会完全没反应。
 */
const OPEN_FAILURE_MESSAGE_KEY_MAP = {
  'open-target-missing': 'message.fileManagerOpenTargetMissing',
  'open-target-not-file': 'message.fileManagerOpenTargetNotFile',
  'open-target-read-failed': 'message.fileManagerOpenTargetReadFailed',
  // 打开链路本身抛异常（IPC 失败等）：必须给用户一个可见的失败提示，
  // 否则拖进来的文件既没打开、也没报错，看起来像「拖拽坏了」。
  'open-request-failed': 'message.fileManagerOpenFailed',
}

/**
 * 把打开失败的 reason 翻成提示语 key。
 *
 * @param {string | undefined} reason 主进程返回的失败原因
 * @returns {string | null} i18n key；不是「目标有问题」类失败返回 null
 */
export function resolveOpenFailureMessageKey(reason) {
  return OPEN_FAILURE_MESSAGE_KEY_MAP[reason] || null
}

/**
 * 拖拽期间的内存兜底。
 *
 * 正常情况下走 dataTransfer；某些环境的 drop 事件拿不到自定义 MIME，
 * 所以在同一次拖拽内额外记一份路径，drop 时优先读 dataTransfer、读不到再用它。
 */
let draggingFilePath = null

/**
 * 是否正在从文件列表拖拽文件。
 *
 * 用途：Electron 的 `-webkit-app-region: drag` 区域不派发 dragover/drop，
 * 但用户既要「顶栏空白能拖窗口」，又要「能把文件拖进标签栏」。
 * 这两件事可以共存——做法是**只在拖拽期间**把标签栏临时切成 `no-drag`
 * （拖拽时没人需要拖窗口），松手/取消后再切回 `drag`。
 */
export const isFileDragActive = ref(false)

// 拖拽状态的安全看门狗：任何「dragend 没派发」的异常路径（源元素在拖拽中被卸载、
// 拖出应用后被系统吞掉、渲染进程短暂卡顿）都会让标签栏永久停在 no-drag，
// 用户从此不能拖窗口。超时强制复位，代价只是极长拖拽时可能提前让出一次。
const DRAG_STATE_TIMEOUT_MS = 10000
let dragStateWatchdog = null

// 用 body 上的类同步切换，不依赖 Vue 的下一帧渲染：
// 快速拖拽时「dragstart → 第一次 dragover」可能只隔十几毫秒，
// 等响应式 class 生效会错过这一帧，第一次 dragover 仍被当成不可放置。
const DRAG_BODY_CLASS = 'wj-file-dragging'

let globalDragEndListenersBound = false

function bindGlobalDragEndListeners() {
  if (globalDragEndListenersBound || typeof window === 'undefined') {
    return
  }
  globalDragEndListenersBound = true
  // 只监听 dragend：按 HTML 规范它一定在 drop 之后派发，
  // 而在 window 捕获阶段监听 drop 会**抢在**页面自己的 drop 处理之前把
  // draggingFilePath 清空，导致依赖兜底路径的那条分支失效。
  window.addEventListener('dragend', endFileDrag, true)
  // 窗口失焦（Alt+Tab 切走再松手）不一定有 dragend，兜一层
  window.addEventListener('blur', endFileDrag)
}

function clearDragStateWatchdog() {
  if (dragStateWatchdog) {
    clearTimeout(dragStateWatchdog)
    dragStateWatchdog = null
  }
}

function setDragBodyClass(active) {
  if (typeof document === 'undefined' || !document.body) {
    return
  }
  document.body.classList.toggle(DRAG_BODY_CLASS, active)
}

/**
 * 路径形态校验。
 *
 * 拖放时 `text/plain` 可能是任意文本（从浏览器拖一段文字过来很常见），
 * 不校验就会把那段文字当成路径去打开，弹一句「文件不存在」的错提示。
 *
 * 三类都认：Windows 盘符、UNC 共享、POSIX 绝对路径。
 * POSIX 分支必须加 —— Linux/macOS 构建下内部拖拽写入的就是 `/home/...` 这种路径，
 * 缺了它整套文件拖放会完全失效（返回 null → 事件冒泡到编辑器）。
 * Windows 上 `/foo` 不是合法绝对路径，多认一条也不会误判真实场景。
 *
 * @param {string} value 待校验字符串
 * @returns {boolean} 是否像本地绝对路径（盘符 / UNC / POSIX）
 */
function looksLikeFilePath(value) {
  const text = String(value || '')
  if (!text) {
    return false
  }
  return /^[A-Za-z]:[\\/]/.test(text)
    || /^\\\\[^\\]/.test(text)
    || /^\/[^/]/.test(text)
}

/**
 * 开始拖动某个文件：把路径写进 dataTransfer，并记一份内存兜底。
 *
 * @param {string} path 文件绝对路径
 * @param {DragEvent} event 原生 dragstart 事件
 * @returns {boolean} 是否真的发起了拖拽
 */
/**
 * 拖拽时显示的浮层：只画文件名，不用浏览器默认的「拖拽元素快照」。
 *
 * 不设 drag image 时，Chromium 会把**被拖的那个列表项整块**做成半透明快照跟着指针走 ——
 * 文件列表项里如果带缩略图，用户看到的就是一张文件内容缩略图，完全认不出自己在拖哪个文件。
 *
 * 这里现造一个只含文件名的小块交给 `setDragImage`。
 * 约束：
 * 1. 元素必须已经在文档里并且有布局，否则浏览器取不到快照（不能用 `display:none`），
 *    所以放在屏幕外 `top:-1000px` 而不是隐藏；
 * 2. 快照是同步取的，移除必须推迟到下一轮事件循环，否则等于没设。
 *
 * @param {DataTransfer} dataTransfer 拖拽数据对象
 * @param {string} path 被拖文件的绝对路径
 */
function applyFileNameDragImage(dataTransfer, path) {
  try {
    const fileName = String(path).split(/[\/]/).pop() || path
    const ghost = document.createElement('div')
    ghost.textContent = fileName
    ghost.setAttribute('aria-hidden', 'true')
    ghost.style.cssText = [
      'position:fixed',
      'top:-1000px',
      'left:-1000px',
      'max-width:240px',
      'padding:4px 10px',
      'border-radius:6px',
      'background:var(--wj-markdown-bg-secondary, #1b1722)',
      'color:var(--wj-markdown-text-primary, #e6e6e6)',
      'border:1px solid var(--wj-window-border, rgba(14, 210, 247, 0.5))',
      'font-size:13px',
      'line-height:20px',
      'white-space:nowrap',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'box-shadow:0 4px 12px rgba(0, 0, 0, 0.35)',
      'pointer-events:none',
    ].join(';')
    document.body.appendChild(ghost)
    dataTransfer.setDragImage(ghost, 12, 14)
    setTimeout(() => { ghost.remove() }, 0)
  } catch {
    // 设置失败就用浏览器默认行为，不影响拖拽本身
  }
}

export function startFileDrag(path, event) {
  if (typeof path !== 'string' || !path) {
    return false
  }
  draggingFilePath = path
  // 拖拽期间把「窗口拖拽区」临时让出来，标签栏才能接收这个文件。
  // 同步改 body class（当帧生效）+ 响应式状态（供组件做高亮等判断）。
  isFileDragActive.value = true
  setDragBodyClass(true)
  bindGlobalDragEndListeners()

  clearDragStateWatchdog()
  dragStateWatchdog = setTimeout(endFileDrag, DRAG_STATE_TIMEOUT_MS)

  const dataTransfer = event?.dataTransfer
  if (dataTransfer) {
    dataTransfer.setData(FILE_PATH_MIME, path)
    dataTransfer.setData('text/plain', path)
    dataTransfer.effectAllowed = 'copy'
    applyFileNameDragImage(dataTransfer, path)
  }
  return true
}

/** 拖拽结束（无论成功与否）都要复位：清掉兜底路径，并把窗口拖拽区还回去。 */
export function endFileDrag() {
  draggingFilePath = null
  clearDragStateWatchdog()
  if (isFileDragActive.value) {
    isFileDragActive.value = false
  }
  setDragBodyClass(false)
}

/**
 * 从 drop/dragover 事件里解出被拖进来的文件路径。
 *
 * @param {DragEvent} event 原生拖放事件
 * @returns {string | null} 路径；不是本应用的文件拖拽则返回 null
 */
export function resolveDroppedFilePath(event) {
  const dataTransfer = event?.dataTransfer
  const fromTransfer = dataTransfer?.getData?.(FILE_PATH_MIME) || ''
  const candidate = String(fromTransfer || draggingFilePath || '').trim()
  if (candidate && looksLikeFilePath(candidate)) {
    return candidate
  }

  // 自定义 MIME 与内存兜底都拿不到时，再看 text/plain（外部拖入常见），
  // 但必须过路径形态校验，否则会把拖进来的普通文字当文件路径。
  const fromPlainText = String(dataTransfer?.getData?.('text/plain') || '').trim()
  if (fromPlainText && looksLikeFilePath(fromPlainText)) {
    return fromPlainText
  }

  // 从**资源管理器**（或其它外部程序）拖进来的文件：dataTransfer 里只有 File 对象，
  // 拿不到自定义 MIME，text/plain 在部分环境也是空。
  //
  // ⚠️ Electron 32 起已经**移除** `File.path`，直接读 `first.path` 永远是空字符串，
  // 于是外部拖入会被判成「没有路径」→ 分栏逻辑整个跳过 → 文件落到旧路径里
  // （只在当前聚焦栏打开，看起来就是「预览说分栏，松手却合并回一栏」）。
  // 必须走 preload 暴露的 `webUtils.getPathForFile`。
  const fileList = dataTransfer?.files
  if (fileList && fileList.length > 0) {
    const first = fileList[0]
    let filePath = ''
    try {
      filePath = String(channelUtil.getWebFilePath?.(first) || '').trim()
    } catch (error) {
      filePath = ''
    }
    // 老版本 Electron 的兜底（32 以下才有 .path）
    if (!filePath) {
      filePath = String(first?.path || '').trim()
    }
    if (filePath && looksLikeFilePath(filePath)) {
      return filePath
    }
  }

  return null
}

/**
 * 把被拖进来的文件打开到指定栏。
 *
 * 先聚焦目标栏，再走统一打开流程（`openMode: 'new-tab'`）：
 * 主进程会先判断这个文件在本窗口里是否已经有标签，有就聚焦那个标签、
 * 不会新建第二个——正是「一个窗口里不能同时显示两份同一文件」的落点。
 *
 * @param {string | null} path 文件路径
 * @param {string | null} groupId 目标栏
 * @returns {Promise<object>} 打开结果
 */
/**
 * 这一栏是不是「只剩一个空白标签」—— 也就是一个新建后什么都没做的文档。
 *
 * 这种栏不该被当成「有内容的目标栏」去分栏：用户从文件列表往一个空白标签上拖文件，
 * 意图显然是「就在这儿打开」，而不是「把它劈成两栏，左边留个空白标签」。
 *
 * 三条同时成立才算空白：
 * 1. 这一栏只有一个标签；
 * 2. 该标签没有关联任何文件路径（新建未保存）；
 * 3. 没有未保存的修改 —— 用户只要打过字，就不能被拖进来的文件顶掉。
 *
 * @param {object | null | undefined} pane 栏快照（含 tabs 数组）
 * @returns {boolean} 是否可以由拖入的文件直接顶替
 */
export function isPaneReusableBlank(pane) {
  const tabs = Array.isArray(pane?.tabs) ? pane.tabs : []
  if (tabs.length !== 1) {
    return false
  }
  const tab = tabs[0]
  if (!tab) {
    return false
  }
  if (tab.displayPath) {
    return false
  }
  return tab.dirty !== true
}

/**
 * 把拖入的文件开进某一栏，并顶替掉那一栏的空标签。
 *
 * 先 open 再关空标签：打开失败时空白标签必须还在，不能先删后开（那样一旦打开失败，
 * 用户连那个空白标签都没了）。
 *
 * @param {string} path 文件绝对路径
 * @param {object} pane 目标栏快照
 * @param {object} store 渲染层 store
 * @returns {Promise<object>} 打开结果
 */
export async function openDroppedFileReplacingBlank(path, pane, store = null) {
  const blankSessionId = pane?.tabs?.[0]?.sessionId ?? null
  const result = await openDroppedFileInGroup(path, pane?.groupId, store)

  /**
   * `request-invalidated` 必须和 `ok === true` 一样当作「打开了」。
   *
   * 打开文件会切换当前会话，HomeView 里监听 sessionId 的 watch 会
   * `invalidateActiveRequest()`，于是 open 的返回值被判成失效 —— 但文件往往已经
   * 真的开出来了（`openDroppedFileInGroup` 里对同一条 reason 也是这么处理的）。
   * 这里若死守 `ok === true`，空标签就关不掉，表现正是「拖文件进来，空标签还留着」。
   *
   * 但只凭 reason 不够：请求被顶掉也可能是**没打开**。所以要再看一眼这一栏里
   * 是否真的出现了这个路径的标签，确认后才关空标签（关掉用户正在写的内容是
   * 不可恢复的破坏性操作，宁可多留一个空标签）。
   */
  const openTreatedAsSuccess = result?.ok === true || result?.reason === 'request-invalidated'
  if (!blankSessionId || !openTreatedAsSuccess) {
    return result
  }
  if (store && !hasOpenTabForPath(store.paneGroupList, path)) {
    return result
  }
  await requestDocumentCloseTab(blankSessionId).catch(() => {})
  return result
}

/**
 * 判断当前窗口的标签里是否已经有这个路径。
 *
 * 渲染层拿到的 `displayPath` 是正斜杠形式（`C:/dir/a.md`），拖入路径是反斜杠，
 * 且盘符大小写可能不同 —— 统一成正斜杠 + 小写再比。
 *
 * @param {Array<object> | null | undefined} paneList 栏快照列表
 * @param {string} path 文件路径
 * @returns {boolean} 是否已打开
 */
function hasOpenTabForPath(paneList, path) {
  const wanted = String(path || '').replace(/\\/gu, '/').toLowerCase()
  if (!wanted) {
    return false
  }
  for (const pane of Array.isArray(paneList) ? paneList : []) {
    for (const tab of Array.isArray(pane?.tabs) ? pane.tabs : []) {
      const displayPath = String(tab?.displayPath || '').replace(/\\/gu, '/').toLowerCase()
      if (displayPath && displayPath === wanted) {
        return true
      }
    }
  }
  return false
}

export async function openDroppedFileInGroup(path, groupId, store = null) {
  if (!path) {
    return { ok: false, reason: 'empty-path' }
  }

  /**
   * 打开文件，然后**把标签搬到目标栏**。
   *
   * 早期做法是「先 `activateGroup` 把焦点切到目标栏，再 open」—— 靠焦点间接指定落点。
   * 这条路实测不可靠：`activateGroup` 会 `invalidateActiveRequest()`，
   * 紧接着的 open 请求可能被判成 `request-invalidated`；而且焦点切换与 open
   * 之间没有同步点，主进程收到 open 时焦点未必已经生效。
   * 表现就是用户看到的「第二栏建出来了但是空的，文件跑到第一栏」。
   *
   * 现在改成两个都跑通的命令串起来：先 open（落在当前聚焦栏），
   * 再 `move-tab-to-group` 把刚打开的那个标签搬到目标栏 —— 落点由命令参数决定，
   * 不再依赖任何隐式焦点状态。
   */
  let result
  try {
    result = await requestDocumentOpenPathByInteraction(path, {
      entrySource: 'file-manager',
      trigger: 'user',
      openMode: 'new-tab',
    })
  } catch (error) {
    /**
     * 必须在这里归一成结果对象。
     *
     * 调用方是 `@drop` / window drop 上的 async 处理函数，链路里再没人 catch，
     * 异常会变成 unhandled rejection：用户看不到任何提示，标签也不会搬到目标栏。
     * `request-invalidated` 已在 service 内部归一成 resolve，这里接的是真异常。
     */
    return { ok: false, reason: 'open-request-failed', error }
  }

  // 只有「真的新开了一个标签」才搬；命中已有标签时搬动会破坏用户原有布局。
  //
  // ⚠️ `request-invalidated` 不能当失败：打开文件会切换当前会话，HomeView 里监听
  // sessionId 的 watch 会 `invalidateActiveRequest()`，于是 open 的返回值被判成失效 ——
  // 但**文件往往已经真的打开了**。当失败处理就会漏掉「搬到目标栏」这一步，
  // 表现是「拖到左栏，松手却跑到右栏」。
  const alreadyOpen = ALREADY_OPEN_REASON_SET.has(result?.reason)
  const openFailed = result?.ok !== true && result?.reason !== 'request-invalidated'
  if (!groupId || openFailed || alreadyOpen || !store) {
    return result
  }
  if (store.focusedGroupId === groupId) {
    return result
  }

  const sessionId = await resolveOpenedSessionId(path, store, result)
  if (!sessionId) {
    return result
  }
  await requestDocumentMoveTabToGroup(sessionId, groupId).catch(() => {})
  // 搬完激活它：拖进来的文件就是用户想看的那一个
  await requestDocumentActivateTab(sessionId).catch(() => {})
  return result
}

/**
 * 分栏前的宽度基准。
 *
 * 优先用 store 里已存的 `paneLayout.widths`（长度与栏数一致、且都是有效像素时）；
 * 不可用则按编辑区容器宽等分 —— 容器宽在分栏过程中不变，只有一个稳定读数，
 * 不涉及逐栏 box，不会踩到「Vue 还没 patch DOM」的时序问题。
 *
 * @param {object} store 渲染层 store
 * @param {number} paneCount 拆分前的栏数
 * @returns {Array<number> | null} 基准宽度；拿不到返回 null
 */
export function resolveBasePaneWidths(store, paneCount) {
  const layout = store?.paneLayout
  const storedWidths = Array.isArray(layout?.widths) ? layout.widths : []
  const count = Number.isInteger(paneCount) && paneCount > 0 ? paneCount : 1
  if (storedWidths.length === count
    && storedWidths.every(width => Number.isFinite(width) && width >= MIN_PANE_WIDTH)) {
    return storedWidths
  }

  const grid = document.querySelector('[data-testid="editor-pane-grid"]')
  const rect = (grid ?? document.querySelector('[data-testid="editor-pane-body"]'))
    ?.getBoundingClientRect?.()
  if (!rect || !(rect.width > 0)) {
    return null
  }
  const usable = rect.width - PANE_GUTTER_WIDTH * Math.max(0, count - 1)
  const each = Math.max(MIN_PANE_WIDTH, Math.round(usable / count))
  return Array.from({ length: count }, () => each)
}

/**
 * 分栏后写宽度：目标栏一分为二，其余栏宽度不变。
 *
 * 基准由调用方在**发命令之前**抓（`resolveBasePaneWidths`），这里只做纯计算 —— 不测 DOM。
 *
 * 之前是在新栏渲染完成后才去量 DOM：那时旧栏已经被 `normalizePaneLayout`
 * 按比例压成 1/(N+1)，除以二再写回总和不足 1，又被归一一次 ——
 * 3 栏变成 1:1:2、4 栏挤成一排，就是这条路径造成的。
 *
 * @param {object} store 渲染层 store
 * @param {Array<number> | null} baseWidths 拆分前的宽度（长度 = 拆分前栏数）
 * @param {number} targetIndex 目标栏在**原列表**里的下标（拆分对象）
 * @param {number} insertAt 新栏插入位置
 */
function applySplitPaneWidths(store, baseWidths, targetIndex, insertAt) {
  const nextWidths = halvePaneWidths(baseWidths, targetIndex, insertAt)
  if (!nextWidths) {
    return
  }
  // 全部写具体像素：留下 null 会触发「混合权重归一」，整排栏又变回均分。
  const payload = { count: nextWidths.length, widths: nextWidths }
  store?.setPaneLayout?.(payload)
  persistPaneLayout(payload).then(() => {})
}

/**
 * 把栏布局写回 config.json。
 *
 * ⚠️ 分栏必须自己落盘：`EditorPaneGrid` 的持久化只挂在「拖动栏间分隔条松手」
 * （`handlePointerUp`）上，拖文件分栏根本不经过那条路径。少了这一步，
 * 3/4 栏的宽度从来没被记住 —— 重启后 store 里还是上一次 2 栏的旧值，
 * 栅格按「部分有限 + 部分 null」归一，栏宽全丢。
 *
 * @param {{ count: number, widths: Array<number | null> }} layout 要写入的布局
 * @returns {Promise<void>} 写盘结束
 */
async function persistPaneLayout(layout) {
  try {
    const payload = {
      count: layout.count,
      widths: Array.isArray(layout.widths)
        ? layout.widths.map(width => (Number.isFinite(width) ? Math.round(width) : null))
        : [],
    }
    await sendConfigMutationRequest(createSetConfigPathRequest(['paneLayout'], payload))
  } catch {
    // 写盘失败只影响「下次启动的栏宽记忆」，不能打断当前编辑。
  }
}

/**
 * 从文件列表拖到编辑区分栏：在**目标栏的指定一侧**新建一栏并把文件放进去。
 *
 * @param {string} path 文件绝对路径
 * @param {object} store 渲染层 store
 * @param {{ targetGroupId?: (string|null), side?: ('left'|'right'|null) }} [options]
 *        目标栏与插入侧；都不传时沿用旧行为（建到最右边、全栏均分）
 * @returns {Promise<object>} 打开结果
 */
export async function openDroppedFileInSplitPane(path, store, options = {}) {
  const paneList = Array.isArray(store?.paneGroupList) ? store.paneGroupList : []
  const { targetGroupId = null, side = null } = options

  const targetIndex = targetGroupId
    ? paneList.findIndex(pane => pane?.groupId === targetGroupId)
    : paneList.length - 1
  const safeTargetIndex = targetIndex >= 0 ? targetIndex : Math.max(0, paneList.length - 1)
  const insertAt = side === 'left' ? safeTargetIndex : safeTargetIndex + 1

  /**
   * **一条命令完成分栏**：主进程收到 `createGroup: true` 后会
   * 「建一个空栏 → 把新会话直接挂进那一栏 → 设为该栏激活标签」，
   * 三步在同一个事务里，中间没有任何渲染层能插进来的间隙。
   *
   * 之前是渲染层串三个命令（open → create-group → move-tab-to-group），
   * 每一步都会改主进程状态、推快照、触发 watch，组合起来时序不可控 ——
   * 那正是「预览说分栏、松手后标签跑回左栏、右栏空着」反复出现的原因。
   */
  const beforeGroupIds = new Set(paneList.map(pane => pane?.groupId).filter(Boolean))

  /**
   * 宽度基准必须在**发命令之前**抓：那一刻 store 里还是拆分前的 N 栏布局。
   * 命令发出后主进程状态已变、渲染层再过一帧就被 patch 成新布局，
   * 那时再取基准已经被「混合 → 均分」洗过了。
   */
  const baseWidths = resolveBasePaneWidths(store, paneList.length)

  /**
   * 直接发 `open-path-in-current-window` 命令，**不经过 interaction service**。
   *
   * interaction service 有一整套「新请求作废旧请求」的机制（`invalidateActiveRequest`），
   * 而它挂在「当前会话变化」的 watch 上 —— 建栏/打开都会改当前会话，
   * 于是这条 open 请求在半路就被判成 `request-invalidated` 中断，
   * 主进程连建栏那一步都没执行到。
   *
   * 分栏是一次确定的原子动作，不需要那套「用户可能中途改主意」的作废语义，
   * 所以这里直接下命令：一次调用完成「建栏 + 打开 + 落在该栏并激活」。
   */
  const snapshot = store?.documentSessionSnapshot || null
  const result = await requestDocumentOpenPathInCurrentWindow(path, {
    entrySource: 'file-manager',
    trigger: 'user',
    switchPolicy: 'direct-switch',
    expectedSessionId: snapshot?.sessionId || null,
    expectedRevision: snapshot?.revision,
    targetGroupId,
    createGroup: true,
    insertAt,
  })

  // 等快照里出现新栏，再按「目标栏一分为二」写宽度（纯布局，不影响落点）
  const newGroupId = await waitForNewGroupId(store, beforeGroupIds)
  if (newGroupId) {
    applySplitPaneWidths(store, baseWidths, safeTargetIndex, insertAt)
  }
  return result
}

/**
 * 等快照里出现一个不在 `beforeGroupIds` 里的栏。
 *
 * @param {object} store 渲染层 store
 * @param {Set<string>} beforeGroupIds 操作前的栏 id 集合
 * @returns {Promise<string|null>} 新栏 id；超时返回 null
 */
async function waitForNewGroupId(store, beforeGroupIds, { retries = 30, intervalMs = 50 } = {}) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const paneList = Array.isArray(store?.paneGroupList) ? store.paneGroupList : []
    const found = paneList.find(pane => pane?.groupId && !beforeGroupIds.has(pane.groupId))
    if (found) {
      return found.groupId
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  return null
}

/**
 * 取「刚被打开的那个文件」对应的会话 id。
 *
 * 打开结果并不总是带 sessionId（新开标签时主进程只回 `{ok:true, reason:'opened'}`），
 * 所以再按路径从窗口快照的标签列表里找一次；标签列表是异步推送的，短暂轮询等待。
 *
 * @param {string} path 文件路径
 * @param {object} store 渲染层 store
 * @param {object} openResult 打开结果
 * @returns {Promise<string | null>}
 */
async function resolveOpenedSessionId(path, store, openResult, { retries = 40, intervalMs = 50 } = {}) {
  if (openResult?.sessionId) {
    return openResult.sessionId
  }

  const normalize = value => String(value || '').replace(/\\/g, '/').toLowerCase()
  const targetPath = normalize(path)
  const targetName = targetPath.split('/').pop()
  /**
   * 在窗口标签快照里找出「刚打开的那个标签」。
   *
   * 匹配分两级，且每一级都要求**结果唯一**：
   *
   * 1. 完整路径命中 —— 最可靠，命中就返回；
   * 2. 后缀/纯文件名兜底 —— 快照里的 `displayPath` 可能是相对路径或纯文件名
   *    （直接 `===` 永远不成立，会导致拿不到 sessionId、新栏是空的），
   *    所以保留兜底，但**出现多个同名候选时返回 null**。
   *
   * 原来用 `find(matchesTarget)` 取第一个命中：同窗口打开 `A/notes.md`
   * 与 `B/notes.md` 时，拖 B 会把 A 那个标签搬进目标栏 —— 宁可不搬，
   * 也不能搬错（搬错了用户看到的是一篇完全无关的文档换了位置）。
   */
  const findInSnapshot = () => {
    const tabList = Array.isArray(store?.documentSessionSnapshot?.tabs)
      ? store.documentSessionSnapshot.tabs
      : []

    const exactList = tabList.filter(tab => normalize(tab?.displayPath) === targetPath)
    if (exactList.length === 1) {
      return exactList[0].sessionId || null
    }
    if (exactList.length > 1) {
      return null
    }

    const looseList = tabList.filter((tab) => {
      const displayPath = normalize(tab?.displayPath)
      if (!displayPath) {
        return false
      }
      return displayPath.endsWith(`/${targetName}`) || displayPath === targetName
    })
    return looseList.length === 1 ? (looseList[0].sessionId || null) : null
  }

  for (let attempt = 0; attempt < retries; attempt += 1) {
    const sessionId = findInSnapshot()
    if (sessionId) {
      return sessionId
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }

  /**
   * 兜底：快照里一直没出现这个路径时，用「当前活动会话」。
   *
   * 只在确认它对应的就是目标文件时才用 —— 否则会把**上一个**文件搬到新栏，
   * 表现成「新栏是空的，原栏多了一个标签」。
   */
  const snapshot = store?.documentSessionSnapshot
  const activeSessionId = snapshot?.sessionId ?? null
  if (activeSessionId) {
    const activeTab = (snapshot?.tabs || []).find(tab => tab?.sessionId === activeSessionId)
    // 这里必须自己比对路径：`matchesTarget` 是上一版重写时删掉的局部 helper，
    // 调用它会抛 ReferenceError，而调用方是 async 的 drop 处理器，
    // 异常被吞掉后表现为「拖入文件什么都没发生」。
    if (activeTab && normalize(activeTab?.displayPath) === targetPath) {
      return activeSessionId
    }
  }

  return null
}
