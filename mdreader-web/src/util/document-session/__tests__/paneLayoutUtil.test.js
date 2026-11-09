import assert from 'node:assert/strict'

import {
  MAX_PANE_COUNT,
  MIN_PANE_WIDTH,
  normalizePaneLayout,
  resolveMinContentWidth,
  resolvePaneGridTemplateColumns,
} from '../paneLayoutUtil.js'

const { test } = await import('node:test')

test('栏数必须夹在允许区间内，宽度数量跟着栏数走', () => {
  assert.equal(normalizePaneLayout({ count: 2 }).count, 2)
  assert.deepEqual(normalizePaneLayout({ count: 2, widths: [400] }), { count: 2, widths: [400, null] })
  assert.deepEqual(
    normalizePaneLayout({ count: 5, widths: [400, 500, 600, 700, 800] }),
    { count: MAX_PANE_COUNT, widths: [400, 500, 600, 700] },
  )
  assert.equal(MAX_PANE_COUNT, 4)
})

test('宽度小于下限时回落到均分（null），不能把栏压成 0 宽', () => {
  assert.deepEqual(
    normalizePaneLayout({ count: 2, widths: [MIN_PANE_WIDTH - 1, 420] }),
    { count: 2, widths: [null, 420] },
  )
  assert.deepEqual(normalizePaneLayout({ count: 1, widths: ['auto'] }), { count: 1, widths: [null] })
})

// 列模板只做两件事：有存档宽度用像素、没存档用 1fr。
// 缩放行为（未触底同比例缩 / 触底钉住）完全由 CSS Grid 原生处理，
// 这里不含任何 JS 宽度计算 —— 这是用户明确要求「把缩放逻辑全部删掉」后的形态。

test('均分栏输出 minmax(下限, 1fr)', () => {
  assert.equal(
    resolvePaneGridTemplateColumns({ count: 2 }, 4, 2),
    `minmax(${MIN_PANE_WIDTH}px, 1fr) 4px minmax(${MIN_PANE_WIDTH}px, 1fr)`,
  )
})

test('有存档宽度的栏用像素值当 fr 权重（这样它也会跟着缩）', () => {
  assert.equal(
    resolvePaneGridTemplateColumns({ count: 2, widths: [566, null] }, 4, 2),
    `minmax(${MIN_PANE_WIDTH}px, 566fr) 4px minmax(${MIN_PANE_WIDTH}px, 1fr)`,
  )
})

test('所有栏都是 fr 权重：窗口缩小时没有哪一栏会「纹丝不动」', () => {
  const columns = resolvePaneGridTemplateColumns({ count: 2, widths: [619, 1019] }, 4, 2)
  // 两栏都必须带 fr，不能有任何一栏被写成固定 px
  assert.equal((columns.match(/fr/g) || []).length, 2, columns)
  assert.ok(!/minmax\(\d+px, \d+px\)/.test(columns), '不能出现固定像素上限：' + columns)
})

test('单栏：一个 minmax 列，无分隔条', () => {
  assert.equal(
    resolvePaneGridTemplateColumns({ count: 1 }, 4, 1),
    `minmax(${MIN_PANE_WIDTH}px, 1fr)`,
  )
})

test('4 栏：4 个 minmax 列 + 3 条分隔条', () => {
  const columns = resolvePaneGridTemplateColumns({ count: 4 }, 4, 4)
  assert.equal((columns.match(/minmax\(/g) || []).length, 4)
  assert.equal((columns.match(/4px/g) || []).length, 3)
})

test('每一栏都带同一个最小宽度下限（三处统一）', () => {
  for (const count of [1, 2, 3, 4]) {
    const columns = resolvePaneGridTemplateColumns({ count }, 4, count)
    const minmaxList = [...columns.matchAll(/minmax\((\d+)px,/g)].map(m => Number(m[1]))
    assert.equal(minmaxList.length, count)
    for (const value of minmaxList) {
      assert.equal(value, MIN_PANE_WIDTH, `下限必须统一：${columns}`)
    }
  }
})

test('下限常量就是 160', () => {
  assert.equal(MIN_PANE_WIDTH, 160)
})

test('三栏混合：有宽度的用像素权重、没有的用 1fr', () => {
  const columns = resolvePaneGridTemplateColumns({ count: 3, widths: [400, null, 500] }, 4, 3)
  const frList = [...columns.matchAll(/minmax\(\d+px, ([\d.]+)fr\)/g)].map(m => Number(m[1]))
  assert.deepEqual(frList, [400, 1, 500])
})

// 窗口最小宽度不能写死：不同栏数/侧栏状态需要不同宽度。
// 写死 800 时二栏布局缩到 800 就停，左栏还剩 300 多像素没缩到底
// （用户实测：「缩到最小宽度之后还能再缩吗？缩不了了」）。
test('最小内容宽度 = 所有栏都到 MIN_PANE_WIDTH + 全部分隔条', () => {
  assert.equal(resolveMinContentWidth({ paneCount: 1 }), MIN_PANE_WIDTH)
  assert.equal(
    resolveMinContentWidth({ paneCount: 2 }),
    MIN_PANE_WIDTH * 2 + 4,
  )
  assert.equal(
    resolveMinContentWidth({ paneCount: 2, sidebarVisible: true }),
    MIN_PANE_WIDTH * 3 + 4 + 1,
  )
  assert.equal(
    resolveMinContentWidth({ paneCount: 2, sidebarVisible: true, outlineVisible: true }),
    MIN_PANE_WIDTH * 4 + 4 + 2,
  )
  assert.equal(
    resolveMinContentWidth({ paneCount: 4, sidebarVisible: true, outlineVisible: true }),
    MIN_PANE_WIDTH * 6 + 12 + 2,
  )
})

test('栏数缺省或非法时按 1 栏算', () => {
  assert.equal(resolveMinContentWidth(), MIN_PANE_WIDTH)
  assert.equal(resolveMinContentWidth({ paneCount: 0 }), MIN_PANE_WIDTH)
  assert.equal(resolveMinContentWidth({ paneCount: Number.NaN }), MIN_PANE_WIDTH)
})
