# Ghost Downloader 下载：把下载交给专业队列

这个插件把 DeepSeek Harness 里的下载任务，交给本机 Ghost Downloader 的官方命令行工具 `ghd` 执行，让智能体和桌面端共用同一个下载队列。

> **术语说明**：下文「参数」指智能体每次调用工具时传的值，例如 `dir`、`conflict`、`headers`、`waitSeconds`、`precheck`、`useGhostFolder`——`dir` 是参数，不是用户开关。「设置」指你在插件页配置、跨调用生效的值，例如 `ghdPath`、`allowedUrlSchemes`、`controlRemoveEnabled`、`waitLimitSeconds`（上限）。

## 它解决什么问题

让智能体自己用 `curl`/`wget` 拉文件，看似直接，实则麻烦多多：进度看不到、断点续传和失败重试要自己实现、任务散落在各个会话里无从管理、下载完的文件还常常落在智能体读不到的地方。Ghost Downloader 是专门干这件事的工具——统一队列、断点续传、状态可查、完成后可通知。本插件让智能体只需说一句「下载这个链接」，剩下的交给 Ghost，并在下载结束时把结果送回当前会话。

前提：先在 Ghost Downloader 的「设置 → 命令行工具」安装 `ghd`；也可在本插件的设置里用 `ghdPath` 指定可执行文件路径。

## 八个工具一览

| 工具 | 干什么 | 关键参数 |
| --- | --- | --- |
| `ghost_download` | 提交下载链接（HTTP/HTTPS、FTP、磁力/BT、eD2k、HLS/DASH） | `urls`（必填）、`dir`、`waitSeconds`、`select`、`name`、`conflict`（keep/overwrite，默认 keep）、`headers`、`useGhostFolder`、`precheck` |
| `ghost_probe` | 预览链接的文件名、大小与种子文件索引，不真正下载 | `url`（必填）、`headers`、`fresh` |
| `ghost_tasks` | 列出当前可见任务及状态、进度 | `status`（按状态过滤）、`limit`（限量） |
| `ghost_task` | 查看单个任务的详情，并给出失败归因 | `taskId`（必填） |
| `ghost_control` | 暂停、继续、重试或移除任务 | `action`（pause/start/retry/remove）、`taskIds`、`deleteFiles`（remove 时删除已产生的文件） |
| `ghost_wait` | 同步等待任务结束并回报最终状态，可选做完整性校验 | `taskIds`（必填）、`timeoutSeconds`（默认 600 秒）、`checksum`（校验和，要求只传一个 taskId） |
| `ghost_stats` | 按状态汇总当前可见任务的数量与总字节数 | `range`（7d/30d/all，默认 7d） |
| `ghost_doctor` | 只读体检 ghd、网络、目录与配置 | 无参数 |

## 文件落在哪里（最重要）

![默认落点与相关参数](landing.zh.svg)

`dir` 与 `useGhostFolder` 都是**智能体每次调用时传的参数**，不是用户在插件页配的开关。

**不传 `dir` 时，下载默认落到当前会话工作目录的 `downloads` 文件夹。** 这是最影响使用的一点：Ghost 自己的下载目录在工作区之外，智能体的文件工具读不到；落到会话目录里，智能体才能在下一步直接打开、解析、处理刚下载的文件。

同名文件默认保留（keep），需要覆写时要显式传 `conflict: "overwrite"`。

```
<会话工作目录>/
├── downloads/              ← 默认落点（ghd -o）
│   ├── report.pdf
│   └── archive.zip
└── ...（智能体可直接读取这些文件）
```

什么时候用 `useGhostFolder: true`：当你希望按 Ghost 自己的分类规则归档、不介意文件落在工作区之外（例如纯粹让用户自己在桌面端取用）时，用它跳过 `dir`。**两个同时传时以 `useGhostFolder` 为准，`dir` 会被忽略。** 代价是智能体此后读不到文件；需要读回时请传 `dir`。

## 典型用法

提交并立即返回，任务在后台继续，完成后自动通知：

```json
{"urls": ["https://example.com/report.pdf"]}
```

提交并同步等待最多 120 秒（适合下一步立刻要用文件）：

```json
{"urls": ["https://example.com/data.zip"], "waitSeconds": 120}
```

提交前预检目标目录空间与同名文件（只报告，不会自动跳过）：

```json
{"urls": ["https://example.com/big.iso"], "precheck": true}
```

预检只是建议，不会自动跳过。它依赖 `ghd probe` 返回文件尺寸——**若 ghd 没给出尺寸，空间与同名判定会被标注成「未检查」而不是当成通过**。传 `useGhostFolder` 时落点由 Ghost 决定，本次无法预检目标目录。

失败后重试全部 failed 任务（`retry` 不传 `taskIds` 时表示所有失败任务）：

```json
{"action": "retry"}
```

下载完成后校验完整性（`checksum` 要求**只传一个 `taskId`**，传多个会直接报错）：

```json
{"taskIds": ["tsk_0123"], "timeoutSeconds": 300, "checksum": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"}
```

`checksum` 也可以只给裸十六进制摘要，插件按长度识别算法（32=md5、40=sha1、64=sha256、128=sha512）。`ghd` 本身没有任何校验和功能，所以摘要由插件在文件落盘后自行流式计算，不会把大文件读进内存。三种结果：

