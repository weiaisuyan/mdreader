let activePreparationHandler = null

// 默认键：单栏窗口只有一个编辑视图，键不影响行为。
const DEFAULT_PREPARATION_PROVIDER_KEY = 'default'

// 多栏并排后窗口里同时存在多份编辑视图，准备能力必须能按栏取：
// Map 保存每个栏的提供者，focusedKey 指向当前焦点栏。
const preparationProviderMap = new Map()
let focusedPreparationProviderKey = null

/**
 * 注册宿主级准备处理器。
 *
 * HomeView 作为 owner 只应有一个有效处理器，
 * 新注册会直接替换旧处理器。
 *
 * @param {Function | null | undefined} handler
 * @returns {Function} 返回用于注销当前准备处理器的清理函数。
 */
export function registerCurrentWindowOpenPreparation(handler) {
  activePreparationHandler = typeof handler === 'function' ? handler : null

  return () => {
    if (activePreparationHandler === handler) {
      activePreparationHandler = null
    }
  }
}

/**
 * 设置某个栏提供的准备能力。
 *
 * EditorView 只负责暴露自己的稳定化逻辑，
 * 不直接成为最终 owner；同一个键重复注册会覆盖（一个栏只有一份正文来源）。
 *
 * @param {Function | null | undefined} provider
 * @param {string} [providerKey] 栏 id；不传走默认槽
 * @returns {Function} 返回用于移除当前视图准备能力的清理函数。
 */
export function setCurrentWindowOpenPreparationProvider(
  provider,
  providerKey = DEFAULT_PREPARATION_PROVIDER_KEY,
) {
  const key = typeof providerKey === 'string' && providerKey !== ''
    ? providerKey
    : DEFAULT_PREPARATION_PROVIDER_KEY

  if (typeof provider === 'function') {
    preparationProviderMap.set(key, provider)
    // 新注册的栏默认先拿到焦点标记，随后 onActivated / 焦点切换会把它纠正过来。
    if (focusedPreparationProviderKey === null) {
      focusedPreparationProviderKey = key
    }
  }
  else {
    preparationProviderMap.delete(key)
    if (focusedPreparationProviderKey === key) {
      focusedPreparationProviderKey = preparationProviderMap.keys().next().value ?? null
    }
  }

  return () => {
    if (preparationProviderMap.get(key) === provider) {
      preparationProviderMap.delete(key)
      if (focusedPreparationProviderKey === key) {
        focusedPreparationProviderKey = preparationProviderMap.keys().next().value ?? null
      }
    }
  }
}

/**
 * 标记当前焦点栏。
 *
 * 切换文档一定发生在焦点栏里，所以请求准备结果时必须用它的提供者；
 * 用错栏会让“切换前的正文收敛”把另一栏的编辑器当成目标。
 *
 * @param {string | null | undefined} providerKey 栏 id
 */
export function setFocusedPreparationProviderKey(providerKey) {
  const key = typeof providerKey === 'string' && providerKey !== ''
    ? providerKey
    : null
  if (key !== null && preparationProviderMap.has(key)) {
    focusedPreparationProviderKey = key
  }
}

/**
 * 取当前应该使用的提供者。
 *
 * 优先焦点栏；焦点栏没有注册时退到默认槽，再退到任意一个已注册的栏，
 * 这样单栏窗口（包括测试里的默认注册）行为完全不变。
 *
 * @returns {Function | null} 准备能力提供者
 */
function resolvePreparationProvider() {
  if (focusedPreparationProviderKey !== null) {
    const provider = preparationProviderMap.get(focusedPreparationProviderKey)
    if (typeof provider === 'function') {
      return provider
    }
  }

  const defaultProvider = preparationProviderMap.get(DEFAULT_PREPARATION_PROVIDER_KEY)
  if (typeof defaultProvider === 'function') {
    return defaultProvider
  }

  for (const provider of preparationProviderMap.values()) {
    if (typeof provider === 'function') {
      return provider
    }
  }

  return null
}

/**
 * 请求当前窗口切换前准备结果。
 *
 * @param {object} options
 * @returns {Promise<object>} 返回当前窗口切换前的结构化准备结果。
 */
export async function requestCurrentWindowOpenPreparation(options = {}) {
  if (typeof activePreparationHandler !== 'function') {
    return {
      ok: false,
      reason: 'preparation-unavailable',
    }
  }

  return await activePreparationHandler({
    ...options,
    provider: resolvePreparationProvider(),
  })
}

export default {
  registerCurrentWindowOpenPreparation,
  setCurrentWindowOpenPreparationProvider,
  setFocusedPreparationProviderKey,
  requestCurrentWindowOpenPreparation,
}
