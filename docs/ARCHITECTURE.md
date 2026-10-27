# 架构与数据流

本文说明 `plug_zjt` 三个运行时的职责、信任边界、数据流和关键取舍。目标是让后续改动能判断
「代码该放哪一层」「哪里是安全边界」「数据丢了先查哪」。

## 1. 全景

```text
┌────────────────────────── Chrome / Edge ──────────────────────────┐
│                                                                    │
│  extension/（便利贴）                    newtab/（新标签页）        │
│  ┌─────────────────────┐                 ┌──────────────────────┐  │
│  │ sidepanel / popup    │                 │ index.html           │  │
│  │ options              │                 │  ├─ 左：系统监视    │  │
│  │ background.js (SW)   │◄── external ────┤  ├─ 中：widget grid  │  │
│  │  ├─ chrome.storage   │   message       │  └─ 右：AI 管理器   │  │
│  │  ├─ File System API  │                 │ background.js (SW)   │  │
│  │  └─ Notion API       │                 │  ├─ runtime.connect │  │
│  └─────────────────────┘                 │  ├─ 目录树/剪贴板   │  │
│                                          │  └─ connectNative   │  │
│                                          └──────────┬───────────┘  │
└─────────────────────────────────────────────────────┼──────────────┘
                                                      │ Native Messaging
                                                      ▼
                                     ai_manager_host/host.mjs（Node.js）
                                       ├─ PowerShell：进程/CIM/UIA
                                       ├─ ~/.claude、~/.codex 日志 tail
                                       └─ sysmon.ps1
```

## 2. 组件职责

### 2.1 便利贴扩展（`extension/`）

- **UI**：`sidepanel`（主操作面）、`popup`（快速查看）、`options`（设置/备份/文件夹/Notion）。
- **Service Worker**：消息路由、Notion 调用、提醒 alarm、导出下载、外部扩展白名单。
- **数据层**：`lib/store.js` 是 `chrome.storage.local` 的唯一读写入口；`lib/fs.js` 是文件镜像；
  `lib/notion.js` 是云镜像；`lib/idb.js` 存目录句柄。
- **可信源**：`chrome.storage.local`。文件/Notion 都是可重建的镜像，冲突时以本地为准
  （拉取方向除外：拉取会用云端覆盖本地，但保留本地 `createdAt/tasks/blocks`）。

### 2.2 新标签页扩展（`newtab/`）

- **页面**：`index.html` + `js/main.js` 启动；`grid.js` 渲染 widget；`aimanager.js` / `sysmonitor.js`
  是左右面板；`bookmarksbar.js` 读书签。
- **布局**：`.grid-shell` 负责为停靠面板让位，网格用容器查询按“可用宽度”换列；
  `layout.js` 判断面板停靠/抽屉，`main.js` 统一维护 `body.panels-overlay` / `panel-open` /
  `sys-panel-on` / `ai-panel-on`。`< 1024px` 全部抽屉，`1024–1279px` 双面板时抽屉，
  `≥ 1280px` 停靠；面板开关偏好存 `settings.showSysPanel/showAiPanel`，窄屏未打开的面板惰性初始化。
- **Service Worker**：`background.js` 是目录树/剪贴板/音乐/书签跳转的路由中心，并维护
  `connectNative('ai_manager_host')` 长连接。
- **状态**：`js/store.js` 单键 `newtab_state`，整体读写；`schemaVersion` 负责迁移。
- **目录树**：`content.js` 在任意页面注入入口；`tree.html` iframe 展示；句柄存 IndexedDB；
  文件读写经 SW 调 `fs-access.js`。
- **音乐**：页面直接从 IndexedDB 句柄读音频大文件，避免走 Native Messaging/消息通道。

### 2.3 本地宿主（`ai_manager_host/`）

- Node.js 进程，由 Chrome 按需启动；stdin/stdout 走 Native Messaging 帧。
- 轮询进程、会话日志、弹窗、系统指标；维护 `appStatus`、`recent`（≤50 条）、`sessionCache`、
  `openDialogs`、`lastSys`。
- 只负责「本机能力」，不做持久化；页面关闭后宿主由 Chrome 回收。

## 3. 关键数据流

### 3.1 便利贴增删改

