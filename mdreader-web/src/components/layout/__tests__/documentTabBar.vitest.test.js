import { flushPromises, mount } from '@vue/test-utils'
import { message } from 'ant-design-vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'

import channelUtil from '@/util/channel/channelUtil.js'
import { requestCurrentWindowOpenPreparation } from '@/util/document-session/currentWindowOpenPreparationService.js'
import {
  requestDocumentActivateTab,
  requestDocumentCloseTab,
  requestDocumentCloseTabs,
  requestDocumentMoveTabToGroup,
  requestDocumentMoveTabToNewWindow,
  requestDocumentReorderTabs,
  requestDocumentRevealInFolder,
} from '@/util/document-session/rendererDocumentCommandUtil.js'
import DocumentTabBar from '../DocumentTabBar.vue'

const defaultTabs = [
  { sessionId: 'session-1', fileName: 'a.md', displayPath: 'D:/docs/a.md', dirty: false },
  { sessionId: 'session-2', fileName: 'b.md', displayPath: 'D:/docs/b.md', dirty: true },
]

const store = reactive({
  config: { autoSave: [] },
  documentSessionSnapshot: {
    activeSessionId: 'session-1',
    tabs: defaultTabs.map(tab => ({ ...tab })),
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

vi.mock('@/util/document-session/rendererDocumentCommandUtil.js', () => ({
  requestDocumentActivateTab: vi.fn(() => Promise.resolve()),
  requestDocumentCloseTab: vi.fn(() => Promise.resolve()),
  requestDocumentCloseTabs: vi.fn(() => Promise.resolve()),
  requestDocumentMoveTabToGroup: vi.fn(() => Promise.resolve(true)),
  requestDocumentMoveTabToNewWindow: vi.fn(() => Promise.resolve('window-new')),
  requestDocumentReorderTabs: vi.fn(() => Promise.resolve()),
  requestDocumentRevealInFolder: vi.fn(() => Promise.resolve({ ok: true })),
}))

vi.mock('@/util/document-session/currentWindowOpenPreparationService.js', () => ({
  requestCurrentWindowOpenPreparation: vi.fn(() => Promise.resolve({ ok: true })),
}))

// 双击空白处新建标签走主进程的 `create-new` 通道（与 Ctrl+N 同一个入口）
vi.mock('@/util/channel/channelUtil.js', () => ({
  default: {
    send: vi.fn(() => Promise.resolve()),
  },
}))

// 确认弹窗的返回结果由用例控制：默认走 onOk，需要验证取消时改成 false。
const modalState = vi.hoisted(() => ({
  confirmResult: true,
  confirm: vi.fn(),
}))

// 组件直接用 ant-design-vue 的 message 给复制/打开目录反馈，这里只保留提示入口。
vi.mock('ant-design-vue', () => ({
  message: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
  Modal: {
    confirm: modalState.confirm,
  },
}))

// store 是模块级 reactive，测试之间必须重置，否则上一条用例改过的状态会污染下一条
beforeEach(() => {
  store.config = { autoSave: [] }
  delete store.paneGroupList
  delete store.focusedGroupId
  store.documentSessionSnapshot.activeSessionId = 'session-1'
  store.documentSessionSnapshot.tabs = defaultTabs.map(tab => ({ ...tab }))
  vi.clearAllMocks()
  modalState.confirmResult = true
  modalState.confirm.mockImplementation((config) => {
    if (modalState.confirmResult) {
      config?.onOk?.()
    }
    else {
      config?.onCancel?.()
    }
    return { destroy: vi.fn(), update: vi.fn() }
  })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  })
})

/**
 * 标签栏只需要 dropdown 的默认插槽内容。
 *
 * 但 overlay 插槽必须一起渲染：ant-design-vue 的 Dropdown 只从 overlay 插槽取菜单内容，
 * 丢掉插槽的桩会让「右键菜单根本没挂上」这类缺陷完全不可见。
 *
 * 拖拽重排依赖挂在 `window` 上的指针监听，所以相关用例必须传 `attachTo`，
 * 否则组件脱离文档，事件不会传播到 window。
 */
function mountTabBar({ attachTo = document.body } = {}) {
  return mount(DocumentTabBar, {
    attachTo,
    global: {
      stubs: {
        ADropdown: { template: '<div class="dropdown-stub"><slot /><slot name="overlay" /></div>' },
        AMenu: {
          name: 'AMenu',
          props: { items: { type: Array, default: () => [] } },
          template: `
            <div class="menu-stub">
              <template v-for="(item, index) in items" :key="item.key || 'divider-' + index">
                <span v-if="item.type === 'divider'" class="menu-stub__divider" data-testid="document-tab-menu-divider" />
                <span
                  v-else
                  class="menu-stub__item"
                  :data-menu-key="item.key"
                  :data-disabled="item.disabled ? 'true' : 'false'"
                >{{ item.label }}</span>
              </template>
            </div>
          `,
        },
      },
    },
  })
}

/**
 * 构造带指针字段的事件桩。
 *
 * jsdom 不做布局也不保证提供 PointerEvent，所以用普通 Event 补字段，
 * 只保留被测试代码真正读取的那几个。
 */
function createPointerEvent(type, {
  clientX = 0,
  clientY = 0,
  pointerId = 1,
  button = 0,
  pointerType = 'mouse',
} = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    clientX: { value: clientX },
    clientY: { value: clientY },
    pointerId: { value: pointerId },
    button: { value: button },
    pointerType: { value: pointerType },
    isPrimary: { value: true },
  })
  return event
}

/**
 * 给滚动容器写入假尺寸。
 *
 * jsdom 的 scrollWidth / clientWidth 恒为 0，不显式给出的话永远判不出「宽度不够」。
 */
function applyScrollerMetrics(scroller, { scrollWidth = 800, clientWidth = 400 } = {}) {
  Object.defineProperty(scroller, 'scrollWidth', { value: scrollWidth, configurable: true })
  Object.defineProperty(scroller, 'clientWidth', { value: clientWidth, configurable: true })
}

