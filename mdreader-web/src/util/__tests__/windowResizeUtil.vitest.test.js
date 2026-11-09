import { describe, expect, it } from 'vitest'
import {
  RESIZE_DIRECTIONS,
  resolveResizeCursor,
  resolveResizeZoneStyle,
  resolveResizedBounds,
} from '../windowResizeUtil.js'

/**
 * 窗口边缘缩放的纯计算部分。
 *
 * 圆角窗口必须 transparent，透明窗口在 Windows 上会丢掉系统缩放，
 * 所以这段换算自己写；它出错的直接表现是「拖边缘窗口跳动 / 反向 / 变成负宽」。
 */
describe('windowResizeUtil', () => {
  const start = { x: 100, y: 200, width: 1000, height: 800 }

  it('向右拖东边：只加宽，位置不变', () => {
    expect(resolveResizedBounds(start, 'e', 120, 0))
      .toEqual({ x: 100, y: 200, width: 1120, height: 800 })
  })

  it('向下拖南边：只加高，位置不变', () => {
    expect(resolveResizedBounds(start, 's', 0, 60))
      .toEqual({ x: 100, y: 200, width: 1000, height: 860 })
  })

  it('拖西边：宽度反向变化，同时左边界跟随', () => {
    // 向左拖 100px（deltaX 为负）→ 左边界左移、宽度变大
    expect(resolveResizedBounds(start, 'w', -100, 0))
      .toEqual({ x: 0, y: 200, width: 1100, height: 800 })
    // 向右拖 100px → 左边界右移、宽度变小
    expect(resolveResizedBounds(start, 'w', 100, 0))
      .toEqual({ x: 200, y: 200, width: 900, height: 800 })
  })

  it('拖北边：高度反向变化，同时上边界跟随', () => {
    expect(resolveResizedBounds(start, 'n', 0, -50))
      .toEqual({ x: 100, y: 150, width: 1000, height: 850 })
  })

  it('拖角同时改两个方向', () => {
    expect(resolveResizedBounds(start, 'se', 30, 40))
      .toEqual({ x: 100, y: 200, width: 1030, height: 840 })
    expect(resolveResizedBounds(start, 'nw', -30, -40))
      .toEqual({ x: 70, y: 160, width: 1030, height: 840 })
  })

  it('宽高不允许被拖成 0 或负数（防止布局塌陷 / setBounds 报错）', () => {
    const bounds = resolveResizedBounds(start, 'e', -5000, 0)
    expect(bounds.width).toBeGreaterThan(0)
    const bounds2 = resolveResizedBounds(start, 's', 0, -5000)
    expect(bounds2.height).toBeGreaterThan(0)
  })

  it('八个方向都有对应的鼠标样式与热区样式', () => {
    expect(RESIZE_DIRECTIONS).toHaveLength(8)
    for (const direction of RESIZE_DIRECTIONS) {
      expect(resolveResizeCursor(direction)).not.toBe('default')
      const style = resolveResizeZoneStyle(direction)
      expect(style.position).toBe('absolute')
      // 每个方向都必须至少锚定一条边，否则热区会跑到中间去
      const anchored = ['top', 'bottom', 'left', 'right'].some(key => style[key] !== undefined)
      expect(anchored).toBe(true)
    }
  })

  it('角落热区要比边缘热区更靠上层，否则角落只能单向缩放', () => {
    const edge = resolveResizeZoneStyle('n')
    const corner = resolveResizeZoneStyle('nw')
    expect(corner.zIndex).toBeGreaterThan(edge.zIndex)
  })
})
