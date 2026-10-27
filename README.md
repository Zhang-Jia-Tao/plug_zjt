# 星野智能工作台（plug_zjt）

一个以「浏览器新标签页」为入口的本地生产力工作台，由三个可独立安装的部分组成：

| 组件 | 位置 | 作用 |
|------|------|------|
| 可定制新标签页 | `newtab/` | 新标签页小组件、书签栏、本地目录树、AI 应用管理器、系统资源监视 |
| 程序员便利贴 | `extension/` | 侧边栏便利贴：分类记录、提醒、文件夹同步、Notion 云同步 |
| AI 管理器本地宿主 | `ai_manager_host/` | Native Messaging host：枚举本机 AI 应用、读会话日志、点白名单弹窗、采集系统指标 |

三者关系：

```text
┌──────────────────────────── Chrome ────────────────────────────┐
│  newtab/（新标签页扩展，ID: lpgf...iaiff）                      │
│    ├─ 页面 UI ── runtime.connect ──┐                            │
│    ├─ 目录树 / 音乐（File System Access + IndexedDB）           │
│    └─ AI 面板 / 系统监视 ◄─────────┤                            │
│                                    │                            │
│  extension/（便利贴扩展）          │                            │
│    └─ onMessageExternal ◄──────────┘ 只读任务/提醒 + 受控 toggle │
└────────────────────────────────────┬────────────────────────────┘
                                     │ chrome.runtime.connectNative
                                     ▼
                       ai_manager_host/host.mjs（Node.js）
                         ├─ PowerShell：进程/WMI/UIA
                         ├─ ~/.claude、~/.codex 会话日志
                         └─ sysmon.ps1：CPU/内存/磁盘/温度/GPU
```

## 快速开始

### 1. 加载两个扩展

1. 打开 `chrome://extensions`，开启「开发者模式」。
2. 「加载已解压的扩展程序」→ 选择 `extension/`（便利贴）。
3. 再加载一次 → 选择 `newtab/`（新标签页）。

> 需要 Chrome / Edge 114+（Side Panel API、MV3）。

### 2. 安装本地 AI 宿主（可选）

```bat
cd ai_manager_host
install-host.bat <新标签页扩展ID>
```

扩展 ID 在 `chrome://extensions` 的「可定制新标签页」卡片上查看。安装脚本会把
`allowed_origins` 锁定到该 ID，并写入当前用户的 Chrome Native Messaging 注册表（无需管理员）。

### 3. 配置跨扩展联动（可选）

便利贴扩展的 `externally_connectable.ids` 只允许上面这个新标签页扩展接入。若你重新加载
扩展导致 ID 变化，需要同步修改：

- `extension/manifest.json` → `externally_connectable.ids`
- 重新执行 `install-host.bat <新ID>`

## 功能概览

### 新标签页（`newtab/`）

- **小组件网格**：时间日历、搜索、常用网站、便利贴任务、番茄钟、本地音乐；支持拖拽排序、尺寸切换、编辑模式。
- **AI 应用管理器**：Claude Code / Codex（ChatGPT 桌面版）/ Ollama / LM Studio / Claude 桌面版的状态、会话 token 统计、白名单弹窗确认。
- **响应式工作台**：左右面板可在工具条中开关；宽屏停靠、窄屏改抽屉；网格按可用宽度自动 4/3/2/1 列，避免侧栏覆盖卡片。
- **系统资源监视**：CPU、内存、交换、磁盘、温度、GPU/显存；页面在后台自动降频。
- **本地目录树**：任意网页唤出侧栏，浏览/编辑本地文件，复制粘贴走 offscreen 文档。
- **书签栏**：读取 Chrome 书签，支持 `chrome://` 内部页跳转。

### 便利贴（`extension/`）

- 15 个分类（测试/正式环境、账号、需求、任务清单、缺陷、BUG、网址、服务器命令、提醒、会议、闪念、SSH、个人信息等）。
- 任务清单勾选、提醒通知、搜索筛选、置顶、拖拽排序。
- 本地文件夹镜像（`.md`）与 Notion 数据库双向同步。
- JSON / Markdown 导出与 JSON 恢复。

## 安全与数据边界

- **跨扩展调用**：`extension/manifest.json` 的 `externally_connectable.ids` 只列新标签页扩展 ID，且
  `background.js` 会再次校验 `sender.id`；不存在网页来源的通配放行。