describe('documentTabBar 标签溢出不用滚动条', () => {
  it('标签栏不得出现任何滚动能力：容器 overflow 必须封死，也不再有滑块', () => {
    const wrapper = mountTabBar()
    const tabBar = wrapper.get('[data-testid="document-tab-bar"]')
    const scroller = wrapper.get('[data-testid="document-tab-scroller"]')

    // 原生滚动条在 Chromium 里始终占位；产品明确不要滚动条，容器必须彻底不可滚
    expect(tabBar.classes()).not.toContain('wj-scrollbar')
    expect(scroller.classes()).toContain('overflow-hidden')
    expect(scroller.classes()).not.toContain('overflow-x-auto')

    // 自绘 overlay 滑块已整套移除
    expect(wrapper.find('[data-testid="document-tab-scrollbar-thumb"]').exists()).toBe(false)

    wrapper.unmount()
  })

  it('标签宽度按内容自适应，超出上限才截断，标签变多时压缩而不是滚动', () => {
    const wrapper = mountTabBar()
    const tabs = wrapper.findAll('[data-session-id]')

    expect(tabs.length).toBeGreaterThan(1)
    for (const tab of tabs) {
      // 不再均分剩余宽度。`flex: 0 1 auto` 写在 .document-tab 的 scss 里：
      //   · 名字短时标签就窄，不会留一大片空白；
      //   · 名字长时受 max-w-60 = 240px 上限约束，超出部分截断；
      //   · 标签变多时靠 flex-shrink 压到 min-w-6 = 24px 下限，仍然不需要滚动条。
      expect(tab.classes()).not.toContain('flex-1')
      expect(tab.classes()).not.toContain('basis-0')
      expect(tab.classes()).toContain('min-w-6')
      expect(tab.classes()).toContain('max-w-60')
      expect(tab.classes()).toContain('overflow-hidden')
    }

    wrapper.unmount()
  })

  it('垂直滚轮不再改写标签栏的横向滚动位置', async () => {
    const wrapper = mountTabBar()
    const scroller = wrapper.get('[data-testid="document-tab-scroller"]').element
    await nextTick()

    applyScrollerMetrics(scroller)
    scroller.scrollLeft = 0

    const event = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })
    scroller.dispatchEvent(event)
    await nextTick()

    expect(scroller.scrollLeft).toBe(0)

    wrapper.unmount()
  })
})

