# Ghost Downloader 插件（dsh-ghost-download）

让 DeepSeek Harness 智能体通过 Ghost Downloader 官方命令行工具 `ghd` 统一管理下载（添加 / 探测 / 查看 / 控制 / 等待 / 统计 / 体检）的 DSH 插件。它让「下载」这件事只有一个引擎，IDA 与桌面端共享同一个下载队列。

## 它提供什么

向智能体注册 **8 个工具**（全部走 `ghd` CLI，而非受限的 aria2 RPC）：

- `ghost_download`：提交一个或多个链接给 Ghost 下载（支持 http/https/ftp/magnet/ed2k、`.torrent` URL、HLS/DASH 清单）；默认提交后立即返回，`waitSeconds` 可同步等到完成。参数包括目标目录 `dir`、种子文件序号 `select`、重命名 `name`、请求头 `headers`、同名冲突策略 `conflict`（默认 `keep`）、`useGhostFolder`（忽略 `dir`、交给 Ghost 自己的分类规则）、`precheck`（提交前用 `ghd probe` 检查磁盘空间与同名文件，只报告不自动跳过）和 `waitSeconds`。
- `ghost_probe`：只预览链接、不建任务，返回解析出的文件名、大小与文件列表（种子可据此拿到 `select` 用的文件序号），带 5 分钟缓存；`fresh:true` 可强制忽略缓存重新探测。
- `ghost_tasks`：列出 Ghost 当前所有任务及其状态与进度，可按 `status` 过滤，或用 `limit` 限制返回条数（最新优先，省略则全部）。
- `ghost_task`：查看单个任务详情（状态、进度、文件、错误）。
- `ghost_control`：控制任务——`pause` 暂停、`start` 继续/启动、`retry` 重试（`ghd start` 的封装：可指定 `taskIds`，省略则重试所有 `failed` 任务）、`remove` 删除（`remove` 会删除该任务尚未完成的文件，可用设置关掉；`deleteFiles:true` 还会删除已产出的文件）。
- `ghost_wait`：阻塞等待给定任务停止运行（完成 / 失败 / 暂停 / 删除）后汇报最终状态；`timeoutSeconds` 默认为 **600 秒**、受 `waitLimitSeconds` 上限钳制。
- `ghost_stats`：聚合当前队列里可见任务的状态计数与总字节大小；Ghost 不保留下载历史，因此它只能汇总当前队列（`range` 参数仅作兼容收下，无法按时间过滤）。
- `ghost_doctor`：只读健康检查——`ghd` 可用性、实时 `ghd tasks`、对已知小文件的网络/证书探测、会话下载目录可写性，以及与 Ghost 自身 `UserConfig.json` 的交叉核对（下载目录与代理）；返回一组成员级 `{name, ok, detail, hint}`，无副作用。

此外它还有两个**非工具**能力：

- **侧边栏「Ghost 下载队列」面板**：在 Web 客户端右侧显示实时下载进度（每 5 秒轮询一份缓存 3 秒的队列快照），跟随 Ghost 桌面端同一队列。
- **Shell 下载拦截**：默认拒绝 `curl -o` / `curl -O` / `wget` 这类自己写文件的 shell 下载，并把模型引导到 `ghost_download`（可由 `blockShellDownloads` 关闭）。这是行为护栏，不是安全边界。

它带**设置页**，提供执行器路径、轮询间隔、协议白名单、等待上限、输出上限、以及 remove / 通知 / shell 拦截等开关。

## 安装（本地 bundle）

本插件以 `link:` 方式装进你的 profile（vendored 依赖必须随目录链接，见下方「已知限制」）。插件包自带的 `cordis.patch.yml` 内容为：

```yaml
- insert:
    - id: ghost-download
      name: '@local/dsh-ghost-download'
```

在 profile 的 `cordis.patch.yml` 里插入同样一条，即可把 `@local/dsh-ghost-download` 这一行挂到 Loader：

```yaml
- insert:
    - id: ghost-download
      name: '@local/dsh-ghost-download'
```

`id` 是 Loader 行 id，`name` 必须与 `package.json` 的 `name` 一致。装好后可在插件页用 `ghdPath` 指向 `ghd.exe`（默认依次探测 `GHOST_GHD` / `GHD_PATH` 环境变量、标准安装目录、最后交给 `PATH`）。

## 配置项

