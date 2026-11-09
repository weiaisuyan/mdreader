import Split from 'split-grid'

import { MIN_PANE_WIDTH } from '../../util/document-session/paneLayoutUtil.js'

// 默认宽度（首次打开时的宽度）。
// 必须 > 最小宽度，否则「跟随窗口缩放」没有可压缩区间（默认 = 最小 → 永远不缩）。
export const FILE_MANAGER_PANEL_DEFAULT_WIDTH = 280
// 最小宽度统一取编辑区分栏的 MIN_PANE_WIDTH（用户要求四者一致）。
export const FILE_MANAGER_PANEL_MIN_WIDTH = MIN_PANE_WIDTH
export const FILE_MANAGER_PANEL_MAX_WIDTH = 420

/**
 * 将文件管理栏宽度限制在允许范围内，避免拖拽结果超出壳层设计边界。
 *
 * @param {number} width
 * @returns {number} 返回经过最小值和最大值钳制后的宽度。
 */
export function clampFileManagerPanelWidth(width) {
  const normalizedWidth = Number(width)
  const nextWidth = Number.isFinite(normalizedWidth) ? normalizedWidth : FILE_MANAGER_PANEL_DEFAULT_WIDTH

  return Math.min(FILE_MANAGER_PANEL_MAX_WIDTH, Math.max(FILE_MANAGER_PANEL_MIN_WIDTH, nextWidth))
}

/**
 * 生成文件管理栏展开态的 grid 列定义。
 *
 * @param {number} width
 * @returns {string} 返回可直接写入 grid-template-columns 的列定义。
 */
export function resolveHomeViewFilePanelGridTemplateColumns(width) {
  return `${clampFileManagerPanelWidth(width)}px 1px 1fr`
}

/**
 * 读取 grid-template-columns 里的第一列宽度（左侧栏在首位）。
 *
 * @param {string} computedGridTemplateColumns
 * @returns {number} 解析失败时返回 NaN。
 */
export function readLeadingTrackWidth(computedGridTemplateColumns) {
  return Number.parseFloat(String(computedGridTemplateColumns ?? '').trim().split(/\s+/u)[0] ?? '')
}

/**
 * 为 HomeView 外层壳层管理 split-grid 生命周期。
 * 默认按「左侧文件栏」工作：分隔条在第 1 轨、宽度取模板首列；
 * 右侧大纲栏通过参数覆盖轨道下标与宽度取值方式复用同一套逻辑。
 *
 * @param {{
 *   hostRef: { value?: HTMLElement | null },
 *   gutterRef: { value?: HTMLElement | null },
 *   panelWidthRef: { value: number },
 *   nextTick: () => Promise<void>,
 *   onPanelWidthCommit?: (width: number) => void,
 *   createSplitInstance?: (options: object) => { destroy?: (preserveStyles?: boolean) => void } | null,
 *   readComputedStyle?: (element: HTMLElement) => CSSStyleDeclaration | { gridTemplateColumns?: string },
 *   resolveGridTemplateColumns?: (width: number) => string,
 *   gutterTrack?: number,
 *   minSize?: number,
 *   clampPanelWidth?: (width: number) => number,
 *   readPanelWidth?: (computedGridTemplateColumns: string) => number,
 * }} options
 */
