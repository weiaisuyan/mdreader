/**
 * 换行风格工具。
 *
 * ## 为什么需要这个
 *
 * 磁盘上的 Markdown 文件可能是 CRLF（Windows 记事本另存的默认风格），
 * 而编辑器（CodeMirror）内部一律把正文归一成 `\n`。
 * 于是出现这样的假象：
 *   打开一个 CRLF 文件 → 编辑器把它变成 `\n` 后回传给主进程 →
 *   `editorSnapshot.content`（LF）与 `diskSnapshot.content`（CRLF）字符串不相等 →
 *   派生快照里 `saved=false / dirty=true` → 关闭标签或关窗口时弹出「未保存的修改」。
 * 用户完全没有改过文件，却被迫处理一个假的保存确认。
 *
 * 解决方式不是「比较时忽略换行」（那样保存时会把用户文件悄悄改成 LF），
 * 而是在正文进入编辑器快照时就按磁盘原有风格展开：
 * 这样比较相等、不会假脏，保存时写回的仍是 CRLF，文件风格一点没变。
 */

/**
 * 判断一段正文使用哪种换行风格。
 *
 * 判定规则：出现 `\r\n` 即为 CRLF，否则一律按 LF 处理。
 * 单独 `\r`（老式 Mac 换行）在 Markdown 场景极罕见，这里也归到 CRLF 一侧，
 * 保证写回时不会把它拆成两个字符。
 *
 * @param {string} text 正文内容
 * @returns {'crlf' | 'lf'} 换行风格
 */
export function detectLineEnding(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return 'lf'
  }
  return text.includes('\r\n') || text.includes('\r') ? 'crlf' : 'lf'
}

/**
 * 把正文统一成指定的换行风格。
 *
 * 先把所有 `\r\n` / 裸 `\r` 归一成 `\n`，再按目标风格展开，
 * 因此重复调用是幂等的（applyLineEnding(applyLineEnding(t, e), e) === applyLineEnding(t, e)）。
 *
 * @param {string} text 正文内容
 * @param {'crlf' | 'lf' | undefined} lineEnding 目标换行风格；非 crlf 一律按 lf 处理
 * @returns {string} 归一后的正文
 */
export function applyLineEnding(text, lineEnding) {
  if (typeof text !== 'string') {
    return ''
  }
  const normalized = text.replace(/\r\n?/g, '\n')
  if (lineEnding === 'crlf') {
    return normalized.replace(/\n/g, '\r\n')
  }
  return normalized
}

export default {
  detectLineEnding,
  applyLineEnding,
}