- **文件夹同步**：全量同步只清理「已知分类目录 + UUID.md」文件，其他目录、非 `.md`、非本扩展命名的文件不动；
  设置页执行前有确认提示。
- **Notion**：推送前读取 database schema，只写存在且类型匹配的列；缺少必需列会给出明确错误，可选列自动跳过。
- **本地宿主**：`allowed_origins` 锁定扩展 ID；UIA 弹窗只处理白名单进程；点击必须由用户在 UI 触发。
- **数据主源**：便利贴以 `chrome.storage.local` 为唯一可信源，文件/Notion 都是镜像；新标签页以
  `chrome.storage.local` 的 `newtab_state` 为唯一状态源。

## 开发与回归

无构建步骤，扩展源码即产物。已安装 Node.js 24+ 时可直接跑回归：

```powershell
# 静态检查：manifest/JSON、资源引用、跨扩展白名单、widget 注册
node scripts/check.mjs

# 单元/回归测试（直接执行每个测试文件，避免测试 runner 在受限环境下 spawn 子进程）
Get-ChildItem tests -Filter *.test.mjs | ForEach-Object { node $_.FullName }
```

> 在普通终端也可以 `node --test tests/`；当前 DSH 沙箱会拦截测试 runner 的子进程管道
> （`spawn EPERM`），所以仓库内的验证命令采用逐文件执行。

## 目录结构

```text
plug_zjt/
├── newtab/                  # 可定制新标签页扩展
│   ├── index.html           # 新标签页主体（书签栏 + 左系统栏 + 右 AI 栏 + 组件网格）
│   ├── background.js        # SW：AI 端口、目录树/剪贴板/音乐路由
│   ├── js/
│   │   ├── main.js          # 启动、设置面板、主题/背景、面板停靠/抽屉
│   │   ├── layout.js        # 布局断点判定（可单测）
│   │   ├── store.js         # newtab_state 读写 + schema 迁移（v8）
│   │   ├── grid.js          # 组件渲染/拖拽/尺寸/编辑
│   │   ├── aimanager.js     # AI 应用面板 + 会话统计卡
│   │   ├── sysmonitor.js    # 系统资源监视
│   │   ├── widgets/         # 各小组件（registry.js 注册）
│   │   ├── handle-store.js  # 目录句柄 IndexedDB
│   │   └── fs-access.js     # 目录扫描/读写
│   ├── content.js/tree.*    # 任意网页侧栏目录树
│   └── offscreen.*          # 剪贴板代持
├── extension/               # 程序员便利贴扩展
│   ├── background.js        # SW：消息路由、Notion、alarms、downloads
│   ├── sidepanel.*          # 主操作面
│   ├── popup.* / options.*  # 快速查看 / 设置
│   └── lib/                 # store/fs/notion/categories/idb
├── ai_manager_host/         # Node.js Native Messaging host
│   ├── host.mjs             # 主程序：轮询/协议/会话聚合
│   ├── sysmon.ps1           # 系统指标采集
│   ├── dialogs.ps1          # UIA 弹窗枚举
│   └── dialog-click.ps1     # 白名单弹窗按钮点击
├── tests/                   # Node 回归测试（.mjs）
├── scripts/check.mjs        # 无依赖静态检查
├── docs/ARCHITECTURE.md     # 架构、数据流、安全边界
└── src/                     # Spring Boot 骨架（与本项目运行无关）
```

> 根目录下与 `extension/` 同名的 `manifest.json`、`background.js`、`lib/` 等是早期副本，
> 当前以 `extension/` 为准；不要在两处同时改。

## 文档

- [架构与数据流](docs/ARCHITECTURE.md)
- [新标签页说明](newtab/README.md)
- [便利贴扩展说明](extension/README.md)
- [AI 管理器宿主说明](ai_manager_host/README.md)

## 已知限制

- 本地 AI 宿主仅支持 Windows（WMI/CIM + UIA + PowerShell）。
- 系统指标依赖 WMI 权限；在受限沙箱/无权限环境下 CPU、GPU、温度可能为空。
- 宿主清单 `ai_manager_host/com.zjt.ai_manager.json` 内含本机绝对路径与扩展 ID，换机器/换路径后需重新安装。
- 新标签页的目录树需要 File System Access 权限；浏览器重启后部分目录可能需要重新授权。
- 没有打包构建；修改后需在 `chrome://extensions` 重新加载对应扩展。
