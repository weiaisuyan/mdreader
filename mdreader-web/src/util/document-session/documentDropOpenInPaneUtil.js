import channelUtil from '../channel/channelUtil.js'
import {
  isPaneReusableBlank,
  openDroppedFileReplacingBlank,
} from '../file-manager/fileDragDropUtil.js'
import { pickFirstMarkdownFile } from './documentDropOpenUtil.js'
import { requestDocumentOpenPathByInteraction } from './documentOpenInteractionService.js'

/**
 * 在指定栏（默认聚焦栏）里解析拖入的 Markdown 文档。
 *
 * ## 与 requestOpenDroppedMarkdownDocument 的区别
 *
 * 目标栏如果只剩一个「空白标签」（新建后没有路径、也没改动过），就直接顶替它：
 * 用户打开软件看到的是一个空白标签，拖文件进来时想要的是「这个文件就在这儿打开」，
 * 而不是「留着空白标签、再多开一个」。
 *
 * 但如果用户已经点进编辑、动过内容（`dirty === true`），这个标签就**不能**被顶掉
 * —— 那是用户正在写的东西，此时按普通「新标签」打开。
 *
 * 之所以单独放一个文件：本模块依赖 `fileDragDropUtil.js`（内含 `@/` 别名与 vue 运行时导入），
 * 而 `documentDropOpenUtil.js` 还要被 node:test 直接 import，不能把别名依赖带进去。
 */

/**
 * 解析拖入的 Markdown 文件并落到目标栏。
 *
 * @param {FileList | null | undefined} files 拖拽带来的文件列表
 * @param {{ store?: object | null, groupId?: string | null }} [options] 目标栏信息
 * @returns {Promise<{ handled: boolean, ok?: boolean, reason?: string }>} 处理结果
 */
export async function openDroppedMarkdownDocumentInPane(files, options = {}) {
  const { store = null, groupId = null } = options
  const markdownFile = pickFirstMarkdownFile(files)
  if (!markdownFile) {
    return { handled: false, ok: false, reason: 'no-markdown-file' }
  }

  const filePath = channelUtil.getWebFilePath(markdownFile)
  if (!filePath) {
    return { handled: true, ok: false, reason: 'empty-path' }
  }

  const paneList = Array.isArray(store?.paneGroupList) ? store.paneGroupList : []
  const wantedGroupId = groupId ?? store?.focusedGroupId ?? null
  const targetPane = paneList.find(pane => pane?.groupId === wantedGroupId) || paneList[0] || null

  // 空白标签：先打开文件，成功后再关掉空标签（打开失败时空白标签必须还在）。
  if (isPaneReusableBlank(targetPane)) {
    const result = await openDroppedFileReplacingBlank(filePath, targetPane, store)
    return { handled: true, ...result }
  }

  try {
    const result = await requestDocumentOpenPathByInteraction(filePath, {
      entrySource: 'drag-drop',
      trigger: 'user',
      openMode: 'new-tab',
    })
    return { handled: true, ...result }
  } catch (error) {
    return { handled: true, ok: false, reason: 'open-failed', error }
  }
}

export default {
  openDroppedMarkdownDocumentInPane,
}
