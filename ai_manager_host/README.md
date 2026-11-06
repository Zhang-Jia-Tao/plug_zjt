# ai_manager_host — 本地 AI 应用图形化管理器（Chrome Native Messaging Host）

配合「可定制新标签页」扩展使用：扩展负责 UI，本 host 负责**本机侧**的检测与操作——浏览器沙箱内的扩展无法直接枚举进程、读会话文件或点弹窗，这些能力都在这里实现。

## 能力

| 功能 | 覆盖的应用 | 机制 |
|------|-----------|------|
| 运行状态检测 | Claude Code / ChatGPT 桌面版（Codex）/ DeepSeek Harness / Ollama / LM Studio / llama.cpp / vLLM / LocalAI / KoboldCpp / GPT4All / Jan / AnythingLLM / text-generation-webui / Cherry Studio / Chatbox / Claude 桌面版 / Cursor | 进程枚举（CIM）+ 本地 HTTP API 探测 |
| 模型信息 | Ollama / LM Studio / llama.cpp / vLLM / LocalAI / KoboldCpp / GPT4All / Jan / text-generation-webui | 解析 `/v1/models`、`/api/tags`、`/api/v1/model` 等返回，显示首个模型 + 数量 |
| 实时消息 | Claude Code / Codex | tail `~/.claude/projects/**/*.jsonl`、`~/.codex/sessions/**/*.jsonl`（1.5s 轮询） |
| 任务生命周期 | Claude Code / Codex / DeepSeek Harness | 开始、阶段、tool_use/tool_result、完成/失败、等待确认、token 增量；DSH 逐帧解码 `session*.jsonl.zstd` |
| 任务完成检测 | Claude Code / Codex / DeepSeek Harness | 明确的 result/turn-end/task_complete 优先；Claude 没有 result 时只在 5 分钟无输出后结束，不伪造完成 |
| 会话统计 | Claude Code / Codex / DeepSeek Harness | 项目、模型、输入/缓存读/输出 token、轮次、最近请求；DSH 从 `assistant/message.usage` 取增量 |
| 弹窗确认/否认 | 白名单进程（claude/lms/ollama/lm-studio/chatgpt/cursor）的 `#32770` 模态对话框 | PowerShell UIA 枚举 + Invoke 遥控点击 |
| 系统资源 | 本机 Windows | `sysmon.ps1`：CPU/内存/交换/磁盘/温度/GPU/显存 |
| Java 终极笔记 · 学习台 | Java 终极笔记（Astro 4321 + 批注 4400） | 端口/进程探测、一键启动/停止/重启/构建、日志、备份、学习数据快照 |

> 网页端 AI（ChatGPT / Claude / Gemini / DeepSeek / Kimi / Perplexity / Grok / Copilot）的打开/生成中状态由扩展的 `content-webai.js` + SW 聚合，不经过本 host，因此 host 未安装时也能显示。网页端不提供 token/费用统计。

## 安装（一次性）

```bat
cd ai_manager_host
install-host.bat <新标签页扩展ID>
```

扩展 ID 在 `chrome://extensions` 的「可定制新标签页」卡片上查看（开启开发者模式）。
安装脚本做三件事：

1. 生成机器本地清单 `com.zjt.ai_manager.local.json`（含本机绝对路径，已 gitignore）；
2. 写 Chrome 的 `HKCU\Software\Google\Chrome\NativeMessagingHosts\ai_manager_host`；
3. 同时写 Edge 的 `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\ai_manager_host`（免管理员）。

之后刷新扩展，打开新标签页即可使用右栏 AI 管理器与左栏系统监视。

> 版本库里的 `com.zjt.ai_manager.json` 是可移植模板（路径为 `<HOST_DIR>` 占位），不要手工注册它。
> 换机器/换目录后重新执行安装脚本即可，清单会按当前路径生成。

卸载注册：

```bat
uninstall-host.bat
```

## 安全边界

- **只接受指定扩展**：host 清单的 `allowed_origins` 只允许新标签页扩展 ID，网页/其他扩展无法连接。
- **UIA 白名单硬编码**：只对 claude / lms / ollama / lm-studio / chatgpt / cursor 进程的弹窗生效，
  绝不监听/点击其他应用的窗口。
