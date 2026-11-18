# Ghost Downloader: hand your downloads to a dedicated queue

This plugin routes downloads in DeepSeek Harness through Ghost Downloader's official command-line tool `ghd`, so the agent and your desktop share one download queue.

> **Terminology**: below, "arguments" are values the agent passes on each tool call, such as `dir`, `conflict`, `headers`, `waitSeconds`, `precheck`, `useGhostFolder` — `dir` is an argument, not a user toggle. "Settings" are values you configure on the plugin page that apply across calls, such as `ghdPath`, `allowedUrlSchemes`, `controlRemoveEnabled`, `waitLimitSeconds` (a ceiling).

## What problem it solves

Letting an agent fetch files with `curl`/`wget` looks easy but causes real trouble: no progress to inspect, resume and retry logic you must build yourself, tasks scattered across sessions with no central view, and files that often land somewhere the agent cannot read. Ghost Downloader is built for exactly this — one unified queue, resume support, inspectable state, and completion notification. With this plugin the agent just says "download this link"; Ghost does the rest, and the result is reported back to the current session when the download ends.

Prerequisite: install the `ghd` tool from Ghost Downloader's "Settings → Command line tools"; you can also set `ghdPath` in this plugin's settings to point at another executable.

## The eight tools at a glance

| Tool | What it does | Key parameters |
| --- | --- | --- |
| `ghost_download` | Submit links (HTTP/HTTPS, FTP, magnet/BT, eD2k, HLS/DASH) | `urls` (required), `dir`, `waitSeconds`, `select`, `name`, `conflict` (keep/overwrite, default keep), `headers`, `useGhostFolder`, `precheck` |
| `ghost_probe` | Preview a link's name, size and torrent file indexes without downloading | `url` (required), `headers`, `fresh` |
| `ghost_tasks` | List currently visible tasks with status and progress | `status` (filter), `limit` (cap) |
| `ghost_task` | Inspect one task in detail, with failure attribution | `taskId` (required) |
| `ghost_control` | Pause, resume, retry or remove tasks | `action` (pause/start/retry/remove), `taskIds`, `deleteFiles` (delete produced files on remove) |
| `ghost_wait` | Wait synchronously for tasks and report their final state | `taskIds` (required), `timeoutSeconds` (default 600 s) |
| `ghost_stats` | Aggregate counts and total bytes of visible tasks by status | `range` (7d/30d/all, default 7d) |
| `ghost_doctor` | Read-only health check of ghd, network, folders and config | none |

## Where files land (the important part)

![The default landing folder and the two related arguments](landing.svg)

Both `dir` and `useGhostFolder` are **arguments the agent passes on each call**, not toggles the user sets on the plugin page.

**When `dir` is omitted, downloads land in a `downloads` folder inside the current session working directory.** This is the single most important fact to know: Ghost's own download folder sits outside the workspace, where the agent's file tools cannot reach it. Landing in the session directory means the agent can open, parse and process the file in the very next step.

Same-named files are kept by default (keep); overwriting requires an explicit `conflict: "overwrite"`.

```
<session working directory>/
├── downloads/              <- default landing folder (ghd -o)
│   ├── report.pdf
│   └── archive.zip
└── ... (the agent can read these files directly)
```

When to use `useGhostFolder: true`: when you want Ghost to file downloads by its own category rules and do not mind the files landing outside the workspace (for example, purely for the user to pick up in the desktop app). The trade-off is that the agent can no longer read them — pass `dir` when you need them back.

## Typical usage

Submit and return immediately; the task continues in the background and notifies you when done:

```json
{"urls": ["https://example.com/report.pdf"]}
```

Submit and wait up to 120 seconds (when the next step needs the file right away):

```json
{"urls": ["https://example.com/data.zip"], "waitSeconds": 120}
```

Precheck free space and same-named files before submitting (a report only, never an automatic skip):

```json
{"urls": ["https://example.com/big.iso"], "precheck": true}
```

A precheck is advice, never an automatic skip. It depends on `ghd probe` reporting a
file size — **when Ghost reports none, the space and same-name checks are labelled
"not checked" rather than treated as passing**. With `useGhostFolder` the
destination belongs to Ghost, so there is no target folder to precheck.

Retry every failed task (`retry` with no `taskIds` means all failed tasks):

```json
{"action": "retry"}
```

## Background watching and notification

![What happens after a submission](timing.svg)

By default a submission returns immediately with the task ids, and the plugin keeps watching those tasks in the background; when one finishes or fails, it proactively reports the result back to the session that started it — no polling needed. Watching is not infinite: if a single task is still running after `watchLimitMinutes` (a setting, default 30 minutes), the plugin stops watching and notifies the session; use `ghost_task` to check manually then. When you need the file on the spot, use `waitSeconds` or `ghost_wait` for a synchronous wait (`ghost_wait` defaults to at most 600 seconds).

## Safety and boundaries

- The plugin blocks shell downloads that bypass Ghost (`curl -o`, `curl -O`, `wget`) and redirects them to `ghost_download`.
- `allowedUrlSchemes` is a protocol allow-list, defaulting to http, https, ftp, magnet, ed2k; links outside the list are rejected outright.
- `ghost_control`'s `remove` deletes the task; with `deleteFiles: true` it also deletes the files that task already produced — a destructive operation. The `controlRemoveEnabled` setting can disable remove from the plugin page.
- `headers` end up in `ghd`'s command-line arguments and are visible in the local process list; do not put sensitive credentials there.

## Diagnostics

When downloads fail or tasks keep erroring, run `ghost_doctor` first: it checks `ghd --version`, `ghd tasks`, a network/certificate probe against a known small file, writability of the download folder, and Ghost's own `UserConfig.json` download folder and proxy settings. It never touches the download queue, but it is not side-effect free: it writes and immediately deletes a temporary probe file and makes one network request. `ghost_task` gives a hedged "possible cause" attribution for failures (certificate, DNS, auth, gone, range request, etc.).

`ghost_stats` only aggregates **currently visible** tasks: Ghost keeps no download history, so its `range` parameter (7d/30d/all) is a placeholder for API consistency and cannot actually filter by time — no ledger is invented.
