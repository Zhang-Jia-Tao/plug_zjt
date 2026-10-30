# ai_manager_host — 本地 AI 应用图形化管理器（Chrome Native Messaging Host）

配合「可定制新标签页」扩展使用：扩展负责 UI，本 host 负责**本机侧**的检测与操作——浏览器沙箱内的扩展无法直接枚举进程、读会话文件或点弹窗，这些能力都在这里实现。

## 能力

| 功能 | 覆盖的应用 | 机制 |
|------|-----------|------|
| 运行状态检测 | Claude Code / ChatGPT 桌面版（Codex）/ Ollama / LM Studio / llama.cpp / vLLM / LocalAI / KoboldCpp / GPT4All / Jan / AnythingLLM / text-generation-webui / Cherry Studio / Chatbox / Claude 桌面版 / Cursor | 进程枚举（CIM）+ 本地 HTTP API 探测 |
| 模型信息 | Ollama / LM Studio / llama.cpp / vLLM / LocalAI / KoboldCpp / GPT4All / Jan / text-generation-webui | 解析 `/v1/models`、`/api/tags`、`/api/v1/model` 等返回，显示首个模型 + 数量 |
| 实时消息 | Claude Code / Codex | tail `~/.claude/projects/**/*.jsonl`、`~/.codex/sessions/**/*.jsonl`（1.5s 轮询） |
| 任务完成检测 | Claude Code / Codex | 日志完成事件 → 会话状态机 `done` |
| 会话统计 | Claude Code / Codex | 按会话文件聚合项目、模型、输入/缓存读/输出 token、轮次、最近请求 |
| 弹窗确认/否认 | 白名单进程（claude/lms/ollama/lm-studio/chatgpt/cursor）的 `#32770` 模态对话框 | PowerShell UIA 枚举 + Invoke 遥控点击 |
| 系统资源 | 本机 Windows | `sysmon.ps1`：CPU/内存/交换/磁盘/温度/GPU/显存 |

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
- **读取范围最小化**：只 tail Claude/Codex 的会话目录；不遍历用户其他文件。
- **本地 HTTP 探测只连 localhost**：新增应用只访问清单里的 `127.0.0.1` 端口，不接受任意 URL/命令。
- **端口冲突保护**：8080/5000 这类共用端口默认只在对应进程存在时探测，避免把别的服务误判成某个 AI。
- **网页 AI 只读状态**：`content-webai.js` 仅在 AI 域名运行，只上报 host/status/title/active，不读取聊天正文、不 hook 网络请求。

## 消息协议

Native Messaging 帧格式：4 字节小端长度前缀 + UTF-8 JSON。

| 方向 | 上限 |
|------|------|
| host → 扩展 | 单条 ≤ **1 MB**（Chrome 限制） |
| 扩展 → host | 单条 ≤ **64 KB**（Chrome 限制） |

host 侧另有 **512 KB 快照预算**：`snapshot` 的消息回放按预算从新到旧装入，避免超 1 MB 被杀连接。

### host → 扩展事件

```json
{ "type": "host:ready" }
{ "type": "apps", "apps": [ { "id": "claude-code", "name": "Claude Code", "status": "tasking", "detail": "会话日志 ~/.claude/projects" } ] }
{ "type": "message", "app": "claude-code", "role": "assistant", "text": "...", "ts": "...", "done": false }
{ "type": "session", "sessions": [ { "app": "codex", "id": "...", "project": "plug_zjt", "model": "gpt-5", "sumIn": 123, "sumCacheRead": 45, "sumOut": 67, "turns": 3, "lastTs": "..." } ] }
{ "type": "dialog", "id": 12345, "app": "lms", "title": "确认覆盖?", "buttons": [ { "id": "确定", "label": "确定" } ] }
{ "type": "dialog:closed", "id": 12345 }
{ "type": "sys", "metrics": { "cpu": 12.3, "mem": 45.6, "gpu": 3.0, "vramUsed": 0.8, "vramTotal": 8.0 } }
{ "type": "snapshot", "apps": [], "dialogs": [], "messages": [], "sessions": [] }
{ "type": "error", "message": "..." }
```

### 扩展 → host 命令

```json
{ "type": "query" }
{ "type": "sysmon", "fast": true }
{ "type": "dialog:respond", "dialogId": 12345, "buttonId": "确定" }
```

- `query`：返回 `snapshot`（应用/弹窗/最近消息/会话统计），若已有系统指标会补发一条 `sys`。
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
| 会话统计整文件重扫 | 最多 5s 一次 |
| 弹窗扫描 | 10s |
| 忙碌看门狗 | 30s |
| 系统指标 | 5s（页面可见）/ 15s（无页面订阅或后台） |

每轮系统指标都会拉起一次 PowerShell；页面切后台后自动降频是省 CPU 的关键。

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
