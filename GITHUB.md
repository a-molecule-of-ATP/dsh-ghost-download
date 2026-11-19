# 发布到 GitHub 的清单（dsh-ghost-download）

> 本文件只是发布操作说明。**准备阶段不执行其中任何命令**；确认无误后由维护者手动发布。

## 建议的远端仓库

- 仓库名：`dsh-ghost-download`
- 描述：`DeepSeek Harness plugin that drives Ghost Downloader via its official ghd CLI: add, probe, list, inspect, pause, resume, remove, and wait for downloads.`
- License：MIT
- 建议 topic：`deepseek-harness`、`dsh-plugin`、`ghost-downloader`、`download`

## 发布前要改的占位符

- `package.json` 的 `repository.url` / `bugs.url` / `homepage` 目前指向 `https://github.com/a-molecule-of-ATP/dsh-ghost-download.git`，确认 GitHub 用户名 `a-molecule-of-ATP` 与仓库名无误；若实际账号不同，全局替换 `a-molecule-of-ATP/dsh-ghost-download`。
- `LICENSE` 的版权行为 `Copyright (c) 2026 a-molecule-of-ATP`，确认年份与署名。
- `README.md` 安装段落里的 `name: '@local/dsh-ghost-download'` 与 `package.json` 的 `name` 必须一致（当前一致）。
- **确认 vendored 依赖会随仓库提交**：`VENDORED.md` 说明 `node_modules/@deepseek-ai/{schemastery,cosmokit}` 是运行必需，`.gitignore` 只忽略 `node_modules/.cache`，不会忽略这两个目录。`package.json` 的 `files` 数组未显式列出 `node_modules`（link 安装按整个目录工作），但 GitHub 仓库本身必须带上这两个目录，否则 clone 后无法使用。

## 发布命令（仅文档，勿在此阶段执行）

```bash
cd dsh-ghost-download
git add -A && git commit -m "chore: prepare dsh-ghost-download for GitHub release"
git remote add origin https://github.com/a-molecule-of-ATP/dsh-ghost-download.git
git push -u origin main
```

发布 tag：

```bash
git tag v0.2.0
git push origin v0.2.0
```

## 建议的 tag 名

- `v0.2.0`（与 `package.json` 的 `version` 一致）

## 发布后核对

- GitHub 仓库页面的 License 被识别为 MIT。
- `README.md` 渲染正常，6 个工具与 12 项配置齐全。
- 仓库包含 `node_modules/@deepseek-ai/{schemastery,cosmokit}`，用户 `link:` 安装后可正常使用设置页与侧边栏队列面板。
- `VENDORED.md` 中的版本与 DSH 安装里的 schemastery / cosmokit 对齐。