与 `index.js` 中的 `Config`（Schemastery schema）完全一致，共 12 项；全部为 `.volatile()`，保存后立即生效，无需重启插件：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 关闭后不注册任何 `ghost_*` 工具；其余设置保留。 |
| `ghdPath` | string | `""` | `ghd.exe` 路径；留空自动探测标准安装。 |
| `pollIntervalMs` | natural | `5000` | 后台完成轮询间隔（毫秒，最小 1000）。 |
| `blockShellDownloads` | boolean | `true` | 拒绝 `curl -o` / `curl -O` / `wget` 并引导改用 `ghost_download`。 |
| `maxUrlsPerCall` | natural | `50` | 一次 `ghost_download` 最多接受多少个链接（最小 1）。 |
| `waitLimitSeconds` | natural | `3600` | `ghost_download` / `ghost_wait` 同步等待的上限秒数（10–7200）。 |
| `watchLimitMinutes` | natural | `30` | 后台监视单个任务的时限（分钟，最小 1）。超过后停止轮询并通知会话。 |
| `maxOutputChars` | natural | `20000` | 成功结果回传给模型的上限（字符，最小 500）。 |
| `maxErrorChars` | natural | `2000` | 失败时附带原始输出的上限（字符，最小 200）。 |
| `allowedUrlSchemes` | string[] | `["http","https","ftp","magnet","ed2k"]` | 允许提交的协议白名单；不在列表里的链接会被直接拒绝（至少一个）。 |
| `controlRemoveEnabled` | boolean | `true` | 是否允许 `ghost_control` 的 `remove`。关闭后 `remove` 会从工具的参数枚举里消失；`remove` 会删除该任务尚未完成的文件。 |
| `noticeIncludePath` | boolean | `true` | 后台完成通知里是否附带下载文件的绝对路径。 |

## 已知限制 / 注意事项

- **必须安装 Ghost Downloader 的 `ghd` 命令行工具**（桌面端「设置 → 命令行工具」安装）；`ghd` 未找到时会在调用时给出明确提示。
- **vendored 依赖**：`node_modules/@deepseek-ai/schemastery` 与 `@deepseek-ai/cosmokit` 随包附带（见 `VENDORED.md`），只能用 `link:` 安装；`npm pack` / 仓库安装会丢掉 `node_modules` 导致配置表单失效。升级 DSH 后若 schemastery / cosmokit 版本变化，需从新安装的 `app.asar` 重新提取。
- 单次最多 50 个链接（Windows 命令行 32K 限制）；导出到模型的结果会被截断到 `maxOutputChars` / `maxErrorChars`。
- `ghost_download` **不传 `dir` 时会落到 `<会话工作目录>/downloads`**（让发起调用的智能体仍能读到文件）；传 `useGhostFolder:true` 则忽略 `dir`、交给 Ghost 自己的分类规则，文件可能落到工作区之外。
- 同名冲突 `conflict` 默认 `keep`（保留两份），传 `overwrite` 才覆盖；`precheck` 只是基于 `ghd probe` 的建议（blocked / skip / warn），**永不自动跳过下载**，是否继续由调用方决定。
- `ghost_probe` 结果缓存 5 分钟（按 URL + 合并后的 header 作键）；`fresh:true` 强制重探。header 值含 cookie/token，回显时会做脱敏，但会以命令行参数进入本机进程列表。
- 任务 id 形如 `tsk_0123`；`ghost_task` / `ghost_control` / `ghost_wait` 只接受这种格式的 id。
- 后台监视有上限：单任务 30 分钟、连续 CLI 失败 10 次或会话失联 3 次即停止，不会无限轮询。
- 工具超时是注册时按 schema 最大值推导的固定预算，调高 `waitLimitSeconds` 不会突破宿主截止时间；等待超时后未完成的任务转入后台监视并通知会话。`ghost_wait` 的 `timeoutSeconds` 默认 600 秒。
- `ghost_stats` 只能统计当前队列：Ghost 不保留下载历史，`range` 参数收下但无法真正按时间过滤。

## 安全说明（哪些操作有破坏性）

- **`ghost_control` 的 `remove` 会删除任务尚未完成的文件**——这是本插件最具破坏性的操作，可用 `controlRemoveEnabled:false` 彻底移除该动作；`deleteFiles:true` 还会删除它已经产出的文件。
- `ghost_download` 传 `conflict:"overwrite"` 会**覆盖同名已有文件**；默认 `keep` 保留两份。
- `headers` 里常含 cookie / token，值会进入 `ghd` 的命令行参数（本机其它进程可见）；插件在调用卡片与错误输出里做了脱敏，但仍应谨慎处理敏感头。
- `blockShellDownloads` 默认是行为护栏，只拦截明显写文件的 `curl -o` / `wget` 形态，不能当作阻止下载脚本的安全边界。
- `ghost_download` / `ghost_probe` 只接受 `allowedUrlSchemes` 白名单内的协议；收紧白名单可降低风险。
- `ghost_tasks` / `ghost_task` / `ghost_probe` / `ghost_stats` / `ghost_doctor` 是只读的（`isConcurrencySafe` 为 true）；`ghost_control retry` 会启动任务，不是只读。

## License

MIT © 2026 dafeiyu。详见 [LICENSE](LICENSE)。

---

**English summary:** A DeepSeek Harness plugin that drives Ghost Downloader through its official `ghd` CLI. It registers eight model tools — `ghost_download`, `ghost_probe`, `ghost_tasks`, `ghost_task`, `ghost_control`, `ghost_wait`, `ghost_stats`, and `ghost_doctor` — and adds a live download-queue sidebar plus a guard that redirects shell downloads. `ghost_control` gains a `retry` action; new download options include `useGhostFolder`, `precheck`, `conflict` (default keep), and `waitSeconds`; omits `dir` to save under `<session>/downloads`. Twelve volatile settings cover the executable path, protocol allow-list, wait/output limits, and safety toggles. It vendors Schemastery/Cosmokit for link installs and is licensed MIT.