describe('documentTabBar 右键菜单', () => {
  it('菜单必须挂到 dropdown 的 overlay 插槽上，关闭类与文件类必须分组', () => {
    const wrapper = mountTabBar()

    // 每个标签一份菜单：ant-design-vue 的 Dropdown 只从 overlay 插槽取内容，
    // 用已失效的 `menu` prop 传菜单时这里会是 0
    const menuList = wrapper.findAll('.menu-stub')
    expect(menuList).toHaveLength(2)

    const firstMenuKeys = menuList[0]
      .findAll('.menu-stub__item')
      .map(item => item.attributes('data-menu-key'))
    expect(firstMenuKeys).toEqual([
      'close',
      'close-others',
      'close-left',
      'close-right',
      'move-to-other-pane',
      'move-to-new-window',
      'copy-file-name',
      'copy-path',
      'reveal-in-explorer',
    ])

    // 关闭类 / 窗口动作 / 文件类三组之间各有一条分隔线
    expect(menuList[0].findAll('[data-testid="document-tab-menu-divider"]')).toHaveLength(2)

    // 两个标签时允许迁移到新窗口
    expect(menuList[0].get('[data-menu-key="move-to-new-window"]').attributes('data-disabled')).toBe('false')

    // 有 displayPath 的标签不禁止复制路径 / 在资源管理器中显示
    expect(menuList[0].get('[data-menu-key="copy-path"]').attributes('data-disabled')).toBe('false')
    expect(menuList[0].get('[data-menu-key="reveal-in-explorer"]').attributes('data-disabled')).toBe('false')

    wrapper.unmount()
  })

  it('单栏时「移动到另一栏」必须置灰，因为没有另一栏可搬', async () => {
    const wrapper = mountTabBar()

    const menu = wrapper.findAllComponents({ name: 'AMenu' })[0]
    expect(menu.get('[data-menu-key="move-to-other-pane"]').attributes('data-disabled')).toBe('true')

    wrapper.unmount()
  })

  it('并排两栏时「移动到另一栏」必须把会话搬到另一栏的标签组', async () => {
    store.paneGroupList = [
      { groupId: 'main', tabs: defaultTabs.map(tab => ({ ...tab })), activeSessionId: 'session-1' },
      { groupId: 'group-2', tabs: [], activeSessionId: null },
    ]
    store.focusedGroupId = 'main'

    const wrapper = mountTabBar()

    const menu = wrapper.findAllComponents({ name: 'AMenu' })[0]
    expect(menu.get('[data-menu-key="move-to-other-pane"]').attributes('data-disabled')).toBe('false')

    await menu.vm.$emit('click', { key: 'move-to-other-pane' })
    await flushPromises()

    // 搬的是同一个会话（不复制），目标必须是另一栏的 groupId
    expect(requestDocumentMoveTabToGroup).toHaveBeenCalledWith('session-1', 'group-2')

    wrapper.unmount()
  })

  it('移动到新窗口必须二次确认，取消时不得发命令', async () => {
    modalState.confirmResult = false
    const wrapper = mountTabBar()

    const menu = wrapper.findAllComponents({ name: 'AMenu' })[0]
    await menu.vm.$emit('click', { key: 'move-to-new-window' })
    await flushPromises()

    expect(modalState.confirm).toHaveBeenCalledTimes(1)
    expect(modalState.confirm.mock.calls[0][0].content).toBe('documentTab.moveToNewWindowConfirmContent')
    expect(requestDocumentMoveTabToNewWindow).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('迁移活动标签前必须先完成正文收敛，再发迁移命令', async () => {
    const wrapper = mountTabBar()

    // 第一个标签（session-1）是活动标签
    const menu = wrapper.findAllComponents({ name: 'AMenu' })[0]
    await menu.vm.$emit('click', { key: 'move-to-new-window' })
    await flushPromises()

    expect(requestCurrentWindowOpenPreparation).toHaveBeenCalledTimes(1)
    expect(requestDocumentMoveTabToNewWindow).toHaveBeenCalledWith('session-1')
    // flush 必须在迁移之前完成，否则防抖窗口里的输入会随旧窗口一起消失
    expect(requestCurrentWindowOpenPreparation.mock.invocationCallOrder[0])
      .toBeLessThan(requestDocumentMoveTabToNewWindow.mock.invocationCallOrder[0])

    wrapper.unmount()
  })

  it('迁移后台标签不需要多余的正文收敛往返', async () => {
    const wrapper = mountTabBar()

    // 第二个标签（session-2）是后台标签
    const menu = wrapper.findAllComponents({ name: 'AMenu' })[1]
    await menu.vm.$emit('click', { key: 'move-to-new-window' })
    await flushPromises()

    expect(requestCurrentWindowOpenPreparation).not.toHaveBeenCalled()
    expect(requestDocumentMoveTabToNewWindow).toHaveBeenCalledWith('session-2')

    wrapper.unmount()
  })

  it('迁移成功后必须给出成功提示', async () => {
    const wrapper = mountTabBar()

    const menu = wrapper.findAllComponents({ name: 'AMenu' })[0]
    await menu.vm.$emit('click', { key: 'move-to-new-window' })
    await flushPromises()

    expect(message.success).toHaveBeenCalledWith('documentTab.moveToNewWindowSucceeded')

    wrapper.unmount()
  })

  it('迁移失败时必须给出错误提示', async () => {
    requestDocumentMoveTabToNewWindow.mockResolvedValueOnce(null)
    const wrapper = mountTabBar()

    const menu = wrapper.findAllComponents({ name: 'AMenu' })[0]
    await menu.vm.$emit('click', { key: 'move-to-new-window' })
    await flushPromises()

    expect(message.error).toHaveBeenCalledWith('documentTab.moveToNewWindowFailed')
    expect(message.success).not.toHaveBeenCalledWith('documentTab.moveToNewWindowSucceeded')

    wrapper.unmount()
  })

  it('点击菜单项必须作用在被右键的那个标签上，而不是活动标签', async () => {
    const wrapper = mountTabBar()

    // 第二个标签（session-2）是后台标签，活动标签是 session-1
    const secondMenu = wrapper.findAllComponents({ name: 'AMenu' })[1]
    await secondMenu.vm.$emit('click', { key: 'close' })

    expect(requestDocumentCloseTab).toHaveBeenCalledWith('session-2')

    wrapper.unmount()
  })

  it('关闭左侧必须只关左侧的干净标签', async () => {
    store.documentSessionSnapshot.tabs = [
      { sessionId: 'session-1', fileName: 'a.md', displayPath: 'D:/docs/a.md', dirty: false },
      { sessionId: 'session-2', fileName: 'b.md', displayPath: 'D:/docs/b.md', dirty: false },
      { sessionId: 'session-3', fileName: 'c.md', displayPath: 'D:/docs/c.md', dirty: false },
    ]
    const wrapper = mountTabBar()

    // 对第三个标签执行「关闭左侧」→ 只关它左边两个
    const thirdMenu = wrapper.findAllComponents({ name: 'AMenu' })[2]
    await thirdMenu.vm.$emit('click', { key: 'close-left' })

    expect(requestDocumentCloseTabs).toHaveBeenCalledTimes(1)
    expect(requestDocumentCloseTabs).toHaveBeenCalledWith(['session-1', 'session-2'])
    expect(requestDocumentCloseTab).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('复制文件名成功后必须给出提示', async () => {
    const wrapper = mountTabBar()

    // 第二个标签（session-2）是后台标签，文件名是 b.md
    const secondMenu = wrapper.findAllComponents({ name: 'AMenu' })[1]
    await secondMenu.vm.$emit('click', { key: 'copy-file-name' })
    await flushPromises()

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('b.md')
    expect(message.success).toHaveBeenCalledWith('message.copySucceeded')

    wrapper.unmount()
  })

  it('复制路径成功后必须给出提示', async () => {
    const wrapper = mountTabBar()

    const firstMenu = wrapper.findAllComponents({ name: 'AMenu' })[0]
    await firstMenu.vm.$emit('click', { key: 'copy-path' })
    await flushPromises()

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('D:/docs/a.md')
    expect(message.success).toHaveBeenCalledWith('message.copySucceeded')

    wrapper.unmount()
  })

  it('在资源管理器中显示必须按被右键标签的路径请求，而不是活动标签', async () => {
    const wrapper = mountTabBar()

    // 第二个标签是后台标签，活动标签是 session-1
    const secondMenu = wrapper.findAllComponents({ name: 'AMenu' })[1]
    await secondMenu.vm.$emit('click', { key: 'reveal-in-explorer' })

    expect(requestDocumentRevealInFolder).toHaveBeenCalledWith('D:/docs/b.md')

    wrapper.unmount()
  })

  it('右侧标签全是脏状态时必须禁用关闭右侧', () => {
    store.documentSessionSnapshot.tabs = [
      { sessionId: 'session-1', fileName: 'a.md', displayPath: 'D:/docs/a.md', dirty: false },
      { sessionId: 'session-2', fileName: 'b.md', displayPath: 'D:/docs/b.md', dirty: true },
      { sessionId: 'session-3', fileName: 'c.md', displayPath: 'D:/docs/c.md', dirty: true },
    ]
    const wrapper = mountTabBar()

    const menu = wrapper.findAll('.menu-stub')[0]
    // 批量关闭会跳过脏标签，右侧没有可关的干净标签 → 必须置灰
    expect(menu.get('[data-menu-key="close-right"]').attributes('data-disabled')).toBe('true')
    expect(menu.get('[data-menu-key="close-left"]').attributes('data-disabled')).toBe('true')
    expect(menu.get('[data-menu-key="close-others"]').attributes('data-disabled')).toBe('true')

    wrapper.unmount()
  })

  it('左侧标签全是脏状态时必须禁用关闭左侧', () => {
    store.documentSessionSnapshot.tabs = [
      { sessionId: 'session-1', fileName: 'a.md', displayPath: 'D:/docs/a.md', dirty: true },
      { sessionId: 'session-2', fileName: 'b.md', displayPath: 'D:/docs/b.md', dirty: true },
      { sessionId: 'session-3', fileName: 'c.md', displayPath: 'D:/docs/c.md', dirty: false },
    ]
    const wrapper = mountTabBar()

    const menu = wrapper.findAll('.menu-stub')[2]
    expect(menu.get('[data-menu-key="close-left"]').attributes('data-disabled')).toBe('true')
    expect(menu.get('[data-menu-key="close-right"]').attributes('data-disabled')).toBe('true')
    expect(menu.get('[data-menu-key="close-others"]').attributes('data-disabled')).toBe('true')

    wrapper.unmount()
  })

  it('一侧混有干净标签时关闭动作必须保持可用', () => {
    store.documentSessionSnapshot.tabs = [
      { sessionId: 'session-1', fileName: 'a.md', displayPath: 'D:/docs/a.md', dirty: false },
      { sessionId: 'session-2', fileName: 'b.md', displayPath: 'D:/docs/b.md', dirty: true },
      { sessionId: 'session-3', fileName: 'c.md', displayPath: 'D:/docs/c.md', dirty: false },
    ]
    const wrapper = mountTabBar()

    const menu = wrapper.findAll('.menu-stub')[0]
    // 右侧 [脏, 干净]：至少有一个可关的干净标签
    expect(menu.get('[data-menu-key="close-right"]').attributes('data-disabled')).toBe('false')
    expect(menu.get('[data-menu-key="close-others"]').attributes('data-disabled')).toBe('false')

    wrapper.unmount()
  })

  it('只有一个标签时，关闭其他 / 关闭左侧 / 关闭右侧必须全部禁用', () => {
    store.documentSessionSnapshot.tabs = [
      { sessionId: 'session-1', fileName: 'a.md', displayPath: 'D:/docs/a.md', dirty: false },
    ]
    const wrapper = mountTabBar()

    const menu = wrapper.findAll('.menu-stub')[0]
    for (const key of ['close-others', 'close-left', 'close-right']) {
      expect(menu.get(`[data-menu-key="${key}"]`).attributes('data-disabled')).toBe('true')
    }
    // 关自己永远可用
    expect(menu.get('[data-menu-key="close"]').attributes('data-disabled')).toBe('false')
    // 单标签迁移等于把整个窗口搬走，只会平白丢掉撤销历史
    expect(menu.get('[data-menu-key="move-to-new-window"]').attributes('data-disabled')).toBe('true')

    wrapper.unmount()
  })

  it('第一个标签必须禁用关闭左侧，但保留关闭右侧', () => {
    store.documentSessionSnapshot.tabs = [
      { sessionId: 'session-1', fileName: 'a.md', displayPath: 'D:/docs/a.md', dirty: false },
      { sessionId: 'session-2', fileName: 'b.md', displayPath: 'D:/docs/b.md', dirty: false },
      { sessionId: 'session-3', fileName: 'c.md', displayPath: 'D:/docs/c.md', dirty: false },
    ]
    const wrapper = mountTabBar()

    const menu = wrapper.findAll('.menu-stub')[0]
    expect(menu.get('[data-menu-key="close-left"]').attributes('data-disabled')).toBe('true')
    expect(menu.get('[data-menu-key="close-right"]').attributes('data-disabled')).toBe('false')
    expect(menu.get('[data-menu-key="close-others"]').attributes('data-disabled')).toBe('false')

    wrapper.unmount()
  })

  it('最后一个标签必须禁用关闭右侧，但保留关闭左侧', () => {
    store.documentSessionSnapshot.tabs = [
      { sessionId: 'session-1', fileName: 'a.md', displayPath: 'D:/docs/a.md', dirty: false },
      { sessionId: 'session-2', fileName: 'b.md', displayPath: 'D:/docs/b.md', dirty: false },
      { sessionId: 'session-3', fileName: 'c.md', displayPath: 'D:/docs/c.md', dirty: false },
    ]
    const wrapper = mountTabBar()

    const menu = wrapper.findAll('.menu-stub')[2]
    expect(menu.get('[data-menu-key="close-right"]').attributes('data-disabled')).toBe('true')
    expect(menu.get('[data-menu-key="close-left"]').attributes('data-disabled')).toBe('false')
    expect(menu.get('[data-menu-key="close-others"]').attributes('data-disabled')).toBe('false')

    wrapper.unmount()
  })

  it('中间标签的关闭左侧与关闭右侧必须同时可用', () => {
    store.documentSessionSnapshot.tabs = [
      { sessionId: 'session-1', fileName: 'a.md', displayPath: 'D:/docs/a.md', dirty: false },
      { sessionId: 'session-2', fileName: 'b.md', displayPath: 'D:/docs/b.md', dirty: false },
      { sessionId: 'session-3', fileName: 'c.md', displayPath: 'D:/docs/c.md', dirty: false },
    ]
    const wrapper = mountTabBar()

    const menu = wrapper.findAll('.menu-stub')[1]
    expect(menu.get('[data-menu-key="close-left"]').attributes('data-disabled')).toBe('false')
    expect(menu.get('[data-menu-key="close-right"]').attributes('data-disabled')).toBe('false')

    wrapper.unmount()
  })

  it('未命名标签必须禁用复制路径与在资源管理器中显示', () => {
    store.documentSessionSnapshot.tabs = [
      { sessionId: 'session-1', fileName: 'Untitled', displayPath: null, dirty: false },
      { sessionId: 'session-2', fileName: 'b.md', displayPath: 'D:/docs/b.md', dirty: false },
    ]
    const wrapper = mountTabBar()

    const menu = wrapper.findAll('.menu-stub')[0]
    expect(menu.get('[data-menu-key="copy-path"]').attributes('data-disabled')).toBe('true')
    expect(menu.get('[data-menu-key="reveal-in-explorer"]').attributes('data-disabled')).toBe('true')

    wrapper.unmount()
  })

  it('未开启关闭标签自动保存时，其它标签全脏则批量关闭必须置灰', () => {
    store.documentSessionSnapshot.tabs = [
      { sessionId: 'session-1', fileName: 'a.md', displayPath: 'D:/docs/a.md', dirty: true },
      { sessionId: 'session-2', fileName: 'b.md', displayPath: 'D:/docs/b.md', dirty: false },
      { sessionId: 'session-3', fileName: 'Untitled', displayPath: null, dirty: true },
    ]
    const wrapper = mountTabBar()

    // 脏标签会被跳过，草稿也不会被关，所以「关闭其他」什么也做不了。
    const menu = wrapper.findAll('.menu-stub')[1]
    expect(menu.get('[data-menu-key="close-others"]').attributes('data-disabled')).toBe('true')

    wrapper.unmount()
  })

  it('开启关闭标签自动保存后，其它标签是脏文件时批量关闭不能置灰', () => {
    store.config = { autoSave: ['closeTab'] }
    store.documentSessionSnapshot.tabs = [
      { sessionId: 'session-1', fileName: 'a.md', displayPath: 'D:/docs/a.md', dirty: true },
      { sessionId: 'session-2', fileName: 'b.md', displayPath: 'D:/docs/b.md', dirty: false },
      { sessionId: 'session-3', fileName: 'Untitled', displayPath: null, dirty: true },
    ]
    const wrapper = mountTabBar()

    // session-1 虽然脏，但会被保存后关掉，因此菜单必须可用；
    // 草稿无路径，即使开关打开也会被跳过，但它不该影响整条菜单的可用性。
    const menu = wrapper.findAll('.menu-stub')[1]
    expect(menu.get('[data-menu-key="close-others"]').attributes('data-disabled')).toBe('false')

    wrapper.unmount()
  })

  it('关闭其它必须把范围内的脏标签也交给主进程裁决', async () => {
    const wrapper = mountTabBar()

    // 渲染层不再按自己的脏标记过滤：
    // 后台标签的脏状态本身可能陈旧，是否保存由主进程按开关决定。
    const firstMenu = wrapper.findAllComponents({ name: 'AMenu' })[0]
    await firstMenu.vm.$emit('click', { key: 'close-others' })

    expect(requestDocumentCloseTabs).toHaveBeenCalledWith(['session-2'])
    expect(requestDocumentCloseTab).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('关闭右侧必须只发一次批量请求，不能逐个发 close-tab', async () => {
    // 三个干净标签，避免脏标签过滤干扰断言
    store.documentSessionSnapshot.tabs = [
      { sessionId: 'session-1', fileName: 'a.md', displayPath: 'D:/docs/a.md', dirty: false },
      { sessionId: 'session-3', fileName: 'c.md', displayPath: 'D:/docs/c.md', dirty: false },
      { sessionId: 'session-4', fileName: 'd.md', displayPath: 'D:/docs/d.md', dirty: false },
    ]
    const wrapper = mountTabBar()

    const firstMenu = wrapper.findAllComponents({ name: 'AMenu' })[0]
    await firstMenu.vm.$emit('click', { key: 'close-right' })

    expect(requestDocumentCloseTabs).toHaveBeenCalledTimes(1)
    expect(requestDocumentCloseTabs).toHaveBeenCalledWith(['session-3', 'session-4'])
    // 逐个关闭会让主进程每个命令都先激活目标，标签高亮会一路跳
    expect(requestDocumentCloseTab).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('关闭其它必须一次交出范围内的全部标签', async () => {
    store.documentSessionSnapshot.tabs = [
      { sessionId: 'session-1', fileName: 'a.md', displayPath: 'D:/docs/a.md', dirty: false },
      { sessionId: 'session-2', fileName: 'b.md', displayPath: 'D:/docs/b.md', dirty: true },
      { sessionId: 'session-3', fileName: 'c.md', displayPath: 'D:/docs/c.md', dirty: false },
      { sessionId: 'session-4', fileName: 'd.md', displayPath: 'D:/docs/d.md', dirty: false },
    ]
    const wrapper = mountTabBar()

    const firstMenu = wrapper.findAllComponents({ name: 'AMenu' })[0]
    await firstMenu.vm.$emit('click', { key: 'close-others' })

    // 脏标签也一并交出：是否保存由主进程按“关闭标签自动保存”开关决定。
    expect(requestDocumentCloseTabs).toHaveBeenCalledTimes(1)
    expect(requestDocumentCloseTabs).toHaveBeenCalledWith(['session-2', 'session-3', 'session-4'])

    wrapper.unmount()
  })
})

describe('documentTabBar 拖拽重排', () => {
  /**
   * 把标签与滚动容器固定在一条水平线上。
   *
   * jsdom 不做布局，`getBoundingClientRect` 恒返回 0，
   * 不显式给尺寸的话拖拽永远算不出落点。
   */
  function applyDragLayout(wrapper, { tabLeftList, tabWidth = 100, viewWidth = 400 }) {
    const scroller = wrapper.get('[data-testid="document-tab-scroller"]').element
    Object.defineProperty(scroller, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        right: viewWidth,
        bottom: 32,
        width: viewWidth,
        height: 32,
      }),
    })
    Object.defineProperty(scroller, 'clientLeft', { configurable: true, value: 0 })
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: viewWidth })
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: viewWidth * 2 })
    scroller.scrollLeft = 0

    const tabElements = defaultTabs.map((tab, index) => {
      const element = wrapper.get(`[data-testid="document-tab-${tab.sessionId}"]`).element
      Object.defineProperty(element, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          left: tabLeftList[index],
          top: 4,
          right: tabLeftList[index] + tabWidth,
          bottom: 28,
          width: tabWidth,
          height: 24,
        }),
      })
      return element
    })

    return { scroller, tabElements }
  }

  /** 等一帧，让拖拽的 rAF 重算真正执行。 */
  function waitForFrame() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()))
  }

  async function dragTab(wrapper, { fromIndex, fromX, toX }) {
    const { tabElements } = applyDragLayout(wrapper, { tabLeftList: [0, 109] })
    await nextTick()

    const element = tabElements[fromIndex]
    element.dispatchEvent(createPointerEvent('pointerdown', { clientX: fromX, clientY: 16 }))
    // 第一次移动只用来越过阈值，此时才真正开始拖拽
    element.dispatchEvent(createPointerEvent('pointermove', { clientX: fromX + 6, clientY: 16 }))
    element.dispatchEvent(createPointerEvent('pointermove', { clientX: toX, clientY: 16 }))
    await waitForFrame()

    return { element, tabElements }
  }

  it('拖到右侧后松手必须发一次重排命令', async () => {
    const wrapper = mountTabBar()
    const tabBar = wrapper.get('[data-testid="document-tab-bar"]')
    const { element } = await dragTab(wrapper, { fromIndex: 0, fromX: 50, toX: 200 })

    // 先确认拖拽真的启动了，否则后面的断言会掩盖“根本没进入拖拽”的问题
    expect(tabBar.classes()).toContain('is-dragging')

    element.dispatchEvent(createPointerEvent('pointerup', { clientX: 200, clientY: 16 }))
    await flushPromises()

    expect(requestDocumentReorderTabs).toHaveBeenCalledTimes(1)
    expect(requestDocumentReorderTabs).toHaveBeenCalledWith(['session-2', 'session-1'])

    wrapper.unmount()
  })

  it('拖拽落回原位时不得发命令', async () => {
    const wrapper = mountTabBar()
    // 越过阈值但没越过第二个标签的中线（中心 159）
    const { element } = await dragTab(wrapper, { fromIndex: 0, fromX: 50, toX: 90 })

    element.dispatchEvent(createPointerEvent('pointerup', { clientX: 90, clientY: 16 }))
    await flushPromises()

    // 顺序没变就不该产生任何广播，否则整个标签栏会白重渲染一次
    expect(requestDocumentReorderTabs).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('拖拽结束后那一次 click 必须被吞掉，不得激活标签', async () => {
    const wrapper = mountTabBar()
    const { element } = await dragTab(wrapper, { fromIndex: 0, fromX: 50, toX: 90 })

    element.dispatchEvent(createPointerEvent('pointerup', { clientX: 90, clientY: 16 }))
    // 浏览器会在 pointerup 后派发 click，这里补上
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flushPromises()

    expect(requestDocumentActivateTab).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('未超过阈值的按下仍然是一次普通点击', async () => {
    const wrapper = mountTabBar()
    const { tabElements } = applyDragLayout(wrapper, { tabLeftList: [0, 109] })
    await nextTick()

    const element = tabElements[1]
    element.dispatchEvent(createPointerEvent('pointerdown', { clientX: 150, clientY: 16 }))
    // 只移动 2px，属于手抖，不应该被当成拖拽
    element.dispatchEvent(createPointerEvent('pointermove', { clientX: 152, clientY: 16 }))
    element.dispatchEvent(createPointerEvent('pointerup', { clientX: 152, clientY: 16 }))
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flushPromises()

    expect(requestDocumentActivateTab).toHaveBeenCalledWith('session-2', { autoSave: true })
    expect(requestDocumentReorderTabs).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('提交后必须等快照确认新顺序才解除拖拽态', async () => {
    const wrapper = mountTabBar()
    const tabBar = wrapper.get('[data-testid="document-tab-bar"]')
    const { element } = await dragTab(wrapper, { fromIndex: 0, fromX: 50, toX: 200 })

    element.dispatchEvent(createPointerEvent('pointerup', { clientX: 200, clientY: 16 }))
    await flushPromises()

    // 命令已经发出，但快照还没回来：
    // 此时清掉拖拽态会让标签先弹回旧顺序、再跳到新顺序，必须有闪回
    expect(requestDocumentReorderTabs).toHaveBeenCalledTimes(1)
    expect(tabBar.classes()).toContain('is-dragging')

    store.documentSessionSnapshot.tabs = [
      { ...defaultTabs[1] },
      { ...defaultTabs[0] },
    ]
    await nextTick()
    await nextTick()

    expect(tabBar.classes()).not.toContain('is-dragging')

    wrapper.unmount()
  })

  it('拖拽中按右键不得打断拖拽，也不得关闭标签', async () => {
    const wrapper = mountTabBar()
    const tabBar = wrapper.get('[data-testid="document-tab-bar"]')
    const { element } = await dragTab(wrapper, { fromIndex: 0, fromX: 50, toX: 90 })

    // 右键完整一轮：按下 → 菜单 → 松开 → auxclick
    element.dispatchEvent(createPointerEvent('pointerdown', { clientX: 90, clientY: 16, button: 2 }))
    const contextMenuEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    element.dispatchEvent(contextMenuEvent)
    element.dispatchEvent(createPointerEvent('pointerup', { clientX: 90, clientY: 16, button: 2 }))
    element.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }))
    await flushPromises()

    // 菜单被拦掉、标签没被关、拖拽还在进行
    expect(contextMenuEvent.defaultPrevented).toBe(true)
    expect(requestDocumentCloseTab).not.toHaveBeenCalled()
    expect(tabBar.classes()).toContain('is-dragging')

    // 左键松开后仍然正常收尾
    element.dispatchEvent(createPointerEvent('pointerup', { clientX: 90, clientY: 16 }))
    await flushPromises()
    expect(tabBar.classes()).not.toContain('is-dragging')

    wrapper.unmount()
  })

  it('中键点击标签必须关闭该标签，且不能触发重排', async () => {
    const wrapper = mountTabBar()
    const tabBar = wrapper.get('[data-testid="document-tab-bar"]')
    const element = wrapper.get('[data-testid="document-tab-session-2"]').element

    element.dispatchEvent(createPointerEvent('pointerdown', { clientX: 150, clientY: 16, button: 1 }))
    element.dispatchEvent(createPointerEvent('pointermove', { clientX: 250, clientY: 16, button: 1 }))
    element.dispatchEvent(createPointerEvent('pointerup', { clientX: 250, clientY: 16, button: 1 }))
    element.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
    await flushPromises()

    // 对齐 Obsidian：中键是“关闭这个标签”的快捷手势
    expect(requestDocumentCloseTab).toHaveBeenCalledWith('session-2')
    // 中键不承担拖拽语义
    expect(requestDocumentReorderTabs).not.toHaveBeenCalled()
    expect(tabBar.classes()).not.toContain('is-dragging')

    wrapper.unmount()
  })

  it('中键按下必须阻止默认行为，避免进入自动滚动', async () => {
    const wrapper = mountTabBar()
    const element = wrapper.get('[data-testid="document-tab-session-1"]').element

    const middleDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 })
    element.dispatchEvent(middleDown)
    expect(middleDown.defaultPrevented).toBe(true)

    // 左键按下不能顺手被拦掉，否则拖拽与右键菜单都会被默认行为影响
    const leftDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
    element.dispatchEvent(leftDown)
    expect(leftDown.defaultPrevented).toBe(false)

    wrapper.unmount()
  })

  it('拖拽过程中中键不得关闭标签', async () => {
    const wrapper = mountTabBar()
    const { element } = await dragTab(wrapper, { fromIndex: 0, fromX: 50, toX: 90 })

    element.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
    await flushPromises()

    // 拖拽没结束前，用户表达的是“移动标签”，不是“关闭标签”
    expect(requestDocumentCloseTab).not.toHaveBeenCalled()

    element.dispatchEvent(createPointerEvent('pointerup', { clientX: 90, clientY: 16 }))
    await flushPromises()

    wrapper.unmount()
  })

  it('按下关闭按钮不得进入拖拽候选', async () => {
    const wrapper = mountTabBar()
    const { tabElements } = applyDragLayout(wrapper, { tabLeftList: [0, 109] })
    await nextTick()

    const closeButton = tabElements[0].querySelector('[data-testid="document-tab-close"]')
    closeButton.dispatchEvent(createPointerEvent('pointerdown', { clientX: 10, clientY: 16 }))
    closeButton.dispatchEvent(createPointerEvent('pointermove', { clientX: 200, clientY: 16 }))
    closeButton.dispatchEvent(createPointerEvent('pointerup', { clientX: 200, clientY: 16 }))
    await flushPromises()

    // 关闭按钮有自己的点击语义，按住它拖不应该变成重排
    expect(requestDocumentReorderTabs).not.toHaveBeenCalled()

    wrapper.unmount()
  })
})