```text
sidepanel/options
  └─ sendMessage('saveNote'/'deleteNote')
       └─ SW handleMessage
            ├─ lib/store.js → chrome.storage.local（唯一可信源）
            └─ 页面侧（sidepanel/options 持有目录句柄）→ lib/fs.js 写/删 .md
```

> 目录句柄只在页面上下文可用（File System Access 的限制），所以文件写入由页面执行，
> SW 只做消息路由；SW 不直接持有句柄。

### 3.2 跨扩展任务联动

```text
newtab 页面（stickyTasks.js）
  └─ chrome.runtime.sendMessage(extensionId, {action:'getTaskNotes'})
       └─ extension/background.js onMessageExternal
            ├─ 校验 sender.id ∈ manifest.externally_connectable.ids
            ├─ action 白名单：getTaskNotes/getReminders/toggleTask
            └─ 读 chrome.storage.local 返回
```

- `newtab` 的 `settings.stickyExtId` 保存目标扩展 ID；为空时跳过联动。
- 便利贴扩展不开放网页来源；即使 manifest 被改宽，`sender.id` 二次校验仍会拦截。

### 3.3 AI 管理器

```text
aimanager.js
  ├─ runtime.connect({name:'ai:subscribe'}) ──► newtab/background.js
  │                                               ├─ connectNative('ai_manager_host')
  │                                               └─ 广播 host 事件给所有订阅 port
  ├─ sendMessage('ai:query'/'ai:sysmon'/'ai:respond')
  └─ 收到 ai:event：apps/message/session/dialog/snapshot/sys/host:*
```

- 页面只消费事件，不直接碰 Native Messaging。
- host 断开：SW 广播 `host:error` 并 10s 后重连；页面侧指数退避重连 port。
- 快照预算 512 KB，消息回放按新→旧装入；页面只用快照驱动会话状态机，不渲染历史。

### 3.4 系统指标

```text
sysmonitor.js
  ├─ sendMessage('ai:sysmon', {fast:!document.hidden})
  └─ 收到 ai:event{type:'sys'} → 40 点 sparkline + 数值
```

- 页面可见 3s、后台 15s；页面全部断开时 SW 发 `fast:false`。
- 刷新按钮/回到前台会 `ai:query`，host 补发 `lastSys`。
- 12s 无数据呼吸点变灰；指标为 `null` 时显示 `--`。

### 3.5 文件夹镜像

```text
保存/删除便利贴
  → lib/fs.js writeNoteFile/deleteNoteFile
       → <绑定目录>/<分类key>/<UUID>.md
```

全量同步 `syncFolderAll`：

1. 只枚举 `categories.js` 中定义的分类目录；
2. 只收集 `.md` 文件名；
3. `planFolderPrune` 只删除「分类目录内、UUID.md 命名、且不在当前 notes 中」的文件；
4. 写入所有 notes。

这条边界是数据安全修复的重点：早期实现会遍历绑定目录下**所有**子目录并删除所有不在
expected 集合中的 `.md`，可能误删用户自己的 Markdown。现在未知目录/非 `.md`/非 UUID 文件都不动。

### 3.6 Notion 同步

```text
notionPush
  ├─ GET /v1/databases/{id} → schema Map<列名,类型>
  ├─ 必需列校验（Title/Category/Content/Pinned/NoteID）
  ├─ buildIdMap（query 全量，NoteID → pageId）
  └─ 逐条 pushNote(note, pageId, schema)
       └─ buildNoteProperties：核心列 + 存在且类型匹配的可选列
```

- 可选列缺失/类型不符 → 跳过并在结果里返回 `missingOptional`，侧边栏 toast 提示。
- 缺少必需列 → 测试连接/推送直接报错，不会写出一半才 400。
- 拉取方向 `pullAll` 用 `NoteID` 去重，保留本地 `createdAt/tasks/blocks`。

## 4. 存储与 schema

### 4.1 便利贴

| 键/介质 | 内容 |
|---------|------|
| `chrome.storage.local`（notes/settings） | 便利贴数组、Notion token、上次同步时间、文件夹绑定元数据 |
| IndexedDB（`lib/idb.js`） | FileSystemDirectoryHandle（不可序列化到 storage） |
| 本地文件夹 | `<category>/<uuid>.md` 镜像 |
| Notion database | 每行一条笔记，`NoteID` 为关联键 |

### 4.2 新标签页

`newtab_state = { settings, widgets }`：

