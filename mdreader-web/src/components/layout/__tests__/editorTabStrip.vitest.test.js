import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import EditorTabStrip from '../EditorTabStrip.vue'

/**
 * 顶栏标签条的列模板与编辑区的一致性。
 *
 * 这里的核心不变量是「标签条必须落在自己那一栏的正上方」：
 * 列模板、栏宽、gutter 宽度都必须与 `EditorPaneGrid` 用同一个数据源算出来，
 * 一旦两边各算一份，栏宽一拖就会看到标签条和底盘错位。
 */

const route = reactive({ name: 'editor' })

const store = reactive({
  paneGroupList: [],
  paneLayout: { count: 1, widths: [null] },
  focusedGroupId: null,
})

vi.mock('vue-router', () => ({
  useRoute: () => route,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: key => `translated:${key}` }),
}))

vi.mock('@/stores/counter.js', () => ({
  useCommonStore: () => store,
}))

// 标签条组件本身用桩件，这里只验证它被放在哪、拿到哪个 groupId
const DocumentTabBarStub = {
  name: 'DocumentTabBar',
  props: { groupId: { type: String, default: null } },
  // 渲染尾部插槽，「+ 新建标签」按钮由这里进来（真实组件也是同一个插槽）
  template: '<div class="document-tab-bar-stub" :data-group-id="groupId"><slot name="after-tabs" /></div>',
}

function mountStrip() {
  return mount(EditorTabStrip, {
    global: {
      stubs: { DocumentTabBar: DocumentTabBarStub },
    },
  })
}

beforeEach(() => {
  route.name = 'editor'
  store.paneGroupList = [
    { groupId: 'main', tabs: [], activeSessionId: null, snapshot: null },
  ]
  store.paneLayout = { count: 1, widths: [null] }
  store.focusedGroupId = 'main'
})

describe('editorTabStrip 与编辑区对齐', () => {
  it('单栏时不渲染分隔条，且标签条不传 groupId（沿用窗口级快照）', () => {
    const wrapper = mountStrip()

    expect(wrapper.find('[data-testid="editor-tab-strip"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="editor-tab-strip-pane"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="editor-tab-strip-gutter"]').exists()).toBe(false)
    expect(wrapper.get('.document-tab-bar-stub').attributes('data-group-id')).toBeUndefined()

    wrapper.unmount()
  })

  it('两栏时列模板必须与编辑区一致，并在中间留一条与 gutter 同宽的分隔条', () => {
    store.paneGroupList = [
      { groupId: 'main', tabs: [], activeSessionId: null, snapshot: null },
      { groupId: 'group-2', tabs: [], activeSessionId: null, snapshot: null },
    ]
    store.paneLayout = { count: 2, widths: [null, null] }
    const wrapper = mountStrip()

    const strip = wrapper.get('[data-testid="editor-tab-strip"]')
    expect(strip.attributes('style')).toContain('grid-template-columns: minmax(160px, 1fr) 4px minmax(160px, 1fr)')
    expect(wrapper.findAll('[data-testid="editor-tab-strip-pane"]')).toHaveLength(2)
    expect(wrapper.findAll('[data-testid="editor-tab-strip-gutter"]')).toHaveLength(1)

    // 多栏时每栏必须拿到自己的 groupId，否则两栏会共享同一份窗口级标签列表
    const groupIdList = wrapper.findAll('.document-tab-bar-stub').map(node => node.attributes('data-group-id'))
    expect(groupIdList).toEqual(['main', 'group-2'])

    wrapper.unmount()
  })

  it('拖动 gutter 改变栏宽后，标签条的列模板必须跟着变', () => {
    store.paneGroupList = [
      { groupId: 'main', tabs: [], activeSessionId: null, snapshot: null },
      { groupId: 'group-2', tabs: [], activeSessionId: null, snapshot: null },
    ]
    store.paneLayout = { count: 2, widths: [678, 542] }
    const wrapper = mountStrip()

    expect(wrapper.get('[data-testid="editor-tab-strip"]').attributes('style'))
      // 用户拖过的固定宽现在写成 minmax(px, px)：下限与固定值都取它
      .toContain('grid-template-columns: minmax(160px, 678fr) 4px minmax(160px, 542fr)')

    wrapper.unmount()
  })

  it('非编辑页不渲染标签条（设置页要把整行让给窗口拖动）', () => {
    route.name = 'setting'
    const wrapper = mountStrip()

    expect(wrapper.find('[data-testid="editor-tab-strip"]').exists()).toBe(false)

    wrapper.unmount()
  })

  it('每一栏都有「新建标签」按钮；该栏已有空白标签时按钮置灰', () => {
    // 单栏：当前标签已保存过（有 displayPath）→ 按钮可用
    store.documentSessionSnapshot = {
      tabs: [{ sessionId: 's1', fileName: 'a.md', displayPath: 'D:/a.md' }],
    }
    const single = mountStrip()
    expect(single.findAll('[data-testid="editor-tab-strip-new-tab"]')).toHaveLength(1)
    expect(single.get('[data-testid="editor-tab-strip-new-tab"]').attributes('disabled')).toBeUndefined()
    single.unmount()

    // 单栏：当前标签是没保存过的新标签（displayPath 为空）→ 置灰
    store.documentSessionSnapshot = {
      tabs: [{ sessionId: 's2', fileName: 'Untitled', displayPath: null }],
    }
    const singleWithDraft = mountStrip()
    expect(singleWithDraft.get('[data-testid="editor-tab-strip-new-tab"]').attributes('disabled')).toBeDefined()
    singleWithDraft.unmount()

    // 双栏：每栏各一个按钮，只看自己那栏有没有空白标签
    store.paneGroupList = [
      { groupId: 'main', tabs: [], activeSessionId: null, snapshot: null },
      { groupId: 'group-2', tabs: [], activeSessionId: null, snapshot: null },
    ]
    store.paneLayout = { count: 2, widths: [null, null] }
    store.getPaneGroupSnapshot = groupId => ({
      tabs: groupId === 'group-2'
        ? [{ sessionId: 's3', fileName: 'Untitled', displayPath: null }]
        : [{ sessionId: 's4', fileName: 'b.md', displayPath: 'D:/b.md' }],
    })
    const dual = mountStrip()
    const buttonList = dual.findAll('[data-testid="editor-tab-strip-new-tab"]')
    expect(buttonList).toHaveLength(2)
    expect(buttonList[0].attributes('disabled')).toBeUndefined()
    expect(buttonList[1].attributes('disabled')).toBeDefined()
    dual.unmount()
  })
})