- **点击必须人工触发**：host 从不自动点弹窗，只有用户在扩展 UI 上点「确认/否认」后才遥控按钮，
  且按 `dialogId`（窗口句柄）精确配对。
- **内容本机闭环**：会话日志、进程、系统指标只在本机扩展 ↔ host 间传输，不上传远端。
- **读取范围最小化**：只读取 Claude/Codex/DeepSeek Harness 的会话目录；DSH 只解析会话文件里的任务/usage/tool 事件，不读取或上传对话正文到远端，也不遍历用户其他文件。
- **本地 HTTP 探测只连 localhost**：新增应用只访问清单里的 `127.0.0.1` 端口，不接受任意 URL/命令。
- **端口冲突保护**：8080/5000 这类共用端口默认只在对应进程存在时探测，避免把别的服务误判成某个 AI。
- **网页 AI 只读状态**：`content-webai.js` 仅在 AI 域名运行，只上报 host/status/title/active，不读取聊天正文、不 hook 网络请求。
- **项目监管只操作 Java 终极笔记目录**：组件可以配置启动目录，host 只接受绝对路径（支持 `%USERPROFILE%`/`~`），命令白名单仍固定为 start/stop/restart/build/backup/logs；扩展不能传任意命令，host 也不会按端口杀进程。
- **不按端口杀进程**：启动前发现 4321/4400 被其他程序占用会拒绝启动；停止前用进程命令行确认 node 进程属于该项目，避免误杀其他服务。
- **学习数据本机闭环**：usage/review/annotations 只从本机 4400 或 `site/server-data` 读取，不上传远端。

## Java 终极笔记 · 学习台

扩展的 `javaNotes` 2×1 组件通过 host 管理本地站点：

- 默认项目根目录：`%USERPROFILE%\IdeaProjects\Java终极笔记`（可被组件配置或 `JAVA_NOTES_ROOT` 覆盖）
- 组件设置「启动目录」后，通过 `project:watch` / `project:command` 的 `root` 字段传给 host；留空使用默认目录，支持 `%USERPROFILE%`、`~` 和引号，相对路径会被拒绝
- host 启动时仍可用环境变量 `JAVA_NOTES_ROOT` 覆盖默认值
- 端口归属按该目录 `.run/pids.json` 的 PID 判断；切换到另一个目录后，原目录的 4321/4400 会被显示为端口冲突，而不是误认成新目录的服务
- 4321：Astro dev / preview；4400：批注与统计服务
- 学习数据优先走 4400 的 `/api/usage/summary`、`/api/review/log`、`/api/anno/all`；
  服务离线时回退到 `site/server-data/*.json` 快照，并在 UI 标记为「本地文件快照」
- 状态事件 `project:state`，命令结果 `project:result`；具体字段见 `project-supervisor.mjs`

## 消息协议

Native Messaging 帧格式：4 字节小端长度前缀 + UTF-8 JSON。

| 方向 | 上限 |
|------|------|
| host → 扩展 | 单条 ≤ **1 MB**（Chrome 限制） |
| 扩展 → host | 单条 ≤ **64 KB**（Chrome 限制） |

host 侧另有 **512 KB 快照预算**：`snapshot` 只带回最近 30 秒的消息，按预算从新到旧装入，避免超 1 MB 被杀连接；历史日志不会在页面打开时重放成「生成中」。

### host → 扩展事件

```json
{ "type": "host:ready" }
{ "type": "apps", "apps": [ { "id": "claude-code", "name": "Claude Code", "status": "tasking", "detail": "会话日志 ~/.claude/projects" } ] }
{ "type": "message", "app": "claude-code", "role": "assistant", "text": "...", "ts": "...", "done": false }
{ "type": "session", "sessions": [ { "app": "codex", "id": "...", "project": "plug_zjt", "model": "gpt-5", "sumIn": 123, "sumCacheRead": 45, "sumOut": 67, "turns": 3, "lastTs": "..." } ] }
{ "type": "tasks", "active": [ { "key": "dsh:session-...", "phase": "tool_running", "project": "plug_zjt", "action": { "name": "pwsh", "status": "running" }, "turn": { "input": 123, "cacheRead": 456, "output": 78 }, "blocked": null } ], "recent": [] }
{ "type": "dialog", "id": 12345, "app": "lms", "title": "确认覆盖?", "buttons": [ { "id": "确定", "label": "确定" } ] }
{ "type": "dialog:closed", "id": 12345 }
{ "type": "sys", "metrics": { "cpu": 12.3, "mem": 45.6, "gpu": 3.0, "vramUsed": 0.8, "vramTotal": 8.0 } }
{ "type": "snapshot", "apps": [], "dialogs": [], "messages": [], "sessions": [], "tasks": { "active": [], "recent": [] }, "javaNotes": { "state": "running_full" } }
{ "type": "project:state", "project": "java-notes", "state": { "root": "C:\\...\\Java终极笔记", "defaultRoot": "C:\\Users\\...\\Java终极笔记", "state": "running_site_only", "site": {}, "anno": {}, "learning": {} } }
{ "type": "project:result", "requestId": "uuid", "ok": true, "state": {}, "message": "正在启动站点…" }
{ "type": "error", "message": "..." }
```

