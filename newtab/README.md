# 可定制新标签页（newtab）

Manifest V3 新标签页扩展：把新标签页做成可编排的工作台，包含小组件网格、书签栏、本地目录树、AI 应用管理器和系统资源监视。

## 加载

1. `chrome://extensions` → 开启「开发者模式」。
2. 「加载已解压的扩展程序」→ 选择本目录 `newtab/`。
3. 打开新标签页即可看到工作台。
4. AI 管理器/系统监视需要先安装本地宿主：

```bat
cd ..\ai_manager_host
install-host.bat <本扩展ID>
```

扩展开启开发者模式后，卡片上可看到 ID。宿主清单的 `allowed_origins` 会锁定该 ID。

## 页面结构

```text
┌──────────────────── 书签栏（bookmarksbar.js） ────────────────────┐
│ 左：系统资源面板     中间：小组件网格（search/time/sites/tasks/...） 右：AI 应用面板 │
│ sysmonitor.js         grid.js + widgets/*.js                        aimanager.js  │
└────────────────────────────────────────────────────────────────────┘
```

- 左栏/右栏是 `position: fixed` 的停靠面板，网格外层 `.grid-shell` 通过 `--sys-w` / `--ai-w` 计算左右让位；工具条也只在 AI 面板停靠时左移，避免来回跳。
- 工具条新增两个面板开关，偏好保存在 `settings.showSysPanel` / `settings.showAiPanel`。窄屏自动改为抽屉：`< 1024px` 无论开几个面板都收起；`1024–1279px` 仅当两个面板同时开启时收起；`≥ 1280px` 双面板停靠。抽屉带遮罩，点空白、面板内 ✕ 或 Esc 关闭，一次只开一个。
- 网格列数由可用宽度决定（容器查询）：`> 1100px` 4 列、`> 700px 且 ≤ 1100px` 3 列、`> 480px 且 ≤ 700px` 2 列、`≤ 480px` 1 列。S/M/L 在各档下分别按 1/2/全宽等比降级，3 列布局用 6 条底层轨道保证两个 M 卡正好拼满一行。
- 面板按需初始化：窄屏未打开过的 AI/系统面板不会建立 Native Messaging 订阅，打开时才加载。
- 支持拖拽排序、尺寸切换（S/M/L）、编辑模式删除。
- 设置面板：主题、背景色、左右面板开关、每实例配置、添加/删除组件、恢复默认；小屏下设置行改为纵向排列，标题吸顶。

## 小组件

注册中心：`js/widgets/registry.js`。新增组件只需：

1. 新建 `js/widgets/<key>.js`，默认导出：

```js
export default {
  key: 'myWidget',
  label: '我的组件',
  description: '可选说明',
  defaultData: { /* 默认私有状态 */ },
  config: [ /* 可选：{key,label,type:'select'|'bool',default,options} */ ],
  init(container, data, api) {
    // 渲染 DOM、绑定事件
    // api.patchWidget(patch) 持久化私有状态
    // 返回清理函数（清定时器/监听）
    return () => {};
  },
};
```

2. 在 `registry.js` 的 `WIDGETS` 数组注册。
3. 在 `css/widgets.css` 增加样式（如需）。
4. 若希望老用户自动获得，提升 `store.js` 的 `SCHEMA_VERSION` 并写迁移。

现有组件：

| key | 说明 |
|-----|------|
| `timeCalendar` | 时间 + 日历 + 事件 |
| `search` | 搜索引擎切换、AI 入口 |
| `topSites` | 常用网站（可自定义） |
| `stickyTasks` | 便利贴扩展任务清单联动 |
| `focusTimer` | 番茄钟/专注倒计时，刷新页面可续计时 |
| `music` | 本地音乐播放器（File System Access 直读） |

### 便利贴任务

- 卡片标题栏固定显示，带刷新按钮；未配置 ID、扩展未启用、来源未授权都会显示原因和「去设置/重试」入口。
- 跨扩展请求 5 秒超时，避免卡片一直停在「正在读取」。
- 若提示来源未授权，检查便利贴 `extension/manifest.json` 的 `externally_connectable.ids` 是否包含设置页显示的「本扩展 ID」。

### 番茄钟

