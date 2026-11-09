/**
 * 去掉文档开头的 UTF-8 BOM（\uFEFF）。
 *
 * 为什么需要它：markdown-it 只有在 `#` 位于行首时才认标题。带 BOM 的文件
 * 首字符是 \uFEFF，`# 标题` 就退化成普通段落，阅读模式里会原样显示
 * “# 标题”并丢掉标题语义。Windows 上不少编辑器/脚本写文件默认带 BOM，
 * 而 BOM 在编辑器里是看不见的，用户只会觉得“预览坏了”。
 *
 * 只处理文档开头的第一个 BOM，正文中间的 \uFEFF 属于用户内容，不动。
 */
export default function markdownItStripBom(md) {
  md.core.ruler.before('normalize', 'strip_bom', (state) => {
    if (typeof state.src === 'string' && state.src.charCodeAt(0) === 0xFEFF) {
      state.src = state.src.slice(1)
    }
  })
}
