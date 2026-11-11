# 更新日志

mdreader 的版本速查表。每个版本的完整说明在 [`release-notes/<版本>.md`](release-notes/)，GitHub Releases 页面对应同名 tag。

## 版本速查

| 版本 | 发布日期 | 类型 | 一句话 | 安装包 |
| --- | --- | --- | --- | --- |
| 1.0.4 | 2026-11-11 | 修复 | 窗口四角补 DWM 圆角、边框不再被系统边框盖住、侧栏/大纲栏展开状态记忆、侧栏最小宽度与校验对齐、大纲栏横向滚动条、窗口大小/位置记忆、拖入文件接管空白标签、CRLF 文件不再假脏弹保存提示 | `mdreader-win32-x64-1.0.4.exe` |
| 1.0.3 | 2026-11-10 | 新增 | 设置页新增「配置备份」，可导出/导入应用设置 | `mdreader-win32-x64-1.0.3.exe` |
| 1.0.2 | 2026-11-10 | 修复 | 首次安装不再恢复上次会话的标签页与最近文件；Linux 自动更新指向本仓库 | `mdreader-win32-x64-1.0.2.exe` |
| 1.0.1 | 2026-11-09 | 修复 | 非最大化时四边边框完整且保留系统动画；拖文件浮层只显示文件名 | `mdreader-win32-x64-1.0.1.exe` |
| 1.0.0 | 2026-11-09 | 首个版本 | 从 wj-markdown-editor 3.1.1 分叉，完成品牌独立与首批缺陷修复 | `mdreader-win32-x64-1.0.0.exe` |

## 各版本改了什么

### 1.0.4 — 窗口圆角与状态记忆

- 窗口四角补上 DWM 原生圆角（`DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND`），圆角外侧不再露出方形窗口底色
- 侧栏、大纲栏的展开/收起状态改为切换即写盘（`sidebarDefaultView` / `outlineVisible`），下次启动按上次状态恢复
- `sidebarWidth` 校验下限 220 → 160，与界面最小宽度一致，不再出现「拖窄侧栏 → 配置内容无效」
- 大纲栏空态占位插画限制为不超容器宽度，去掉底部横向滚动条
- 窗口大小/位置与「是否最大化」记在独立的 `data/window-state.json`（不进 `config.json`，避免动配置结构），启动时校验可见性后恢复
- 拖入 md 文件时接管目标栏的空白标签（有未保存改动的标签不算空白，照旧新开）
- CRLF 换行的文件打开后不再被判为「已修改」，关闭时不再误弹保存提示，保存仍写回 CRLF
- `DWMWA_BORDER_COLOR = DWMWA_COLOR_NONE` 关掉系统自己那条 1px 边框，拖动/切换焦点后青色边框不再被盖住
- 相关实现：`mdreader-electron/src/util/windowStyleUtil.js`、`mdreader-electron/src/util/document-session/windowLifecycleService.js`、`mdreader-electron/src/util/document-session/lineEndingUtil.js`、`mdreader-electron/src/data/windowState.js`、`mdreader-electron/src/main.js`、`mdreader-web/src/util/layout/sidebarVisibilityPersistenceController.js`、`mdreader-web/src/util/document-session/documentDropOpenInPaneUtil.js`、`mdreader-web/src/util/file-manager/fileDragDropUtil.js`、`mdreader-web/src/stores/counter.js`、`mdreader-web/src/components/editor/MarkdownMenu.vue`、`mdreader-web/src/views/HomeView.vue`、`mdreader-web/src/components/layout/DocumentTabBar.vue`、`mdreader-web/src/components/editor/MarkdownEdit.vue`

### 1.0.3 — 配置备份

- 设置页新增第 7 个标签「配置备份」，含「导出到文件」「从文件导入」两个操作
- 导出内容为应用设置（含已保存的图床等密钥），**不含**最近文件、标签页状态、日志或任何笔记内容
- 导入会整体替换当前设置，导入前有二次确认
- 相关实现：`mdreader-electron/src/util/configBackupUtil.js`、配置变更新增 `replace` 操作类型

### 1.0.2 — 首启不再恢复旧会话

- 旧版数据迁移不再搬运标签页与最近文件，只迁移应用配置
- 对已经迁移过的安装做一次性清理：删掉遗留的标签页/最近文件记录（标记 `.migrated-session-state-cleared`，只执行一次）
- Linux 的 zsync 自动更新地址由上游仓库改为本仓库

### 1.0.1 — 窗口边框与拖拽浮层

- 用 `thickFrame: false` + 运行期补回 `WS_CAPTION`，让非最大化时四边边框完整，同时保留系统窗口动画
- 拖拽文件时用只含文件名的小块作为 drag image，不再显示内容缩略图
- 空白标签栏拖入文件不再分栏，直接顶替空标签

### 1.0.0 — 首个独立版本

- 更名 mdreader、全新图标、用户数据目录迁到 `%APPDATA%\mdreader`（带旧目录迁移）
- 标签宽度按内容自适应、分栏改为「目标栏一分为二」、支持最多 4 栏
- 修复拖入文件偶发无响应、空文档插图溢出等问题

## 怎么回滚

| 场景 | 做法 |
| --- | --- |
| 想退回旧的安装包 | 打开 [Releases](https://github.com/weiaisuyan/mdreader/releases)，按 tag 下载对应 `.exe`，直接覆盖安装 |
| 用户数据会不会丢 | 不会。用户数据在 `%APPDATA%\mdreader`，覆盖安装不清理；只有在卸载时勾选删除数据才会清掉 |
| 想退回源码 | `git checkout 1.0.2`（或任意 tag） |
| 自动更新会不会把旧版顶掉 | 不会。`latest.yml` 永远指向最新发布版，只有新版才会被推送；旧版不会自动降级 |

## 发版流程

1. 改 `mdreader-electron/package.json` 与 `mdreader-web/package.json` 的 `version`
2. 新增 `release-notes/<版本>.md`（文件名必须与版本号完全一致、不能为空）
3. 提交后打 annotated tag，tag 说明写一句话摘要，例如 `1.0.3 新增配置备份导入导出`
4. 推送 `main` 与 tag，CI 会校验版本一致性并构建四平台安装包
5. 在本文件顶部「版本速查」补一行

## 版本号规则

- 采用 `主.次.修订`：新增功能升次版本号，仅修缺陷升修订号
- 从 `1.0.0` 重新起算，与上游 wj-markdown-editor 的版本号不连续
- 历史版本说明永久保留在 `release-notes/`，不覆盖、不删除