- 状态保存在 `widget.data`：`minutes`、`endAt`、`remainingMs`、`running`。
- 基于 `endAt` 时间戳计时，页面刷新/组件重渲染后自动恢复；暂停时保存剩余毫秒。
- 完成时用 Web Audio 播放轻提示音（不需要系统通知权限）。
- 配置里可选 5/10/15/25/45/60 分钟。

## 状态存储与迁移

`js/store.js`：

- 单键 `newtab_state = { settings, widgets }`，整体读写。
- `settings.schemaVersion` 记录结构版本；当前 `SCHEMA_VERSION = 9`。
- `migrateState()` 按版本递增补默认组件/改默认值，不改变用户已有布局顺序。
- v7 → v8 追加 `focusTimer`；v8 → v9 补回缺失的 `stickyTasks`；已有组件不重复迁移。
- `settings.stickyExtId` 保存便利贴扩展 ID，供任务/提醒联动。
- `settings.showSysPanel` / `settings.showAiPanel` 保存宽屏停靠偏好；窄屏抽屉是临时态，不写入这两个字段。

## AI 应用管理器

数据链路：

```text
本机 AI：
newtab 页面
  aimanager.js  ── runtime.connect('ai:subscribe') ──► background.js
                                                        │ connectNative
                                                        ▼
                                              ai_manager_host/host.mjs
  aimanager.js  ◄── ai:event 广播 ── background.js ◄── host 推送

网页 AI：
content-webai.js ── ai:web-state ──► background.js（按 tab 聚合）
  aimanager.js  ◄── ai:event(type: webai) ── background.js
```

- 本机事件：`apps`（应用状态）、`message`（实时消息，驱动会话状态徽标）、`session`（会话统计）、`dialog` / `dialog:closed`、`snapshot`、`sys`、`host:ready`、`host:error`。
- 网页事件：`webai`（每个站点的打开/空闲/生成中状态、活动标签页）。
- 本机应用覆盖 Claude Code、ChatGPT 桌面版、Ollama、LM Studio、llama.cpp、vLLM、LocalAI、KoboldCpp、GPT4All、Jan、AnythingLLM、text-generation-webui、Cherry Studio、Chatbox、Claude 桌面版、Cursor。
- 网页 AI 当前覆盖 ChatGPT、Claude、Gemini、DeepSeek、Kimi、Perplexity、Grok、Copilot，只读页面状态和标题，不读取聊天正文，也不承诺 token/费用统计。
- UI 只展示本机会话统计卡（项目/模型/输入/输出/轮次/最近请求），不渲染完整对话历史；网页卡片点击可切到对应标签页。
- 会话短 ID 可点击复制完整 ID；相对时间每 30s 自动刷新。
- 弹窗确认/否认：`ai:respond` → SW → host 遥控点击白名单进程的按钮；host 不会自动点。新增本地应用默认只做状态监控，不在弹窗白名单里。
- 连接断开指数退避重连（1s → 15s）。

## 系统资源监视

`js/sysmonitor.js`：

- 指标：CPU、内存、交换、磁盘读写、开机时长、CPU/GPU 温度、GPU/显存。
- 40 点迷你折线；无数据时显示 `--`。
- 刷新按钮（`#sys-refresh`）重新请求快照；呼吸点超过 20s 无数据变灰。
- 页面可见时 5s 高频、切到后台自动降到 15s；回到前台立即拉一次快照。
- 数据来自宿主 `sysmon.ps1`（WMI/CIM）；受限环境下部分指标可能为空。

## 本地目录树

- 任意网页按 `Ctrl+Shift+E` 唤出侧栏（`content.js` + `tree.html` iframe）。
- 目录句柄存 IndexedDB（`js/handle-store.js`），SW 负责扫描/读写（`js/fs-access.js`）。
- 文件复制/粘贴走 `offscreen.html` 代持剪贴板焦点。
- 支持新建目录、卸载目录、下载文件到本地。

## 本地音乐

- 选择本地目录后扫描音频（flac/mp3/m4a/ogg/wav/aac/opus）。
- 音频大文件由页面直接从 IDB 句柄读取，不走 SW，避免消息体过大。
- 支持播放/暂停、上一首/下一首、音量、循环。

## 权限说明

