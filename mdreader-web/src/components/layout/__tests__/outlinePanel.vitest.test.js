import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'

import OutlinePanel from '../OutlinePanel.vue'

const outlinePanelState = vi.hoisted(() => ({
  store: {
    documentSessionSnapshot: { content: '# 标题一\n\n## 标题二\n' },
    outlineActiveLine: 12,
    outlineScrollContainer: { scrollTop: 0 },
    outlineNavigateHandler: null,
    setOutlineVisible: vi.fn(),
  },
  parseOutlineFromMarkdown: vi.fn(() => [
    { lineNumber: 1, level: 1, title: '标题一' },
    { lineNumber: 3, level: 2, title: '标题二' },
  ]),
}))

outlinePanelState.store = reactive(outlinePanelState.store)

vi.mock('vue-i18n', () => ({
  useI18n() {
    return {
      t: key => key,
    }
  },
}))

vi.mock('@/stores/counter.js', () => ({
  useCommonStore() {
    return outlinePanelState.store
  },
}))

vi.mock('@/util/editor/outlineParseUtil.js', () => ({
  parseOutlineFromMarkdown: outlinePanelState.parseOutlineFromMarkdown,
}))

const markdownMenuStubState = vi.hoisted(() => ({ propsList: [] }))

vi.mock('@/components/editor/MarkdownMenu.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'MarkdownMenuStub',
      props: {
        anchorList: { type: Array, default: () => [] },
        getContainer: { type: Function, default: null },
        activeLineNumber: { type: Number, default: null },
        showHeader: { type: Boolean, default: true },
      },
      emits: ['anchorNavigate'],
      setup(props, { emit }) {
        markdownMenuStubState.propsList.push(props)
        return () =>
          h('div', {
            'data-testid': 'markdown-menu-stub',
            'onClick': () => emit('anchorNavigate', { lineNumber: 3 }),
          })
      },
    }),
  }
})

const mountedWrapperList = []

function mountOutlinePanel() {
  const wrapper = mount(OutlinePanel)
  mountedWrapperList.push(wrapper)
  return wrapper
}

describe('outlinePanel 右侧大纲栏', () => {
  beforeEach(() => {
    markdownMenuStubState.propsList = []
    outlinePanelState.store.outlineNavigateHandler = null
    outlinePanelState.store.setOutlineVisible.mockReset()
    outlinePanelState.parseOutlineFromMarkdown.mockClear()
  })

  afterEach(() => {
    while (mountedWrapperList.length > 0) {
      mountedWrapperList.pop()?.unmount()
    }
    vi.clearAllMocks()
  })

  it('应渲染标题与 MarkdownMenu', async () => {
    const wrapper = mountOutlinePanel()
    await nextTick()

    expect(wrapper.get('[data-testid="outline-panel"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('outline')
    expect(wrapper.find('[data-testid="markdown-menu-stub"]').exists()).toBe(true)
  })

  it('应把当前文档正文解析成大纲并传给 MarkdownMenu', async () => {
    mountOutlinePanel()
    await nextTick()

    expect(outlinePanelState.parseOutlineFromMarkdown).toHaveBeenCalledWith('# 标题一\n\n## 标题二\n')
    const props = markdownMenuStubState.propsList.at(-1)
    expect(props.anchorList).toHaveLength(2)
    expect(props.showHeader).toBe(false)
    expect(props.activeLineNumber).toBe(12)
  })

  it('点击收起按钮应把大纲栏隐藏', async () => {
    const wrapper = mountOutlinePanel()
    await nextTick()

    await wrapper.get('[data-testid="outline-panel-collapse"]').trigger('click')

    expect(outlinePanelState.store.setOutlineVisible).toHaveBeenCalledWith(false)
  })

  it('markdownMenu 触发锚点导航时应转交给 store 的跳转处理器', async () => {
    const navigateHandler = vi.fn()
    outlinePanelState.store.outlineNavigateHandler = navigateHandler
    const wrapper = mountOutlinePanel()
    await nextTick()

    await wrapper.get('[data-testid="markdown-menu-stub"]').trigger('click')

    expect(navigateHandler).toHaveBeenCalledWith({ lineNumber: 3 })
  })
})
