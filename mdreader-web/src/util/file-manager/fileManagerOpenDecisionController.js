import { Button, message, Modal } from 'ant-design-vue'
import { h } from 'vue'
import { requestCurrentWindowOpenPreparation } from '@/util/document-session/currentWindowOpenPreparationService.js'
import {
  requestDocumentOpenPath,
  requestDocumentOpenPathInCurrentWindow,
  requestDocumentResolveOpenTarget,
  requestPrepareOpenPathInCurrentWindow,
} from '@/util/document-session/rendererDocumentCommandUtil.js'

function getUncShareRoot(path) {
  return path.match(/^(\/\/[^/]+\/[^/]+)\/*$/u)?.[1] || null
}

function normalizePath(path) {
  if (typeof path !== 'string') {
    return null
  }

  const normalizedPath = path.trim().replace(/\\/g, '/')
  if (!normalizedPath) {
    return null
  }
  if (normalizedPath === '/') {
    return '/'
  }
  if (/^[A-Za-z]:\/?$/u.test(normalizedPath)) {
    return `${normalizedPath.slice(0, 2)}/`
  }

  const uncShareRoot = getUncShareRoot(normalizedPath)
  if (uncShareRoot) {
    return uncShareRoot
  }

  const trimmedPath = normalizedPath.replace(/\/+$/u, '')
  return trimmedPath || null
}

/**
 * 从文档会话快照里提取“当前已打开 Markdown 路径”。
 *
 * recent-missing 会话没有真实打开的磁盘文件，
 * 这里统一返回 null，避免把缺失项误判成“当前文件重复打开”。
 */
export function resolveDocumentOpenCurrentPath(snapshot) {
  if (snapshot?.isRecentMissing === true) {
    return null
  }

  return normalizePath(snapshot?.resourceContext?.documentPath || snapshot?.displayPath || null)
}

function appendStageList(result, stageList) {
  if (result === false) {
    return false
  }

  if (result && typeof result === 'object') {
    return {
      ...result,
      stageList,
    }
  }

  return {
    ok: Boolean(result),
    reason: result ? 'opened' : 'dispatch-failed',
    stageList,
  }
}

function resolveResultDecision(result) {
  if (!result || typeof result !== 'object') {
    return null
  }

  return typeof result.decision === 'string'
    ? result.decision
    : typeof result.reason === 'string'
      ? result.reason
      : null
}

/**
 * 打开结果 → 提示文案。
 *
 * 提示只在“用户发起的打开没有按预期新开”时出现，用一句话说明原因：
 * 命中其它窗口 / 就是当前文档。
 * 命中本窗口的其它标签不再提示：标签栏高亮本身已经是反馈。
 * 真正新开成功（opened / ready-to-switch）不需要提示，结果本身就是反馈。
 */
const OPEN_RESULT_MESSAGE_KEY_MAP = {
  'focused-existing-window': 'message.fileAlreadyOpenedInOtherWindow',
  'noop-current-file': 'message.fileAlreadyEditingCurrent',
}

function resolveOpenInteractionMeta(options = {}) {
  return {
    entrySource: typeof options.entrySource === 'string' && options.entrySource
      ? options.entrySource
      : undefined,
    trigger: typeof options.trigger === 'string' && options.trigger
      ? options.trigger
      : 'user',
  }
}

function createThreeWayChoiceModal({
  title,
  content,
  primaryText,
  secondaryText,
  cancelText,
  createModal = config => Modal.confirm(config),
  registerDestroyer = null,
}) {
  return new Promise((resolve) => {
    let resolved = false
    let modalInstance = null
    const clearRegisteredDestroyer = () => {
      if (typeof registerDestroyer === 'function') {
        registerDestroyer(null)
      }
    }
    const settle = (value) => {
      if (resolved) {
        return
      }

      resolved = true
      clearRegisteredDestroyer()
      resolve(value)
    }
    const closeWith = (value) => {
      modalInstance?.destroy?.()
      settle(value)
    }

    modalInstance = createModal({
      title,
      content,
      centered: true,
      width: 600,
      footer: h('div', {
        style: {
          width: '100%',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '8px',
          paddingTop: '8px',
        },
      }, [
        h(Button, {
          onClick: () => {
            closeWith('cancel')
          },
        }, () => cancelText),
        h(Button, {
          onClick: () => {
            closeWith('secondary')
          },
        }, () => secondaryText),
        h(Button, {
          type: 'primary',
          onClick: () => {
            closeWith('primary')
          },
        }, () => primaryText),
      ]),
      onCancel: () => {
        settle('cancel')
      },
    })

    if (typeof registerDestroyer === 'function') {
      registerDestroyer(() => {
        closeWith('cancel')
      })
    }
  })
}

/**
 * 未显式指定打开方式时的默认行为：直接在当前窗口新开标签。
 *
 * 依据（产品决策）：用户希望"打开文件就打开"，不再为每次打开弹「当前窗口 / 新窗口」
 * 的三选一确认框。需要新窗口时仍可从文件树右键菜单显式选择 `openMode: 'new-window'`。
 */
export const DEFAULT_OPEN_MODE = 'current-window'
// 显式要求「另开一个标签」的打开方式：文件树右键菜单与 Ctrl/中键点击用这个。
export const NEW_TAB_OPEN_MODE = 'new-tab'

export function createDefaultPromptOpenModeChoice(t, {
  createModal = config => Modal.confirm(config),
} = {}) {
  return async ({ setActiveDialogDestroyer } = {}) => {
    const choice = await createThreeWayChoiceModal({
      title: t('message.fileManagerOpenModeTitle'),
      content: t('message.fileManagerOpenModeTip'),
      primaryText: t('message.fileManagerOpenInCurrentWindow'),
      secondaryText: t('message.fileManagerOpenInNewWindow'),
      cancelText: t('cancelText'),
      createModal,
      registerDestroyer: setActiveDialogDestroyer,
    })

    if (choice === 'primary') {
      return 'current-window'
    }

    if (choice === 'secondary') {
      return 'new-window'
    }

    return 'cancel'
  }
}

/**
 * 统一处理文件管理栏里的“打开 Markdown 文件”决策。
 *
 * 这里把 renderer 侧两层选择都收口：
 * 1. 在当前窗口打开还是新窗口打开
 * 2. 当前窗口切文档前，脏内容是否需要先保存
 */
export function createFileManagerOpenDecisionController({
  t = value => value,
  requestDocumentResolveOpenTarget: requestResolveOpenTarget = requestDocumentResolveOpenTarget,
  requestPrepareOpenPathInCurrentWindow: requestPrepareCurrentWindowOpen = requestPrepareOpenPathInCurrentWindow,
  requestDocumentOpenPath: requestOpenPath = requestDocumentOpenPath,
  requestDocumentOpenPathInCurrentWindow: requestOpenPathInCurrentWindow = requestDocumentOpenPathInCurrentWindow,
  requestCurrentWindowOpenPreparation: requestPreparation = requestCurrentWindowOpenPreparation,
  showInfoMessage = messageKey => message.info({
    content: t(messageKey),
    // 固定 key：连点多次时**替换**上一条，而不是在屏幕上堆一摞一模一样的提示。
    // 同一类「文件已打开」的反馈，同时出现两条以上纯属噪音。
    key: 'wj-file-already-open-notice',
  }),
  showErrorMessage = messageKey => message.error(t(messageKey)),
  notifySourceSessionChanged = () => message.warning(t('message.fileManagerSourceSessionChanged')),
} = {}) {
  /**
   * 按打开结果统一发提示：
   * “哪种结果配哪句话”只在这张表里决定，不再由每个阶段各自 if 一遍。
   */
  function notifyOpenResult(result) {
    const messageKey = OPEN_RESULT_MESSAGE_KEY_MAP[resolveResultDecision(result)]
    if (messageKey) {
      showInfoMessage(messageKey)
    }
  }

  async function openDocument(targetPath, options = {}) {
    const stageList = []
    const interactionMeta = resolveOpenInteractionMeta(options)
    const isInteractionActive = typeof options.isInteractionActive === 'function'
      ? options.isInteractionActive
      : () => true
    const resolveInvalidatedResult = () => ({
      ok: false,
      reason: 'request-invalidated',
      path: targetPath,
      stageList: [...stageList],
    })
    const stopIfInactive = () => {
      return isInteractionActive() === true
        ? null
        : resolveInvalidatedResult()
    }
    const initialInvalidatedResult = stopIfInactive()
    if (initialInvalidatedResult) {
      return initialInvalidatedResult
    }

    stageList.push('target-preflight')
    const targetPreflightResult = await requestResolveOpenTarget(targetPath, {
      ...interactionMeta,
    })
    const targetPreflightInvalidatedResult = stopIfInactive()
    if (targetPreflightInvalidatedResult) {
      return targetPreflightInvalidatedResult
    }
    notifyOpenResult(targetPreflightResult)
    if (targetPreflightResult?.decision !== 'needs-open-mode-choice') {
      return appendStageList(targetPreflightResult, stageList)
    }

    stageList.push('open-choice')
    // 不再弹「当前窗口 / 新窗口」三选一：未显式指定时一律在当前窗口新开标签。
    // 需要新窗口仍可从文件树右键菜单传入 `openMode: 'new-window'`。
    const selectedOpenMode = options.openMode || DEFAULT_OPEN_MODE
    const openChoiceInvalidatedResult = stopIfInactive()
    if (openChoiceInvalidatedResult) {
      return openChoiceInvalidatedResult
    }

    if (!selectedOpenMode || selectedOpenMode === 'cancel') {
      return {
        ok: false,
        reason: 'open-cancelled',
        stageList,
      }
    }

    if (selectedOpenMode === 'new-window') {
      stageList.push('dispatch')
      const beforeNewWindowDispatchInvalidatedResult = stopIfInactive()
      if (beforeNewWindowDispatchInvalidatedResult) {
        return beforeNewWindowDispatchInvalidatedResult
      }
      const dispatchResult = await requestOpenPath(targetPath, {
        ...interactionMeta,
      })
      const newWindowDispatchInvalidatedResult = stopIfInactive()
      if (newWindowDispatchInvalidatedResult) {
        return newWindowDispatchInvalidatedResult
      }
      notifyOpenResult(dispatchResult)
      return appendStageList(dispatchResult, stageList)
    }

    stageList.push('current-window-preflight')
    const preparationResult = await requestPreparation({
      path: targetPath,
      ...interactionMeta,
    })
    const preparationInvalidatedResult = stopIfInactive()
    if (preparationInvalidatedResult) {
      return preparationInvalidatedResult
    }
    if (preparationResult?.ok !== true || !preparationResult?.snapshot) {
      return appendStageList(preparationResult, stageList)
    }

    const sourceSessionId = preparationResult.snapshot.sessionId
    const sourceRevision = preparationResult.snapshot.revision
    const currentWindowPreflightResult = await requestPrepareCurrentWindowOpen(targetPath, {
      ...interactionMeta,
      sourceSessionId,
      sourceRevision,
    })
    const currentWindowPreflightInvalidatedResult = stopIfInactive()
    if (currentWindowPreflightInvalidatedResult) {
      return currentWindowPreflightInvalidatedResult
    }
    notifyOpenResult(currentWindowPreflightResult)
    if (currentWindowPreflightResult?.decision !== 'ready-to-switch') {
      return appendStageList(currentWindowPreflightResult, stageList)
    }

    // 默认「在当前标签里打开」：新文档顶替当前标签，旧标签在切换成功后由主进程关闭；
    // 需要保留当前标签时，右键菜单或 Ctrl/中键点击会显式传 `openMode: 'new-tab'`。
    const switchPolicy = selectedOpenMode === NEW_TAB_OPEN_MODE ? 'direct-switch' : 'replace-active'

    stageList.push('dispatch')
    const beforeCurrentWindowDispatchInvalidatedResult = stopIfInactive()
    if (beforeCurrentWindowDispatchInvalidatedResult) {
      return beforeCurrentWindowDispatchInvalidatedResult
    }
    // 分栏：透传给主进程，一次命令完成「建栏 + 打开 + 落在该栏并激活」。
    // 只在真的需要分栏时才带这些字段，避免污染普通打开的 payload。
    const splitOpenOptions = {}
    if (typeof options.targetGroupId === 'string' && options.targetGroupId) {
      splitOpenOptions.targetGroupId = options.targetGroupId
    }
    if (options.createGroup === true) {
      splitOpenOptions.createGroup = true
    }
    if (Number.isInteger(options.insertAt) && options.insertAt >= 0) {
      splitOpenOptions.insertAt = options.insertAt
    }

    const dispatchResult = await requestOpenPathInCurrentWindow(targetPath, {
      ...interactionMeta,
      switchPolicy,
      expectedSessionId: sourceSessionId,
      expectedRevision: sourceRevision,
      ...splitOpenOptions,
    })
    const currentWindowDispatchInvalidatedResult = stopIfInactive()
    if (currentWindowDispatchInvalidatedResult) {
      return currentWindowDispatchInvalidatedResult
    }
    notifyOpenResult(dispatchResult)
    if (dispatchResult?.reason === 'open-current-window-switch-failed') {
      showErrorMessage('message.fileManagerOpenCurrentWindowFailed')
    }
    if (dispatchResult?.reason === 'source-session-changed') {
      notifySourceSessionChanged()
    }
    return appendStageList(dispatchResult, stageList)
  }

  return {
    openDocument,
  }
}

export default {
  createDefaultPromptOpenModeChoice,
  createFileManagerOpenDecisionController,
  resolveDocumentOpenCurrentPath,
}
