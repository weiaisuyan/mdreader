import assert from 'node:assert/strict'

import MarkdownIt from 'markdown-it'

import markdownItStripBom from '../markdownItStripBom.js'

const { test } = await import('node:test')

function createMarkdown() {
  const md = new MarkdownIt({ html: true, breaks: true, xhtmlOut: true })
  markdownItStripBom(md)
  return md
}

test('带 BOM 的文档首行标题必须仍然渲染成 h1', () => {
  const md = createMarkdown()
  const rendered = md.render('\uFEFF# 标题\n\n正文\n')

  assert.match(rendered, /<h1[^>]*>标题<\/h1>/u)
  assert.doesNotMatch(rendered, /# 标题/u)
})

test('不带 BOM 的文档渲染结果不受影响', () => {
  const md = createMarkdown()

  assert.equal(md.render('# 标题\n'), '<h1>标题</h1>\n')
})

test('正文中间的 BOM 属于用户内容，不能被删掉', () => {
  const md = createMarkdown()
  const rendered = md.render('第一段\uFEFF后文\n')

  assert.match(rendered, /第一段\uFEFF后文/u)
})
