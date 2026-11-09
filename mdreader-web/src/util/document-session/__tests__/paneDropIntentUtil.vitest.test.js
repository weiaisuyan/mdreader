import { describe, expect, it } from 'vitest'
import {
  DROP_KIND_LIMIT,
  DROP_KIND_SPLIT,
  DROP_KIND_TAB,
  PANE_EDGE_RATIO,
  resolveDropIntent,
  resolveEdgeSide,
} from '../paneDropIntentUtil.js'

/** 造一个 1000px 宽、800px 高的正文区矩形 */
const rect = { left: 100, right: 1100, top: 50, bottom: 850, width: 1000 }

describe('resolveEdgeSide', () => {
  it('左 20% 返回 left（左侧分栏）', () => {
    expect(resolveEdgeSide(rect, 100)).toBe('left')
    expect(resolveEdgeSide(rect, 200)).toBe('left')
    expect(resolveEdgeSide(rect, 299)).toBe('left')
  })

  it('右 20% 返回 right', () => {
    expect(resolveEdgeSide(rect, 901)).toBe('right')
    expect(resolveEdgeSide(rect, 1100)).toBe('right')
  })

  it('中间 60% 一律返回 null（拖到中间不是分栏）', () => {
    expect(resolveEdgeSide(rect, 350)).toBeNull()
    expect(resolveEdgeSide(rect, 600)).toBeNull()
    expect(resolveEdgeSide(rect, 850)).toBeNull()
  })

  it('20% 分界线归靠近的那一侧：左界归 left，右界归 right', () => {
    const exactLeft = rect.left + rect.width * PANE_EDGE_RATIO
    const exactRight = rect.left + rect.width * (1 - PANE_EDGE_RATIO)
    expect(resolveEdgeSide(rect, exactLeft)).toBe('left')
    expect(resolveEdgeSide(rect, exactRight)).toBe('right')
  })

  it('宽度为 0 的矩形返回 null，不抛错', () => {
    expect(resolveEdgeSide({ left: 0, width: 0 }, 0)).toBeNull()
    expect(resolveEdgeSide(null, 0)).toBeNull()
  })
})

describe('resolveDropIntent', () => {
  const base = {
    paneRect: rect,
    paneCount: 1,
    maxPaneCount: 4,
  }

  it('单栏拖到左边缘 → 分栏（左侧）', () => {
    expect(resolveDropIntent({ ...base, clientX: 150, clientY: 400 }))
      .toMatchObject({ kind: DROP_KIND_SPLIT, side: 'left' })
  })

  it('单栏拖到右边缘 → 分栏（右侧）', () => {
    expect(resolveDropIntent({ ...base, clientX: 1050, clientY: 400 }))
      .toMatchObject({ kind: DROP_KIND_SPLIT, side: 'right' })
  })

  it('单栏拖到正中间 → 加标签，不分栏', () => {
    expect(resolveDropIntent({ ...base, clientX: 600, clientY: 400 }))
      .toMatchObject({ kind: DROP_KIND_TAB, side: null })
  })

  it('指针在栏外 → 加标签兜底，不抛错', () => {
    expect(resolveDropIntent({ ...base, clientX: 10, clientY: 400 }))
      .toMatchObject({ kind: DROP_KIND_TAB })
    expect(resolveDropIntent({ ...base, clientX: 600, clientY: 2000 }))
      .toMatchObject({ kind: DROP_KIND_TAB })
  })

  it('压在标签上时即使在外侧 20% 也只算加标签', () => {
    expect(resolveDropIntent({ ...base, clientX: 150, clientY: 400, onTab: true }))
      .toMatchObject({ kind: DROP_KIND_TAB, side: null })
  })

  it('窄栏没有可用边缘 → 加标签', () => {
    expect(resolveDropIntent({ ...base, clientX: 150, clientY: 400, narrow: true }))
      .toMatchObject({ kind: DROP_KIND_TAB, side: null })
  })

  it('已满 4 栏时边缘带 → 给「最多 N 栏」提示而不是分栏预览', () => {
    expect(resolveDropIntent({
      ...base,
      paneCount: 4,
      maxPaneCount: 4,
      clientX: 1050,
      clientY: 400,
    })).toMatchObject({ kind: DROP_KIND_LIMIT, side: 'right' })
  })

  it('3 栏时右边缘仍可分栏（上限 4）', () => {
    expect(resolveDropIntent({
      ...base,
      paneCount: 3,
      maxPaneCount: 4,
      clientX: 1050,
      clientY: 400,
    })).toMatchObject({ kind: DROP_KIND_SPLIT, side: 'right' })
  })

  it('paneId 原样带回，便于定位在哪个栏画预览', () => {
    expect(resolveDropIntent({
      ...base,
      paneId: 'group-2',
      clientX: 1050,
      clientY: 400,
    })).toMatchObject({ paneId: 'group-2' })
  })
})