describe('documentTabBar 双击空白处（已废弃新建标签）', () => {
  it('双击标签栏空白处不得再新建标签（空白区改为拖窗口/双击最大化）', async () => {
    const wrapper = mountTabBar()
    await nextTick()

    await wrapper.get('[data-testid="document-tab-scroller"]').trigger('dblclick')
    await flushPromises()

    expect(channelUtil.send).not.toHaveBeenCalledWith({ event: 'create-new' })

    wrapper.unmount()
  })

  it('双击标签本身不得新建标签，只保留激活语义', async () => {
    const wrapper = mountTabBar()
    await nextTick()

    // 双击标签时事件目标是标签，冒泡到滚动容器也不能算“点在空白处”
    await wrapper.get('[data-testid="document-tab-session-2"]').trigger('dblclick')
    await flushPromises()

    expect(channelUtil.send).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('双击关闭按钮不得新建标签', async () => {
    const wrapper = mountTabBar()
    await nextTick()

    const closeButton = wrapper.get('[data-testid="document-tab-session-1"] [data-testid="document-tab-close"]')
    await closeButton.trigger('dblclick')
    await flushPromises()

    expect(channelUtil.send).not.toHaveBeenCalled()

    wrapper.unmount()
  })
})

describe('documentTabBar 切换标签自动保存', () => {
  it('开启“切换标签时”自动保存时，必须先同步挂起正文再切标签', async () => {
    store.config = { autoSave: ['switch'] }
    const wrapper = mountTabBar()
    await nextTick()

    await wrapper.get('[data-testid="document-tab-session-2"]').trigger('click')
    await flushPromises()

    expect(requestCurrentWindowOpenPreparation).toHaveBeenCalledTimes(1)
    expect(requestDocumentActivateTab).toHaveBeenCalledWith('session-2', { autoSave: true })
    // flush 必须在切换之前完成，否则主进程会保存上一个版本
    expect(requestCurrentWindowOpenPreparation.mock.invocationCallOrder[0])
      .toBeLessThan(requestDocumentActivateTab.mock.invocationCallOrder[0])

    wrapper.unmount()
  })

  it('未开启自动保存时点击标签同样要先收敛正文', async () => {
    const wrapper = mountTabBar()
    await nextTick()

    await wrapper.get('[data-testid="document-tab-session-2"]').trigger('click')
    await flushPromises()

    // flush 是正确性：不收敛就切换会让主进程保存到旧正文。
    expect(requestCurrentWindowOpenPreparation).toHaveBeenCalledTimes(1)
    expect(requestDocumentActivateTab).toHaveBeenCalledWith('session-2', { autoSave: true })

    wrapper.unmount()
  })

  it('正文同步失败时必须传 autoSave: false，避免拿旧内容写盘', async () => {
    store.config = { autoSave: ['switch'] }
    requestCurrentWindowOpenPreparation.mockResolvedValueOnce({
      ok: false,
      reason: 'preparation-unavailable',
    })
    const wrapper = mountTabBar()
    await nextTick()

    await wrapper.get('[data-testid="document-tab-session-2"]').trigger('click')
    await flushPromises()

    expect(requestDocumentActivateTab).toHaveBeenCalledWith('session-2', { autoSave: false })

    wrapper.unmount()
  })
})

describe('documentTabBar 去掉滚动后不再补位移', () => {
  it('外部激活标签时不得再调用 scrollTo（容器不可滚，标签靠缩窄全部可见）', async () => {
    store.documentSessionSnapshot.activeSessionId = 'session-1'
    const wrapper = mountTabBar()
    await nextTick()

    const scroller = wrapper.get('[data-testid="document-tab-scroller"]').element
    // jsdom 不实现 scrollTo，挂一个探针看组件是否还会主动滚动
    scroller.scrollTo = vi.fn()

    store.documentSessionSnapshot.activeSessionId = 'session-2'
    await nextTick()
    await nextTick()

    expect(scroller.scrollTo).not.toHaveBeenCalled()

    wrapper.unmount()
  })
})

describe('documentTabBar 文件已被删除或移动', () => {
  it('缺失文件的标签必须带缺失标记与原因提示，并禁用“在资源管理器中显示”', () => {
    store.documentSessionSnapshot.tabs = [
      { ...defaultTabs[0], fileMissing: true },
      { ...defaultTabs[1], fileMissing: false },
    ]
    const wrapper = mountTabBar()

    // 删除线与弱化完全由 data-file-missing 驱动，测试只关心属性是否落到 DOM 上
    const missingTab = wrapper.get('[data-testid="document-tab-session-1"]')
    expect(missingTab.attributes('data-file-missing')).toBe('true')
    expect(missingTab.attributes('title')).toBe('documentTab.fileDeletedOrMoved')

    // 正常标签的 title 就是文件名，顺带承担“长文件名被截断后看全名”的作用
    const aliveTab = wrapper.get('[data-testid="document-tab-session-2"]')
    expect(aliveTab.attributes('data-file-missing')).toBe('false')
    expect(aliveTab.attributes('title')).toBe('b.md')

    // 需要文件真实存在的动作必须置灰；
    // 复制路径只需要路径字符串，必须仍可用（用户靠它去找文件被搬去哪了）。
    const missingMenu = wrapper.findAll('.menu-stub')[0]
    expect(missingMenu.get('[data-menu-key="reveal-in-explorer"]').attributes('data-disabled')).toBe('true')
    expect(missingMenu.get('[data-menu-key="copy-path"]').attributes('data-disabled')).toBe('false')
    expect(missingMenu.get('[data-menu-key="move-to-new-window"]').attributes('data-disabled')).toBe('false')

    wrapper.unmount()
  })

  it('文件恢复后标签必须立即撤回缺失标记，不保留历史', async () => {
    store.documentSessionSnapshot.tabs = [{ ...defaultTabs[0], fileMissing: true }]
    const wrapper = mountTabBar()

    expect(wrapper.get('[data-testid="document-tab-session-1"]').attributes('data-file-missing')).toBe('true')

    // 模拟主进程重新对账后推送“文件又回来了”的快照
    store.documentSessionSnapshot.tabs = [{ ...defaultTabs[0], fileMissing: false }]
    await nextTick()

    const restoredTab = wrapper.get('[data-testid="document-tab-session-1"]')
    expect(restoredTab.attributes('data-file-missing')).toBe('false')
    expect(restoredTab.attributes('title')).toBe('a.md')
    expect(wrapper.get('.menu-stub [data-menu-key="reveal-in-explorer"]').attributes('data-disabled')).toBe('false')

    wrapper.unmount()
  })
})

describe('documentTabBar 外部变更未决', () => {
  it('未决标签必须带外部变更标记与待处理提示，且不与文件缺失混在一起', async () => {
    store.documentSessionSnapshot.tabs = [
      { ...defaultTabs[0], hasPendingExternalChange: true },
    ]
    const wrapper = mountTabBar()

    // 警示色由 data-external-change 驱动，测试只关心属性是否落到 DOM 上
    const tab = wrapper.get('[data-testid="document-tab-session-1"]')
    expect(tab.attributes('data-external-change')).toBe('true')
    expect(tab.attributes('data-file-missing')).toBe('false')
    expect(tab.attributes('title')).toBe('documentTab.externalChangePending')

    // 裁决完成后主进程会清空挂起项，标记必须跟着消失
    store.documentSessionSnapshot.tabs = [
      { ...defaultTabs[0], hasPendingExternalChange: false },
    ]
    await nextTick()

    const resolvedTab = wrapper.get('[data-testid="document-tab-session-1"]')
    expect(resolvedTab.attributes('data-external-change')).toBe('false')
    expect(resolvedTab.attributes('title')).toBe('a.md')

    wrapper.unmount()
  })

  it('同时存在删除与外部变更时，提示文案必须以文件缺失为准', () => {
    store.documentSessionSnapshot.tabs = [
      { ...defaultTabs[0], fileMissing: true, hasPendingExternalChange: true },
    ]
    const wrapper = mountTabBar()

    const tab = wrapper.get('[data-testid="document-tab-session-1"]')
    expect(tab.attributes('data-file-missing')).toBe('true')
    expect(tab.attributes('data-external-change')).toBe('true')
    expect(tab.attributes('title')).toBe('documentTab.fileDeletedOrMoved')

    wrapper.unmount()
  })
})

describe('documentTabBar 双击关闭标签', () => {
  it('双击标签必须关闭这个标签，且不能顺带新建', async () => {
    const wrapper = mountTabBar()
    await nextTick()

    const tab = wrapper.get('[data-testid="document-tab-session-1"]')
    await tab.trigger('dblclick')
    await flushPromises()

    expect(requestDocumentCloseTab).toHaveBeenCalledWith('session-1')
    // 双击落在标签上时，事件必须停在这里，不能冒泡成“空白处双击 = 新建标签”
    expect(channelUtil.send).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('双击空白处不再新建标签，也不会误关当前标签', async () => {
    const wrapper = mountTabBar()
    await nextTick()

    const scroller = wrapper.get('[data-testid="document-tab-scroller"]')
    await scroller.trigger('dblclick')
    await flushPromises()

    expect(channelUtil.send).not.toHaveBeenCalledWith({ event: 'create-new' })
    expect(requestDocumentCloseTab).not.toHaveBeenCalled()

    wrapper.unmount()
  })
})

describe('documentTabBar 拖到另一栏的标签条上', () => {
  /**
   * 让命中测试指向「另一栏的标签条」。
   *
   * jsdom 没有布局也没有 elementFromPoint，这里直接给出命中结果，
   * 只验证组件有没有把落点读成“跨栏搬家”。
   *
   * @param {string} paneGroupId 目标栏 id
   * @returns {() => void} 还原函数
   */
  function stubHitTest(paneGroupId) {
    const original = document.elementFromPoint
    const hitElement = { closest: () => ({ dataset: { paneGroupId } }) }
    document.elementFromPoint = () => hitElement
    return () => {
      document.elementFromPoint = original
    }
  }

  function applyBarLayout(wrapper) {
    const scroller = wrapper.get('[data-testid="document-tab-scroller"]').element
    Object.defineProperty(scroller, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        right: 400,
        bottom: 32,
        width: 400,
        height: 32,
      }),
    })
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 800 })
    scroller.scrollLeft = 0

    return defaultTabs.map((tab, index) => {
      const element = wrapper.get(`[data-testid="document-tab-${tab.sessionId}"]`).element
      Object.defineProperty(element, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          left: index * 109,
          top: 4,
          right: index * 109 + 100,
          bottom: 28,
          width: 100,
          height: 24,
        }),
      })
      return element
    })
  }

  it('在另一栏的标签条上松手必须把标签搬到那一栏，而不是重排本栏', async () => {
    const wrapper = mountTabBar()
    const tabElements = applyBarLayout(wrapper)
    await nextTick()

    const element = tabElements[0]
    element.dispatchEvent(createPointerEvent('pointerdown', { clientX: 50, clientY: 16 }))
    element.dispatchEvent(createPointerEvent('pointermove', { clientX: 56, clientY: 16 }))
    element.dispatchEvent(createPointerEvent('pointermove', { clientX: 300, clientY: 16 }))
    await new Promise(resolve => requestAnimationFrame(() => resolve()))

    // 松手位置仍在标签栏这一行的纵坐标上，区别只在于命中哪一栏的标签条
    const restore = stubHitTest('group-2')
    element.dispatchEvent(createPointerEvent('pointerup', { clientX: 300, clientY: 16 }))
    await flushPromises()
    restore()

    expect(requestDocumentMoveTabToGroup).toHaveBeenCalledWith('session-1', 'group-2')
    expect(requestDocumentReorderTabs).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('落在自己这一栏的标签条上仍然按重排处理', async () => {
    store.focusedGroupId = 'main'
    const wrapper = mountTabBar()
    const tabElements = applyBarLayout(wrapper)
    await nextTick()

    const element = tabElements[0]
    element.dispatchEvent(createPointerEvent('pointerdown', { clientX: 50, clientY: 16 }))
    element.dispatchEvent(createPointerEvent('pointermove', { clientX: 56, clientY: 16 }))
    element.dispatchEvent(createPointerEvent('pointermove', { clientX: 200, clientY: 16 }))
    await new Promise(resolve => requestAnimationFrame(() => resolve()))

    const restore = stubHitTest('main')
    element.dispatchEvent(createPointerEvent('pointerup', { clientX: 200, clientY: 16 }))
    await flushPromises()
    restore()
    delete store.focusedGroupId

    expect(requestDocumentMoveTabToGroup).not.toHaveBeenCalled()
    expect(requestDocumentReorderTabs).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })
})