export function createHomeViewFilePanelLayoutController({
  hostRef,
  gutterRef,
  panelWidthRef,
  nextTick,
  onPanelWidthCommit,
  createSplitInstance = options => Split(options),
  readComputedStyle = element => window.getComputedStyle(element),
  // 允许外层注入完整列定义：右侧大纲栏出现时列数会变化，不能再写死「侧栏 1fr」
  resolveGridTemplateColumns = resolveHomeViewFilePanelGridTemplateColumns,
  gutterTrack = 1,
  minSize = FILE_MANAGER_PANEL_MIN_WIDTH,
  clampPanelWidth = clampFileManagerPanelWidth,
  readPanelWidth = readLeadingTrackWidth,
  // 轨道下标可能随另一侧栏的显隐变化，允许每次建实例时重新求值
  resolveGutterTrack = () => gutterTrack,
  // 这条 gutter 拖的是哪一侧的栏：'start' = 左侧栏（改首列），'end' = 右侧栏（改末列）。
  // 不能靠 children 下标猜：文件栏的 gutter 下标 1 在只有三列时会被误判成「末尾」，
  // 结果拖文件栏却改了编辑区的宽度（实测过）。
  panelSide = 'start',
}) {
  let splitInstance = null

  function applyPanelWidth() {
    if (!hostRef.value) {
      return
    }

    hostRef.value.style.gridTemplateColumns = resolveGridTemplateColumns(panelWidthRef.value)
  }

  function readCurrentPanelWidth() {
    if (!hostRef.value) {
      return clampPanelWidth(panelWidthRef.value)
    }

    const computedGridTemplateColumns = readComputedStyle(hostRef.value)?.gridTemplateColumns ?? ''
    const currentPanelWidth = readPanelWidth(computedGridTemplateColumns)

    if (Number.isFinite(currentPanelWidth) === false) {
      return clampPanelWidth(panelWidthRef.value)
    }

    return clampPanelWidth(currentPanelWidth)
  }

  // 本次拖拽的收尾函数：下一次按下先调用它，防止旧监听器叠加
  let activeDragCleanup = null

  function destroySplitLayout() {
    if (typeof activeDragCleanup === 'function') {
      activeDragCleanup()
      activeDragCleanup = null
    }
    splitInstance?.destroy?.(true)
    splitInstance = null
  }

  /**
   * 用原生指针事件实现分隔条拖拽。
   *
   * ## 为什么弃用 split-grid
   *
   * split-grid 内部用 `raw.split(' ')` 解析 grid-template-columns，
   * 而我们的模板是 `minmax(160px, 280fr) 1px minmax(160px, 1400fr)` ——
   * `minmax(...)` 参数里带空格，被切成 `minmax(160px,` 和 `280fr)` 两段，
   * 解析直接失效，表现为**完全拖不动**（实测拖 +100px，侧栏一直在 317px）。
   *
   * 自己实现反而更简单可靠：读当前列模板的像素值 → 按指针位移算出新宽度 →
   * 拖动期间写像素模板（1:1 跟手）→ 松手转回 fr 权重。
   */
  function createSplit() {
    if (!hostRef.value || !gutterRef.value) {
      return null
    }

    applyPanelWidth()

    const gutterElement = gutterRef.value
    let dragPointerId = null
    let startPointerX = 0
    let startPanelWidth = 0
    let isOutlineSide = false
    // 按下时抓一次列模板并缓存：拖动期绝不能再调用 getComputedStyle。
    // getComputedStyle(...).gridTemplateColumns 会**强制同步重排**，真实鼠标 ~120Hz，
    // 等于每秒 120 次全量 reflow —— 表现就是「宽度一格一格跳、不跟手」。
    let dragColumns = null
    let dragTrackIndex = 0
    // 被拖栏的「对家」——编辑区所在轨道。拖动时必须同步改它，
    // 否则三列之和 > 容器宽，多出来的部分被 overflow:hidden 裁掉：
    // 面板宽度数值在变、但分隔条不动，用户看到的就是「拖了不跟手、一顿一顿」。
    let dragEditorIndex = -1
    let startEditorWidth = 0


    function cleanupDrag() {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      window.removeEventListener('blur', handlePointerUp)
      // 释放指针捕获：不释放的话下一次按到别的元素会静默失效
      if (dragPointerId !== null && gutterElement?.releasePointerCapture) {
        try {
          gutterElement.releasePointerCapture(dragPointerId)
        } catch (_) {
          // 指针已失效时 release 会抛，忽略
        }
      }
      dragColumns = null
      gutterElement?.classList?.remove('wj-sash--dragging')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      dragPointerId = null
      if (activeDragCleanup === cleanupDrag) {
        activeDragCleanup = null
      }
    }

    function handlePointerMove(moveEvent) {
      if (dragPointerId === null || moveEvent.pointerId !== dragPointerId) {
        return
      }
      const hostElement = hostRef.value
      if (!dragColumns || !hostElement) {
        return
      }
      // 大纲栏在右侧，指针往左拖才是变宽，所以方向要反过来
      const delta = isOutlineSide
        ? startPointerX - moveEvent.clientX
        : moveEvent.clientX - startPointerX
      const nextWidth = clampPanelWidth(startPanelWidth + delta)

      // 拖动期间直接写**像素**模板，1:1 跟手。
      //
      // 两条铁律（都是实测踩出来的）：
      //
      // ① **必须用按下时缓存的列数组**，绝不能在这里调 getComputedStyle。
      //    getComputedStyle(...).gridTemplateColumns 会强制同步重排，
      //    真实鼠标 ~120Hz 就是每秒 120 次全量 reflow —— 宽度会一格一格跳。
      //
      // ② **不要用 requestAnimationFrame 限帧**。rAF 在窗口失焦/后台/主线程繁忙时
      //    会被节流甚至不执行，而 `dragRafId` 一旦置上就一直挡住后续 move，
      //    表现是「拖了半天不动，然后一下跳过去」——
      //    实测前 14 帧宽度恒为 266，第 15 帧一次跳 +120 补上累计位移。
      //
      //    直接赋值 style 只是改一个字符串，浏览器会在下一帧统一 layout，
      //    天然就是每帧最多一次重排，不需要自己限帧。
      const nextColumns = dragColumns.slice()
      nextColumns[dragTrackIndex] = `${Math.round(nextWidth)}px`

      // 同步把编辑区那一列改成「按下时宽度 − 本次位移」，
      // 保证三列之和始终等于容器宽 —— 否则溢出部分被裁掉，分隔条不会跟手。
      //
      // 用 appliedDelta（钳制后的真实变化量）而不是原始 delta：
      // 被拖栏撞到上下限后不再变宽，此时编辑区也不能继续缩，否则两者脱节。
      //
      // 编辑区不能低于 MIN_PANE_WIDTH：触底后只让被拖栏继续走，
      // 宁可总和略小于容器（CSS 会把富余空间留给编辑区），也不要出现负宽或塌陷。
      if (dragEditorIndex >= 0 && dragEditorIndex !== dragTrackIndex && startEditorWidth > 0) {
        const appliedDelta = nextWidth - startPanelWidth
        const nextEditorWidth = Math.max(MIN_PANE_WIDTH, Math.round(startEditorWidth - appliedDelta))
        nextColumns[dragEditorIndex] = `${nextEditorWidth}px`
      }

      hostElement.style.gridTemplateColumns = nextColumns.join(' ')
    }

    function handlePointerUp(upEvent) {
      if (dragPointerId === null || upEvent.pointerId !== dragPointerId) {
        return
      }
      cleanupDrag()

      // 松手：**保留像素模板，不立刻转 fr 权重**。
      //
      // 为什么不能立刻转：fr 是权重不是像素，把「目标 420px」直接写成 420fr
      // 会渲染成 442px，再钳回 420 又变成 420fr…… 振荡几轮后停在 401
      // （实测：拖到 420、松手掉回 401）。
      //
      // 正确做法：松手时把当前像素模板定格住（用户拖到哪就是哪），
      // 只在**窗口尺寸变化**时才转成 fr 权重重新布局。
      // 这样既保证拖动结果精确，又能在缩放时按比例一起变。
      //
      // 但定格之前要先把「编辑区列」恢复成 fr —— 拖动期写的是像素，
      // 若原样保留，窗口缩放时编辑区就不会跟着变了（两侧栏在缩、中间不动）。
      // 这里只在编辑区确实被同步改过时才动它，其余轨道原样保留。
      const hostElement = hostRef.value
      if (hostElement && dragEditorIndex >= 0 && dragColumns) {
        const frozen = hostElement.style.gridTemplateColumns.trim().split(/\s+/).filter(Boolean)
        if (frozen.length === dragColumns.length && dragEditorIndex < frozen.length) {
          frozen[dragEditorIndex] = '1fr'
          hostElement.style.gridTemplateColumns = frozen.join(' ')
        }
      }

      const draggedWidth = clampPanelWidth(readCurrentPanelWidth())
      panelWidthRef.value = draggedWidth
      onPanelWidthCommit?.(draggedWidth)
    }

    function handlePointerDown(downEvent) {
      if (downEvent.button !== 0) {
        return
      }
      if (typeof activeDragCleanup === 'function') {
        activeDragCleanup()
      }
      downEvent.preventDefault()

      const hostElement = hostRef.value
      if (!hostElement) {
        return
      }
      isOutlineSide = panelSide === 'end'
      startPanelWidth = readCurrentPanelWidth()
      startPointerX = downEvent.clientX
      dragPointerId = downEvent.pointerId
      // 只在按下时读一次列模板（唯一一次 getComputedStyle，可接受的成本）
      const initialColumns = readComputedStyle(hostElement)?.gridTemplateColumns ?? ''
      dragColumns = initialColumns.trim().split(/\s+/).filter(Boolean)
      dragTrackIndex = isOutlineSide ? Math.max(0, dragColumns.length - 1) : 0
      if (dragColumns.length === 0) {
        dragColumns = null
      }

      // 找出编辑区所在轨道，并记下它按下时的像素宽度。
      // 列布局（侧栏都可见时）：[侧栏, 1px, 编辑区, 1px, 大纲栏] → 编辑区在 2
      // 只有大纲栏时：        [编辑区, 1px, 大纲栏]        → 编辑区在 0
      // 只有侧栏时：          [侧栏, 1px, 编辑区]          → 编辑区在 2
      // 两个侧栏都关：        [编辑区]                     → 无对家
      //
      // ⚠️ 必须确认每段都是纯像素值。若某段是 `minmax(160px,` 这种被空格切碎的碎片，
      // 说明拿到的是未解析的模板而不是 computed 值，此时索引全错 —— 直接放弃同步编辑区，
      // 退回「只改被拖列」的旧行为，至少不会算出负宽把布局搞坏。
      if (dragColumns && dragColumns.length >= 3 && dragColumns.every(token => /^\d+(\.\d+)?px$/u.test(token))) {
        dragEditorIndex = isOutlineSide ? Math.max(0, dragColumns.length - 3) : Math.min(dragColumns.length - 1, 2)
        startEditorWidth = Number.parseFloat(dragColumns[dragEditorIndex]) || 0
      } else {
        dragEditorIndex = -1
        startEditorWidth = 0
      }

      // **指针捕获**：没有它时，指针一旦移进编辑区（Monaco/CodeMirror 这类
      // 重交互组件会吞事件），pointermove 就断了，宽度停在原地不动 ——
      // 用户看到的就是「拖一下跳一档、再拖一下跳一档」。
      // 捕获后所有事件都锁定在分隔条上，跨任何元素都不丢。
      if (gutterElement?.setPointerCapture) {
        try {
          gutterElement.setPointerCapture(downEvent.pointerId)
        } catch (_) {
          // 某些指针类型不支持捕获，忽略即可
        }
      }
      gutterElement?.classList?.add('wj-sash--dragging')
      // 拖动期间全局显示 col-resize，鼠标跑到别的元素上也不闪回箭头
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      activeDragCleanup = cleanupDrag
      window.addEventListener('pointermove', handlePointerMove)
      window.addEventListener('pointerup', handlePointerUp)
      window.addEventListener('pointercancel', handlePointerUp)
      window.addEventListener('blur', handlePointerUp)
    }

    gutterElement.addEventListener('pointerdown', handlePointerDown)

    // 返回结构与原来兼容（rebuildSplitLayout 的调用方只看真值）
    splitInstance = {
      destroy: (preserveStyles) => {
        gutterElement.removeEventListener('pointerdown', handlePointerDown)
        cleanupDrag()
        if (preserveStyles !== true) {
          activeDragCleanup = null
        }
      },
    }

    return splitInstance
  }

  async function rebuildSplitLayout(visible) {
    destroySplitLayout()

    if (!visible) {
      return null
    }

    await nextTick()
    return createSplit()
  }

  return {
    applyPanelWidth,
    readCurrentPanelWidth,
    destroySplitLayout,
    rebuildSplitLayout,
  }
}