- 匹配 → 结果里带「校验通过：`<算法> <摘要>`」；
- 不匹配 → `ok:false`，`error.code = "checksumMismatch"`，并列出期望值与实际值；
- 定位不到落地文件 → `error.code = "checksumNotVerified"`。

## 后台与通知

![提交之后发生什么](timing.zh.svg)

默认提交后立即返回任务 id，插件会在后台持续监视这些任务；当任务结束或失败时，主动把结果送回发起下载的会话，无需智能体反复轮询。监视不是无限期的：单个任务超过 `watchLimitMinutes`（设置，默认 30 分钟）仍未结束，插件会停止监视并通知会话，此时可用 `ghost_task` 手动查看。需要当场拿到文件时，用 `waitSeconds` 或 `ghost_wait` 同步等待（`ghost_wait` 默认最多 600 秒）。

## 安全与边界

- 插件会拦截 `curl -o` / `curl -O` / `wget` 这类绕过 Ghost 的 shell 下载，并引导改用 `ghost_download`。
- `allowedUrlSchemes` 是协议白名单，默认允许 http、https、ftp、magnet、ed2k；不在名单里的链接直接拒绝。
- `ghost_control` 的 `remove` 会移除任务，并删掉它**尚未完成**的文件；只有再加 `deleteFiles: true` 才会连已完成文件一起删。可用 `controlRemoveEnabled` 设置在插件页关闭 remove。
- `headers` 会进入 `ghd` 的命令行参数，本机进程列表可见；不要把敏感凭据写在这里。

## 与同类的差异

先交代这份对比的可信度，别把调研当成定论：

- **已亲自抓官方文档核实**：Mister Download Manager（MDM）的工具清单、协议支持、校验和算法、自动化 API 的默认状态。
- **代理转述、未逐条复核**：aria2 / qBittorrent / Transmission / yt-dlp 的 MCP 包装现状、MCP 长任务的阻塞与较新的 Tasks 扩展、以及「无预检把系统盘写满」的 issue。
- 「抽样范围内没找到第二家」只代表这次调研没找到，**不等于业界没有**。

最对口的同类是 **MDM**：自带 MCP server，7 个工具（`list` / `add` / `pause` / `resume` / `remove` / `start_queue` / `stop_queue`），支持 http/https/ftp/ftps，支持 5 种校验和（MD5 / SHA-1 / SHA-256 / SHA-512 / CRC32），但**自动化 API 默认关闭、需手动开启**（以上经官方文档核实）。

我们的差异：

1. **8 个工具闭环**。相比 MDM 的 7 个，多出 `probe`（不建任务先看文件名与大小）、`wait`（同步等到结束）、`stats`（按状态汇总队列）、`doctor`（只读体检）。MDM 的 `start_queue` / `stop_queue` 我们没有对应的整体队列开关。
2. **协议覆盖更宽**：除 http/https/ftp 外还支持 `magnet`、`ed2k`、`.torrent` URL、HLS、DASH 清单；MDM 是 http/https/ftp/ftps。
3. **默认落点绑会话工作目录**。不传 `dir` 时落到 `<会话工作目录>/downloads`，目的就是「智能体下完还能读回」——**本次抽样范围内没有看到第二家这么做**。
4. **预检只报告、不自动跳过**。`precheck` 给 blocked / skip / warn 的建议，决策权留给智能体。调研转述提到有项目因缺少预检把系统盘写满；我们选择报告而不代替决策，但这并不保证空间一定够。
5. **同步 / 异步双模式**。默认立刻返回任务 id 并在后台监视、结束时主动通知；需要当场拿文件时用 `waitSeconds` 或 `ghost_wait` 同步等。调研转述称 MCP 的 tool 默认同步阻塞、长任务要靠 Tasks 扩展轮询与取消——若该转述成立，这一点上我们的调用方负担更轻。
6. **校验和已补上，与 MDM 基本持平**：`checksum` 支持 md5 / sha1 / sha256 / sha512 共 **4 种**，MDM 是 5 种（多一个 CRC32）。**这项我们少一种，如实记录。**

也必须诚实写出我们比 MDM 松的地方：

- **MDM 的 magnet 会弹出「Add torrent」强制人工选文件**；本插件的智能体可以全自动提交 magnet 并用 `select` 自选文件。**我们的自动化程度更高，安全边界更松**。需要人工把关时，用 `controlRemoveEnabled`、`allowedUrlSchemes` 收紧，或在流程层要求人工确认。

## 诊断

下载不通、任务总是失败时，先跑 `ghost_doctor`：它检查 `ghd --version`、`ghd tasks`、一个已知小文件的网络/证书探测、下载目录是否可写，以及 Ghost 自己的 `UserConfig.json` 里的下载目录与代理设置。**它不碰下载队列**，但并非零副作用——会在下载目录写入并立即删除一个临时探测文件，并对外发起一次网络请求。`ghost_task` 会对失败原因给出「可能原因」式的归因（证书、DNS、鉴权、资源不存在、范围请求等）。

`ghost_stats` 只统计**当前可见**的任务：Ghost 不保留下载历史，它的 `range` 参数（7d/30d/all）只是接口一致的占位，并不能真的按时间过滤，也不会伪造一份账本。