### 扩展 → host 命令

```json
{ "type": "query" }
{ "type": "sysmon", "fast": true }
{ "type": "dialog:respond", "dialogId": 12345, "buttonId": "确定" }
{ "type": "project:watch", "watch": true, "root": "D:\\code\\Java终极笔记" }
{ "type": "project:command", "requestId": "uuid", "root": "D:\\code\\Java终极笔记", "command": "start", "payload": { "withAnno": true } }
```

- `project:watch` / `project:command` 的可选 `root` 为启动目录；省略时沿用当前目录，空字符串表示回到默认目录。host 会把 `root` 归一化为绝对路径，非法路径返回 `invalid_root`。
- `project:command` 白名单：`start` / `stop` / `restart` / `build` / `backup` / `logs` / `refresh`。
  命令立即返回 `project:result`，启动/构建的后续状态由 `project:state` 推送。

- `query`：返回 `snapshot`（应用/弹窗/最近 30 秒消息/会话统计/实时任务），若已有系统指标会补发一条 `sys`。
- `sysmon`：切换系统指标轮询频率（`fast:true` → 5s，`false` → 15s）。页面全部断开时扩展会发 `fast:false`。
- `dialog:respond`：仅点击白名单进程中、与 `dialogId` 匹配的按钮。

> 网页 AI 的 `webai` 事件由扩展 SW 生成，不属于 host 协议；数据结构为
> `{type:'webai', apps:[{id,name,status,active,tabId,title,detail,color,short}]}`。

## 轮询节奏

| 任务 | 间隔 |
|------|------|
| 进程扫描 + 本地 HTTP 探测 | 8s（HTTP 并行，单个 1.2s 超时，重叠轮次会被跳过） |
| Claude 会话日志 | 1.5s |
| Codex 会话日志 | 1.5s |
| DeepSeek Harness 会话文件增长 | 1.5s（增量读取并按 zstd 帧边界解码） |
| 会话统计整文件重扫 | 最多 5s 一次 |
| 弹窗扫描 | 10s |
| 忙碌看门狗 | 每 5s 检查；45s 无新日志自动回到 online |
| 系统指标 | 5s（页面可见）/ 15s（无页面订阅或后台） |
| Java 笔记项目状态 | 4s（学习台订阅）/ 15s（无订阅）；启动中 0.9s |

Claude Code / Codex 的 tasking 由启动后新增的 assistant/user 日志开启（thinking/tool_use 也算；user 行可能是工具结果）；首次发现会话文件先跳到文件末尾，同时看文件尾部 30s 内是否有活动，任务执行到一半启动 host 也不会漏。历史日志不回放。

DeepSeek Harness 的会话文件是「每个事件一个独立 Zstandard 帧」的 JSONL，`zstd-frames.mjs` 先按帧魔数/块头扫描边界，再逐帧解压（`zlib.zstdDecompressSync` 一次只能解第一帧）。启动时完整回放一次以填充最近任务；之后按字节偏移增量读取，未写完的尾帧留到下一轮。支持 `turn/start`、`turn/end`、`assistant/message.usage`、`tool/call`、`tool/result`、`approval/asked`、`approval/decided`。

任务阶段：`waiting_first_token` → `thinking` / `streaming` → `tool_running` → `waiting_user` → `done` / `failed` / `ended`。阻塞告警：15s 无首 token、30s 工具较慢、120s 工具可能卡住、90s 无新输出；等待确认时不会被自动完成。完成时冻结 `durationMs`，历史只保留最近 12 条。

