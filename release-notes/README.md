# 发布说明目录

该目录用于存放每个版本对应的 GitHub Release 说明文件。

版本速查与回滚说明见仓库根目录的 [CHANGELOG.md](../CHANGELOG.md)。

## 命名规则

- 文件名必须与 `mdreader-electron/package.json` 中的 `version` 完全一致
- 文件扩展名统一使用 `.md`
- 示例：当前版本为 `1.0.0`，则说明文件应为 `release-notes/1.0.0.md`
- 已发布的说明文件不覆盖、不删除，回滚与追溯都依赖它

## 目录结构

- `release-notes/*.md` —— 本项目（mdreader）各版本的发布说明，版本号从 `1.0.0` 起算
- `release-notes/upstream/` —— 上游项目 wj-markdown-editor 的 2.15.1 → 3.1.1 发布说明，**仅作历史存档**，不参与本项目的发布流程

## 使用方式

### 手动发布

1. 修改 Electron 包版本号
2. 新增或更新对应版本的说明文件
3. 手动触发 `Build And Release Desktop` workflow

### 推送 tag 自动发布

1. 修改 Electron 包版本号（`mdreader-electron` 与 `mdreader-web` 同步）
2. 新增或更新对应版本的说明文件
3. 创建与版本号完全一致的 annotated tag，例如 `1.0.0`；tag 说明写一句话摘要，例如 `1.0.3 新增配置备份导入导出`
4. 推送该 tag 到远程仓库，workflow 会自动触发发布
5. 在根目录 `CHANGELOG.md` 的「版本速查」补一行

## 注意事项

- 如果 tag 名与包版本不一致，workflow 会直接失败
- 如果对应版本的说明文件不存在或内容为空，workflow 会直接失败
- 发布说明支持 GitHub Release 的 Markdown 渲染
- 回滚方式见 [CHANGELOG.md](../CHANGELOG.md) 的「怎么回滚」一节
