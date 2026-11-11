import { createSetConfigPathRequest, sendConfigMutationRequest } from '@/util/config/configMutationCommandUtil.js'
import { getConfigUpdateFailureMessageKey } from '@/util/config/configUpdateResultUtil.js'

/**
 * 侧栏可见性（左侧文件栏 / 右侧大纲栏）的落盘控制器。
 *
 * 与「侧栏宽度」不同，可见性只在用户点一次开关时变一次，不需要防抖；
 * 但必须去重：值没变就不发请求，避免重复写 config.json。
 *
 * 失败策略：只提示、不回滚。开关是即时生效的交互，
 * 写盘失败最多是「下次启动记不住」，没必要把用户刚做的操作弹回去。
 */
export function createSidebarVisibilityPersistenceController({
  sendConfigMutationRequest: sendMutationRequest = sendConfigMutationRequest,
  getConfigUpdateFailureMessageKey: resolveFailureMessageKey = getConfigUpdateFailureMessageKey,
  getPersistedValue = () => undefined,
  applyPersistedValue = () => {},
  showWarningMessage = () => {},
  configPath = [],
  normalizeValue = value => value,
} = {}) {
  /**
   * 把一次可见性变化写入配置。
   *
   * @param {unknown} rawValue 待持久化的原始值（布尔或枚举字符串）
   * @returns {Promise<object>} 与配置 mutation 一致的结果对象；未变化时返回 skipped 结果
   */
  async function persistSidebarVisibility(rawValue) {
    const normalizedValue = normalizeValue(rawValue)

    if (getPersistedValue() === normalizedValue) {
      // 值未变化时短路，避免同一状态反复写盘
      return {
        ok: true,
        skipped: true,
        reason: 'unchanged',
      }
    }

    try {
      const result = await sendMutationRequest(createSetConfigPathRequest(configPath, normalizedValue))
      const failureMessageKey = resolveFailureMessageKey(result)
      if (failureMessageKey) {
        showWarningMessage(failureMessageKey)
        return result
      }

      applyPersistedValue(normalizedValue)
      return result
    } catch {
      showWarningMessage('message.configWriteFailed')
      return {
        ok: false,
        messageKey: 'message.configWriteFailed',
        reason: 'config-update-transport-failed',
      }
    }
  }

  return {
    persistSidebarVisibility,
  }
}

export default {
  createSidebarVisibilityPersistenceController,
}