| 权限 | 用途 |
|------|------|
| `storage` | 保存 `newtab_state` |
| `topSites` / `bookmarks` | 常用网站 / 书签栏 |
| `nativeMessaging` | AI 管理器宿主 |
| `tabs` / `scripting` | 书签跳转、目录树侧栏注入 |
| `offscreen` | 剪贴板代持 |
| `clipboardRead/Write` | 目录树复制粘贴 |
| `downloads` | 下载文件 |
| `favicon` | 常用网站图标 |
| `file://*/*` | 本地目录树（file 权限） |
| `<all_urls>`（optional） | 目录树在任意网页启用 |

> 内容脚本注入 `<all_urls>`，但目录树 UI 默认隐藏，只有快捷键/按钮才显示；如不需要可在
> `chrome://extensions` 关闭站点访问或移除该内容脚本。`content-webai.js` 仅注入上方列出的
> AI 站点，只上报 host/status/title/active，不读取聊天正文。

## 文件结构

```text
newtab/
├── manifest.json
├── index.html               # 新标签页主体
├── background.js            # SW：AI 端口/网页聚合、目录树/剪贴板/音乐路由
├── content.js / content.css # 任意网页目录树入口
├── content-webai.js         # 网页 AI 状态采集（仅 AI 站点）
├── tree.html                # 目录树 iframe 页面（js/tree.js + css/tree.css）
├── file-picker.html         # 目录选择小窗（js/picker.js）
├── offscreen.html           # 剪贴板代持（js/offscreen.js）
├── css/
│   ├── base.css             # 布局/面板/书签栏/设置
│   ├── settings.css         # 设置面板
│   ├── tree.css             # 目录树
│   └── widgets.css          # 各小组件样式
├── js/
│   ├── main.js              # 启动/设置/主题/面板停靠与抽屉
│   ├── layout.js            # 纯布局断点判定（可单测）
│   ├── store.js             # 状态读写 + 迁移
│   ├── grid.js              # 网格渲染/拖拽/尺寸
│   ├── aimanager.js         # AI 面板（本机 + 网页）
│   ├── webai-sites.js       # 网页 AI 站点注册表
│   ├── sysmonitor.js        # 系统监视
│   ├── bookmarksbar.js      # 书签栏
│   ├── tree.js / picker.js  # 目录树 / 目录选择
│   ├── handle-store.js      # 目录句柄 IDB
│   ├── fs-access.js         # 目录扫描/读写
│   ├── bridge.js / favicon.js / offscreen.js
│   └── widgets/             # 各组件 + registry.js
├── img/                     # 品牌图/应用图标
└── tools/                   # 品牌图生成工具（非运行时）
```

## 开发与回归

无构建步骤，改完在 `chrome://extensions` 重新加载即可。

```powershell
# 静态检查（含 registry 引用、HTML 资源）
node scripts/check.mjs

# 番茄钟/迁移回归
node tests/focus-timer.test.mjs

# 面板停靠/抽屉断点回归
node tests/panel-layout.test.mjs

# 便利贴跨扩展消息回归
node tests/sticky-bridge.test.mjs

# 网页 AI 注册表/注入覆盖回归
node tests/webai.test.mjs

# 本地 AI 模型探测回归
node tests/ai-probe.test.mjs
```

## 常见问题

| 现象 | 排查 |
|------|------|
| AI 面板显示「主机未连接」 | 是否执行 `install-host.bat <新标签页ID>`；`chrome://extensions` 里的 ID 是否与宿主 `allowed_origins` 一致 |
| 网页 AI 分组为空 | 是否打开了受支持的 AI 站点；重新加载扩展后刷新该站点；`content-webai.js` 是否被站点匹配 |
| 网页 AI 一直显示空闲 | 站点 Stop 按钮/aria-busy 选择器可能改版；卡片仍可点击聚焦，状态会 8s 心跳自愈 |
| 网页 AI 为什么没有 token | 网页端没有稳定 usage 接口；本版本只做活动状态，不 hook 网络响应 |
| 系统指标大量 `--` | WMI 权限/沙箱限制；在普通桌面 Chrome 中运行宿主，而不是受限终端 |
| 目录树不可用 | 是否授予文件访问权限；浏览器重启后部分目录需重新授权 |
| 任务清单为空 | 便利贴扩展的 `stickyExtId` 是否正确；便利贴扩展是否已加载 |
| 番茄钟刷新后不继续 | 检查 `widget.data.endAt` 是否被保存；页面关闭前是否处于运行态 |
