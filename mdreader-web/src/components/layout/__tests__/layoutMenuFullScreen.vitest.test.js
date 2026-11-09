import { shallowMount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'

import LayoutMenu from '../LayoutMenu.vue'

const mocked = vi.hoisted(() => ({
  toggleFullScreenAction: vi.fn(),
  channelSend: vi.fn(),
  shortcutKeyHandler: vi.fn(),
}))

const store = reactive({
  isFullScreen: false,
  recentList: [],
  viewMode: 'split',
  setViewMode: vi.fn(),
  config: {
    language: 'zh-CN',
    shortcutKeyList: [
      {
        id: 'toggleFullScreen',
        keymap: 'F11',
        enabled: true,
      },
    ],
  },
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: key => key,
  }),
}))

vi.mock('@/stores/counter.js', () => ({
  useCommonStore: () => store,
}))

vi.mock('@/util/channel/channelUtil.js', () => ({
  default: {
    send: mocked.channelSend,
  },
}))

vi.mock('@/util/commonUtil.js', () => ({
  default: {
    createId: vi.fn(() => 'mock-id'),
    createLabel: (label, shortcuts) => ({
      children: [label, shortcuts],
    }),
    createRecentLabel: (path, name) => ({
      children: [path, name],
    }),
    recentFileNotExists: vi.fn(),
  },
}))

vi.mock('@/util/fullScreenActionUtil.js', () => ({
  default: mocked.toggleFullScreenAction,
}))

vi.mock('@/util/shortcutKeyUtil.js', () => ({
  default: {
    getWebShortcutKeyHandler: mocked.shortcutKeyHandler,
  },
}))

function extractTextFromNode(node) {
  if (Array.isArray(node)) {
    return node.map(item => extractTextFromNode(item)).join('')
  }

  if (typeof node === 'string') {
    return node
  }

  if (typeof node === 'number') {
    return String(node)
  }

  if (!node || typeof node !== 'object') {
    return ''
  }

  return extractTextFromNode(node.children)
}

function getSetupBinding(wrapper, key) {
  return wrapper.vm[key] ?? wrapper.vm.$.setupState[key]
}

function getFileMenuChildren(wrapper) {
  const menuList = getSetupBinding(wrapper, 'menuList')
  return menuList[0].children
}

function findFullScreenItem(children) {
  // 全屏是文件菜单里的最后一项，产品要求它就落在「设置」之后
  return children[children.length - 1]
}

describe('layoutMenu 视图菜单移除后的全屏入口', () => {
  beforeEach(() => {
    store.isFullScreen = false
    store.recentList = []
    store.viewMode = 'split'
    store.config.language = 'zh-CN'
    store.config.shortcutKeyList = [
      {
        id: 'toggleFullScreen',
        keymap: 'F11',
        enabled: true,
      },
    ]
    mocked.toggleFullScreenAction.mockReset()
    mocked.channelSend.mockReset()
    mocked.shortcutKeyHandler.mockReset()
    store.setViewMode.mockReset()
  })

  it('顶部菜单只剩文件与帮助，视图菜单必须整体移除', () => {
    const wrapper = shallowMount(LayoutMenu, {
      global: {
        stubs: {
          'a-dropdown': true,
          'a-menu': true,
        },
      },
    })

    const menuList = getSetupBinding(wrapper, 'menuList')

    expect(menuList).toHaveLength(2)
    expect(extractTextFromNode(menuList[0].label)).toBe('topMenu.file.name')
    expect(extractTextFromNode(menuList[1].label)).toBe('topMenu.help.name')
    // 视图菜单里的三种模式在菜单栏不应再出现任何入口
    const allText = menuList.map(item => extractTextFromNode(item.children)).join(' ')
    expect(allText).not.toContain('shortcutKey.viewSplit')
  })

  it('全屏项必须放在文件菜单最后一项，并显示当前快捷键', () => {
    const wrapper = shallowMount(LayoutMenu, {
      global: {
        stubs: {
          'a-dropdown': true,
          'a-menu': true,
        },
      },
    })

    const children = getFileMenuChildren(wrapper)
    const fullScreenItem = findFullScreenItem(children)

    expect(extractTextFromNode(fullScreenItem.label)).toContain('topMenu.view.children.enterFullScreen')
    expect(extractTextFromNode(fullScreenItem.label)).toContain('F11')
    // 全屏项之前必须有分割线，与「设置」隔开
    expect(children[children.length - 2].type).toBe('divider')
  })

  it('store.isFullScreen 变化后文件菜单里的全屏文案必须跟着变', async () => {
    const wrapper = shallowMount(LayoutMenu, {
      global: {
        stubs: {
          'a-dropdown': true,
          'a-menu': true,
        },
      },
    })

    store.isFullScreen = true
    await nextTick()

    expect(extractTextFromNode(findFullScreenItem(getFileMenuChildren(wrapper)).label)).toContain(
      'topMenu.view.children.exitFullScreen',
    )

    store.isFullScreen = false
    await nextTick()

    expect(extractTextFromNode(findFullScreenItem(getFileMenuChildren(wrapper)).label)).toContain(
      'topMenu.view.children.enterFullScreen',
    )
  })

  it('点击文件菜单里的全屏项时必须调用共享动作', async () => {
    const wrapper = shallowMount(LayoutMenu, {
      global: {
        stubs: {
          'a-dropdown': true,
          'a-menu': true,
        },
      },
    })

    await findFullScreenItem(getFileMenuChildren(wrapper)).click()

    expect(mocked.toggleFullScreenAction).toHaveBeenCalledTimes(1)
  })
})
