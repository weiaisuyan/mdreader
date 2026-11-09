/**
 * 统一的 highlight.js 实例（按需注册语言）。
 *
 * 为什么不用 `import hljs from 'highlight.js'`：
 * 那个入口会在 index.js 里逐个 `registerLanguage` 掉 `lib/languages` 下**全部 384 个语言**，
 * 源码合计 1.55 MB（highlight.js 自身 core 只有 76 KB）。实测它让构建产物里的
 * `markdownItDefault` chunk 达到 1.39 MB（gzip 455 KB），是整包最大的单项。
 *
 * 这里只注册实际用得到的语言。`hljs.highlightAuto()` 也只在已注册集合里猜，
 * 覆盖面会略窄，但常见语言全部命中；未注册语言回退成不高亮（纯文本），
 * 不会报错、不会丢内容。
 *
 * ⚠️ 新增语言只需要在下面加一行 import + 一行 registerLanguage，
 * 不要在业务文件里改回 `import hljs from 'highlight.js'`，那会把全量语言重新拉回来。
 */
import hljs from 'highlight.js/lib/core'

import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import http from 'highlight.js/lib/languages/http'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import lua from 'highlight.js/lib/languages/lua'
import makefile from 'highlight.js/lib/languages/makefile'
import markdown from 'highlight.js/lib/languages/markdown'
import nginx from 'highlight.js/lib/languages/nginx'
import php from 'highlight.js/lib/languages/php'
import plaintext from 'highlight.js/lib/languages/plaintext'
import powershell from 'highlight.js/lib/languages/powershell'
import properties from 'highlight.js/lib/languages/properties'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import ini from 'highlight.js/lib/languages/ini'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

const LANGUAGE_LIST = [
  ['bash', bash],
  ['c', c],
  ['cpp', cpp],
  ['csharp', csharp],
  ['css', css],
  ['diff', diff],
  ['dockerfile', dockerfile],
  ['go', go],
  ['http', http],
  ['java', java],
  ['javascript', javascript],
  ['json', json],
  ['kotlin', kotlin],
  ['lua', lua],
  ['makefile', makefile],
  ['markdown', markdown],
  ['nginx', nginx],
  ['php', php],
  ['plaintext', plaintext],
  ['powershell', powershell],
  ['properties', properties],
  ['python', python],
  ['ruby', ruby],
  ['rust', rust],
  ['sql', sql],
  ['swift', swift],
  ['ini', ini],
  ['typescript', typescript],
  ['xml', xml],
  ['yaml', yaml],
]

for (const [name, language] of LANGUAGE_LIST) {
  hljs.registerLanguage(name, language)
}

export default hljs
