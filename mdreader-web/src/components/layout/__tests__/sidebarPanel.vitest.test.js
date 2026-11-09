import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import SidebarPanel from '../SidebarPanel.vue'

vi.mock('@/components/layout/FileManagerPanel.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'FileManagerPanelStub',
      setup() {
        return () => h('div', { 'data-testid': 'file-manager-panel-stub' })
      },
    }),
  }
})

vi.mock('@/components/editor/MarkdownMenu.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'MarkdownMenuStub',
      setup() {
        return () => h('div', { 'data-testid': 'markdown-menu-stub' })
      },
    }),
  }
})

const mountedWrapperList = []

function mountSidebarPanel() {
  const wrapper = mount(SidebarPanel)
  mountedWrapperList.push(wrapper)
  return wrapper
}

describe('sidebarPanel 文件栏容器', () => {
  afterEach(() => {
    while (mountedWrapperList.length > 0) {
      mountedWrapperList.pop()?.unmount()
    }
    vi.clearAllMocks()
  })

  it('应渲染文件面板', () => {
    const wrapper = mountSidebarPanel()

    expect(wrapper.get('[data-testid="sidebar-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="file-manager-panel-stub"]').exists()).toBe(true)
  })

  it('大纲已迁到右侧独立面板，这里不应再渲染 MarkdownMenu', () => {
    const wrapper = mountSidebarPanel()

    expect(wrapper.find('[data-testid="markdown-menu-stub"]').exists()).toBe(false)
  })

  it('不应再渲染文件/大纲切换 tab 按钮', () => {
    const wrapper = mountSidebarPanel()

    expect(wrapper.find('[data-testid="sidebar-tab-files"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="sidebar-tab-outline"]').exists()).toBe(false)
  })
})