每轮系统指标都会拉起一次 PowerShell；页面切后台后自动降频是省 CPU 的关键。

## DeepSeek Harness 接入评估

没有采用 DSH 的私有 API / 内部包调用：版本间不稳定，而且需要额外登录或 RPC 细节。当前选择直接读本地持久化文件，原因是：

- `session.vN.jsonl.zstd` 是多个独立 Zstandard frame 拼接，帧头可扫描，能按 frame 增量解码，不必一次解整文件；
- 事件里已有 `turn/start`、`turn/end`、`assistant/message.usage`、`tool/call`、`tool/result`、`approval/asked`、`approval/decided`，足以还原阶段、耗时、阻塞、token；
- 数据只在本机 host → 扩展之间传输，不额外联网，也不依赖 DSH 进程暴露端口。

代价是解析的是 DSH 的持久化格式，DSH 大版本改 schema 时需要更新 adapter；帧扫描失败时整轮跳过，不会崩溃或阻塞 UI。首次发现文件完整回放一次用于最近完成列表，之后只读新增字节；文件很大时首次会有一点启动成本。

## 系统指标字段

`sysmon.ps1` 输出（缺省为 `null`，面板显示 `--`）：

`cpu`、`mem`、`memUsed`、`memTotal`、`swap`、`swapUsed`、`swapTotal`、`disk`、
`diskRead`、`diskWrite`、`uptime`、`cpuTemp`、`gpu`、`gpuTemp`、`vramUsed`、`vramTotal`。

采集顺序：

- CPU/内存/交换/磁盘：`Win32_PerfFormattedData_*` / `Win32_OperatingSystem` / `Win32_PageFileUsage`；
- GPU：NVIDIA CIM → `nvidia-smi` → Intel/AMD `GPUEngine` 性能计数器；
- CPU 温度：`MSAcpi_ThermalZoneTemperature`（很多主板/虚拟机返回拒绝访问，此时为空）。

## 文件结构

```text
ai_manager_host/
├── host.mjs                 # 主程序：Native Messaging、轮询、会话聚合、快照
├── project-supervisor.mjs   # Java 笔记项目监管：端口/进程/启停/日志/备份/学习数据
├── probe.mjs                # HTTP 模型名提取 / detail 格式化（可单测）
├── sysmon.ps1               # 系统指标采集
├── dialogs.ps1              # UIA 枚举白名单进程弹窗
├── dialog-click.ps1         # 按窗口句柄/按钮点击
├── install-host.bat         # 生成机器本地清单 + 写 Chrome/Edge 注册表
├── uninstall-host.bat       # 删除 Chrome/Edge 注册与本地清单
├── run-host.bat             # 手动启动宿主
├── com.zjt.ai_manager.json  # 可移植模板（<HOST_DIR> 占位，不直接注册）
└── README.md
```

## 调试

```powershell
# 直接启动宿主（扩展未连接时也能看 host:ready）
node host.mjs

# 手动喂一条 query 帧（在另一个终端）
node -e "const b=Buffer.from(JSON.stringify({type:'query'}));const h=Buffer.alloc(4);h.writeUInt32LE(b.length);process.stdout.write(Buffer.concat([h,b]))"
```

> 手动喂帧时注意 stdout 是二进制帧，终端直接显示会乱码；更推荐看扩展面板或写一个 Node 小脚本解析。

## 已知限制

- 仅支持 Windows（CIM/WMI + UIA + PowerShell）。
- 在受限沙箱中运行 host 时，WMI 可能返回「拒绝访问」，CPU/GPU/温度为空；正常桌面 Chrome 启动的宿主不受此影响。
- 会话日志格式随 Claude Code / Codex 版本变化，适配器可能需要更新。
- 弹窗按钮的 UIA 名称/自动化 ID 依赖应用版本，白名单点击失败时先看 `dialogs.ps1` 输出。
- 进程扫描 8s 一次会持续拉起 PowerShell；如需进一步省电，可再降低频率或改为常驻 PowerShell 会话。
- 新增应用的端口/进程名按常见默认值硬编码；自定义端口或 Docker 部署暂未提供配置入口，可先按进程状态判断在线。
- 网页 AI 不在 host 覆盖范围内，由 `newtab/content-webai.js` 采集；它不提供 token/费用，站点 DOM 改版时可能退化为 online。
