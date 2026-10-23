# ai_manager_host — 本地 AI 应用图形化管理器（Chrome Native Messaging Host）

配合「可定制新标签页」扩展使用：扩展负责左栏 UI，本 host 负责**本机侧**的检测与操作——
浏览器沙箱内的扩展无法直接枚举进程/读文件/点弹窗，一切本机能力都在这里实现。

## 能力

| 功能 | 覆盖的应用 | 机制 |
|------|-----------|------|
| 运行状态检测 | Claude Code / Ollama / LM Studio / Claude 桌面版 / ChatGPT 桌面版 | 进程枚举（wmic）+ 本地 HTTP API 探测 |
| 实时消息 | Claude Code | tail `~/.claude/projects/**/*.jsonl` 会话日志（1.2s 轮询） |
| 任务完成检测 | Claude Code | 日志 `type:"result"` 行 → done 事件 |
| 弹窗确认/否认 | 白名单进程（claude/lms/ollama/lm-studio/chatgpt/cursor）的 `#32770` 模态对话框 | PowerShell UIA 枚举 + Invoke 遥控点击 |

## 安装（一次性）

```bat
cd C:\Users\zhangjiatao6\IdeaProjects\plug_zjt\ai_manager_host
install-host.bat <扩展ID>
```

扩展 ID 在 `chrome://extensions` 的「可定制新标签页」卡片上查看（开启开发者模式）。
安装脚本做两件事：

1. 生成 `com.zjt.ai_manager.json` host 清单（`allowed_origins` 锁定你的扩展 ID）
2. 写 `HKCU\Software\Google\Chrome\NativeMessagingHosts\ai_manager_host` 注册表（免管理员）

之后刷新扩展，打开新标签页即可使用左栏 AI 管理器。

## 安全边界

- **白名单硬编码**：UIA 只对 claude / lms / ollama / lm-studio / chatgpt / cursor
  进程的弹窗生效，绝不监听/点击其他应用的窗口。
- **点击必须人工触发**：host 从不自动点弹窗，只有你在扩展 UI 上点「确认/否认」后
  才遥控对应按钮，且按 dialogId（窗口句柄）精确配对。
- **内容本机闭环**：消息经 stdin/stdout 在扩展与 host 间直传，不上传任何远端。

## 消息协议

host → 扩展（stdout，4 字节小端长度前缀 + JSON，单条 ≤ 64KB）：

```json
{ "type": "apps", "apps": [ { "id": "claude-code", "name": "Claude Code", "status": "tasking", "detail": "..." } ] }
{ "type": "message", "app": "claude-code", "role": "assistant", "text": "...", "ts": "...", "done": false }
{ "type": "dialog", "id": 12345, "app": "lms", "title": "确认覆盖?", "buttons": [ { "id": "确定", "label": "确定" } ] }
{ "type": "dialog:closed", "id": 12345 }
{ "type": "snapshot", "apps": [], "dialogs": [], "messages": [] }
```

扩展 → host（stdin 同帧格式）：

```json
{ "type": "query" }
{ "type": "dialog:respond", "dialogId": 12345, "buttonId": "确定" }
```

## 调试

```bash
# 手动喂一条 query，看 host 应答（会先收到 host:ready）
node -e "const b=Buffer.from(JSON.stringify({type:'query'}));const h=Buffer.alloc(4);h.writeUInt32LE(b.length);process.stdout.write(h)"
# ↑ 输出帧管道给 host.mjs 的 stdin 即可
```
