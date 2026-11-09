import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import postCssPxToRem from 'postcss-pxtorem'
import UnoCSS from 'unocss/vite'
import { AntDesignVueResolver } from 'unplugin-vue-components/resolvers'
import Components from 'unplugin-vue-components/vite'

import { defineConfig } from 'vite'

// 剥离 KaTeX 字体声明中的 woff/ttf 候选源：
// Electron 内置 Chromium 只使用 woff2，保留其他格式会让构建产物多拷贝约 817KB 永不加载的字体。
// 必须在 Vite 的 CSS 插件之前（enforce: 'pre'）改写源码，否则 url 已被登记为构建资产。
function stripKatexLegacyFonts() {
  return {
    name: 'strip-katex-legacy-fonts',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]node_modules[\\/]katex[\\/]/.test(id) || !id.includes('.css')) {
        return
      }
      // 仅当该字体声明提供了 woff2 候选源时才剥离 woff/ttf，避免误删唯一可用格式
      return code.replace(/src:([^;}]+)/g, (full, value) => {
        if (!value.includes('woff2')) {
          return full
        }
        return `src:${value.replace(/,\s*url\([^)]*\.(?:woff|ttf)\)\s*format\(["'](?:woff|truetype)["']\)/g, '')}`
      })
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  /**
   * 关闭 esbuild 转译。
   *
   * 这个仓库是纯 JS（没有 .ts/.tsx/.jsx），本来就不需要 esbuild 做语法降级。
   * 而 esbuild 0.27.3 在 Windows 上会在转译阶段创建临时文件、随后删不掉
   * （`[vite:esbuild-transpile] remove ... Temp\esbuild-xxx: Access is denied`），
   * 直接让 `vite build` 中断、产物是空的 —— 表现为「打包出来的应用一启动就报
   * 编辑器界面加载失败」。关掉它，构建走 rollup + 浏览器原生语法即可。
   */
  esbuild: false,
  base: './',
  plugins: [
    stripKatexLegacyFonts(),
    vue(),
    UnoCSS(),
    // 模板中的 <a-*> 组件按需自动导入；显式置空 dirs，避免自动导入项目内组件
    Components({
      dirs: [],
      resolvers: [AntDesignVueResolver({ importStyle: false })],
      dts: false,
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: '../mdreader-electron/web-dist',
    emptyOutDir: true,
    target: 'esnext',
    /**
     * minify 走 terser 而不是 esbuild —— esbuild 在这个 Windows 环境里删不掉
     * 自己的临时文件（见上面 `esbuild: false` 的说明），连压缩阶段一起跳过的话
     * 产物体积会从 6 MB 涨到 13 MB。
     */
    minify: 'terser',
    /**
     * 显式切 vendor chunk。
     *
     * 不加这一段时 vite 按引用关系自动合并，`markdownItDefault` 会把
     * markdown-it + highlight.js + KaTeX + ant 图标全塞进一个 chunk（实测 1.39 MB），
     * 既触发 500 kB 警告，也让「改一行业务代码」作废整包缓存。
     * 拆开之后每个第三方库独立缓存，业务代码改动只影响自己的 chunk。
     */
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return undefined
          }
          if (id.includes('highlight.js')) {
            return 'vendor-highlight'
          }
          if (id.includes('katex')) {
            return 'vendor-katex'
          }
          if (id.includes('mermaid')) {
            return 'vendor-mermaid'
          }
          if (id.includes('markdown-it') || id.includes('markdownit')) {
            return 'vendor-markdown-it'
          }
          if (id.includes('@ant-design') || id.includes('ant-design-vue')) {
            return 'vendor-antd'
          }
          if (id.includes('codemirror') || id.includes('@codemirror')) {
            return 'vendor-codemirror'
          }
          // 其余第三方库**不要**强行合并成一个 vendor：
          // 那样会把 mermaid 的依赖（cytoscape 等）和首屏库塞进同一个 chunk，
          // 反而让首页加载全部内容。交给 rollup 按引用关系自动拆分。
          return undefined
        },
      },
    },
  },
  css: {
    postcss: {
      plugins: [
        postCssPxToRem({
          rootValue: 16,
          propList: ['*'],
          selectorBlackList: ['grid-rows-', 'grid-cols', 'wj-scrollbar'],
        }),
      ],
    },
  },
  server: {
    port: 8080,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.vitest.test.js'],
    pool: 'threads',
  },
})