describe('documentTabBar 空栏也必须渲染标签条', () => {
  // 回归：空栏原来整条 v-if 不渲染，连带 after-tabs 里的「+ 新建标签」按钮一起消失，
  // 导致拆出来的新栏永远填不上标签、也就永远拆不出第 4 栏。
  it('这一栏没有标签、但调用方给了 after-tabs 插槽时，标签条与 + 按钮都要渲染', async () => {
    store.documentSessionSnapshot = { activeSessionId: null, tabs: [] }
    store.getPaneGroupSnapshot = () => ({ activeSessionId: null, tabs: [] })

    const wrapper = mount(DocumentTabBar, {
      props: { groupId: 'group-empty' },
      slots: {
        'after-tabs': '<button data-testid="new-tab-probe">+</button>',
      },
      global: {
        stubs: {
          'a-dropdown': { template: '<div><slot /></div>' },
          'a-menu': { template: '<div />' },
        },
      },
    })
    await nextTick()

    expect(wrapper.find('[data-testid="document-tab-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="new-tab-probe"]').exists()).toBe(true)
  })

  it('没有标签、也没有 after-tabs 插槽时仍然不渲染（保持原有单栏行为）', async () => {
    store.documentSessionSnapshot = { activeSessionId: null, tabs: [] }
    store.getPaneGroupSnapshot = () => ({ activeSessionId: null, tabs: [] })

    const wrapper = mount(DocumentTabBar, {
      props: { groupId: null },
      global: {
        stubs: {
          'a-dropdown': { template: '<div><slot /></div>' },
          'a-menu': { template: '<div />' },
        },
      },
    })
    await nextTick()

    expect(wrapper.find('[data-testid="document-tab-bar"]').exists()).toBe(false)
  })
})