- `settings`：`theme`、`bgColor`、`stickyExtId`、`showSysPanel`、`showAiPanel`、`schemaVersion`。
- `widgets`：`{id, key, size, data}` 数组；`data` 由各 widget 自定义。
- `SCHEMA_VERSION = 8`；迁移只追加/改默认值，不重排用户布局。
  - v7 → v8：追加 `focusTimer`（番茄钟）。
- 目录句柄存 IndexedDB（`newtab_tree`），与 state 分开。

## 5. 安全模型

| 边界 | 措施 |
|------|------|
| 跨扩展调用 | `externally_connectable.ids` 只列新标签页 ID；无 `matches`；`sender.id` 二次校验；action 白名单 |
| 本地宿主 | `allowed_origins` 锁定扩展 ID；只读 stdin 帧；未知请求报错 |
| UIA 弹窗 | 进程白名单；只枚举 `#32770`；点击由用户在 UI 触发；按 dialogId 精确匹配 |
| 文件删除 | 只清理已知分类目录 + UUID.md；全量同步前确认 |
| Notion | token 只存本地；schema 适配避免盲写；错误信息不回显 token |
| 内容脚本 | `<all_urls>` 注入，但目录树默认隐藏；可选 host 权限；不需要可在扩展页关闭站点访问 |

### 5.1 已知边界/取舍

- 扩展 ID 是硬编码的：重新加载/换路径后 ID 可能变化，需要同时更新便利贴 manifest 与宿主安装参数。
- `com.zjt.ai_manager.json` 含本机绝对路径，是「本机生成物」而非可移植配置。
- 内容脚本注入所有站点是目录树功能的代价；如果只需要书签/组件，可移除 `content_scripts`。
- 宿主每轮都拉起 PowerShell，CPU 开销明显；通过后台降频/快照预算控制，但仍有优化空间。
- 文件夹镜像不是双向文件监听：用户直接在文件夹改 `.md` 不会回写 storage（设计如此，storage 是可信源）。

## 6. 失败与恢复

| 场景 | 行为 |
|------|------|
| SW 被回收 | 页面 port 断开 → 指数退避重连；host 端口由 SW 按需重建 |
| host 未安装/崩溃 | `host:error` 横幅；10s 后自动重连；面板仍可操作其他组件 |
| 会话日志不可读 | 单轮静默跳过，下轮再试；不阻塞进程扫描 |
| WMI 拒绝访问 | `sysmon.ps1` 对应字段为 `null`，面板显示 `--` |
| 文件夹权限失效 | 写入失败静默跳过；设置页显示同步结果；主数据不受影响 |
| Notion 限流/5xx | `fetchJson` 对 429/5xx 重试（最多 2 次，递增延迟） |
| 快照过大 | 512 KB 预算裁剪消息回放，避免超过 1 MB 被杀连接 |

## 7. 测试与回归

- `tests/folder-sync.test.mjs`：清理范围（未知目录/非 `.md`/非 UUID 不删）。
- `tests/notion-properties.test.mjs`：schema 过滤、类型不符跳过、旧调用兼容。
- `tests/manifest.test.mjs`：跨扩展白名单与宿主 allowed_origins 一致、无通配。
- `tests/focus-timer.test.mjs`：番茄钟注册/默认状态/v7→v8 迁移。
- `scripts/check.mjs`：manifest/JSON、资源引用、白名单、widget registry。

在受限环境中 `node --test tests/` 可能因测试 runner 子进程管道被拦截而 `spawn EPERM`；
逐文件 `node tests/xxx.test.mjs` 可正常运行。普通终端可直接用 `node --test tests/`。

## 8. 扩展点

- **新增 widget**：`newtab/js/widgets/<key>.js` → `registry.js` 注册 → `widgets.css` 样式 →
  如需老用户自动获得则升 `SCHEMA_VERSION` 并写迁移。
- **新增 AI 应用**：`host.mjs` 的 `APPS` 加一条；日志型应用补 adapter；`aimanager.js` 的
  `APP_ICONS` 加图标；UIA 白名单按需加到 `dialogs.ps1`。
- **新增便利贴分类**：`extension/lib/categories.js`；文件目录/筛选/Notion select 自动跟随。
- **新增宿主事件**：`host.mjs` `post({type})` → `newtab/background.js` 透传 → `aimanager.js`/`sysmonitor.js` 处理；
  大消息注意 1 MB 上限与快照预算。
