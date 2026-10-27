# 程序员便利贴（浏览器扩展）

Manifest V3 扩展，用便利贴记录程序员日常工作信息：测试/正式环境网址、账号、需求清单、缺陷/BUG、网址、服务器命令、提醒、会议、SSH、个人信息等。支持本地文件夹镜像与 Notion 云同步。

## 加载扩展（开发模式）

1. 打开 Chrome / Edge：`chrome://extensions`
2. 右上角开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择本目录 `extension/`
4. 工具栏出现 📌 图标，点击打开侧边栏

> 要求 Chrome 114+（Side Panel API）。

## 使用

- **侧边栏（主操作面）**：顶部分类 tab 筛选 + 搜索；「+ 新建」创建便利贴；卡片点击编辑。
- **Popup（快速查看）**：点图标弹出精简列表；点「⇱ 侧边栏」打开常驻面板。
- **底栏**：导出（JSON 可恢复 / Markdown 可读）、同步 Notion、设置。

## 分类与数据模型

分类定义在 `lib/categories.js`（15 类）：测试环境、正式环境、账号、正式账号、需求、任务清单、缺陷、BUG、网址、服务器命令、提醒、会议、闪念、SSH 配置、个人信息。

每条便利贴的核心字段：

| 字段 | 说明 |
|------|------|
| `id` | `crypto.randomUUID()`，也是文件名与 Notion `NoteID` |
| `title` / `content` | 标题 / 正文 |
| `category` | 分类 key |
| `pinned` | 是否置顶 |
| `createdAt` / `updatedAt` | ISO 时间 |
| `remindAt` | 提醒时间（可空） |
| `url` / `host` / `port` / `username` / `password` | 环境/账号/SSH 字段 |
| `name` / `phone` / `email` / `idCard` | 个人信息字段 |
| `fields` | 自定义标签数组 `{label, value}` |
| `tasks` | 任务清单 `{id, text, done}` |
| `blocks` | 多内容块 |

## 本地文件夹同步

设置页 →「绑定文件夹」选择一个目录。绑定后：

- 每条便利贴保存为 `<文件夹>/<分类key>/<id>.md`
- 增删改实时镜像到文件（文件不是唯一数据源）
- 「立即同步全部到文件夹」可对齐整棵分类目录

**全量同步的删除边界**（设置页会弹出确认）：

1. 只扫描/清理 `categories.js` 中定义的分类目录；
2. 只清理文件名形如 `UUID.md` 的文件（本扩展的命名格式）；
3. 绑定目录中的其他目录、非 `.md` 文件、非 UUID 命名文件一律不碰。

> 文件夹未绑定时功能静默跳过，不影响主数据。主数据始终在 `chrome.storage.local`。

## Notion 云同步

设置页 →「Notion 云同步」：

1. 访问 https://www.notion.so/my-integrations 创建 integration，复制 `secret_xxx` token。
2. 在 Notion 新建 database，并把该页面「分享」给 integration。
3. 复制 database URL 末段 ID，与 token 一起填入设置页。
4. 点「测试连接」确认。

### 必需列

| 列名 | 类型 |
|------|------|
| `Title` | title |
| `Category` | select |
| `Content` | rich_text |
| `Pinned` | checkbox |
| `NoteID` | rich_text |

### 可选列（按需创建）

`URL`(url)、`RemindAt`(date)、`Username`/`Password`/`Host`/`Port`/`Name`/`Phone`/`Email`/`IDCard`/`CustomFields`(rich_text)。

推送前会读取 database schema：

- 数据库没有的可选列自动跳过，不再因缺列返回 400；
- 列存在但类型不符也会跳过，并提示哪些列被跳过；
- 缺少必需列时「测试连接」和推送都会给出明确错误。

侧边栏「🔄 同步」：1 = 推送本地到 Notion，2 = 从 Notion 拉取（覆盖本地，保留本地 `createdAt`/`tasks`/`blocks`）。

## 跨扩展联动（与新标签页）

新标签页扩展通过 `chrome.runtime.sendMessage(extensionId, ...)` 调用本扩展的只读接口：

| action | 作用 |
|--------|------|
| `getTaskNotes` | 拉取「任务清单」分类便利贴 |
| `getReminders` | 拉取提醒/会议便利贴摘要 |
| `toggleTask` | 切换某条便利贴里的任务勾选状态 |

安全限制：

- `manifest.json` 的 `externally_connectable.ids` 只允许新标签页扩展 ID；
- `background.js` 再用 `sender.id` 校验同一份清单；
- 不开放网页来源（无 `matches`），不存在 `ids: ["*"]`。

如果重新加载新标签页扩展导致 ID 变化，需要同步更新这里的 ID 与本地宿主的安装参数。

## 提醒事项

带「提醒时间」的便利贴（提醒事项/会议类）到点会弹系统通知，点击通知聚焦该条。

## 备份

设置页 →「备份导入」：选择导出的 JSON 文件恢复（覆盖当前数据）。Markdown 导出用于阅读/归档。

## 数据存储

| 层 | 介质 | 角色 |
|----|------|------|
| 主存储 | `chrome.storage.local` | 唯一可信源 |
| 本地文件 | File System Access API | 镜像（`.md`） |
| 云 | Notion API | 镜像（database 行） |
| 备份 | `chrome.downloads` | JSON/Markdown 文件 |

## 目录结构

```text
extension/
├── manifest.json          # MV3 清单
├── background.js          # SW：消息路由 / Notion / alarms / downloads
├── sidepanel.{html,js,css}# 主操作面
├── popup.{html,js,css}    # 快速查看
├── options.{html,js,css}  # 设置页
├── lib/
│   ├── store.js           # chrome.storage CRUD / 排序 / 提醒
│   ├── fs.js              # File System Access 封装 + 全量同步清理
│   ├── notion.js          # Notion API 客户端 + schema 适配
│   ├── categories.js      # 15 分类定义
│   └── idb.js             # IndexedDB（存目录句柄）
└── icons/                 # 16/48/128 PNG
```

## 开发与回归

```powershell
# 根目录执行静态检查（含跨扩展白名单一致性）
node scripts/check.mjs

# 便利贴相关回归
node tests/folder-sync.test.mjs
node tests/notion-properties.test.mjs
node tests/manifest.test.mjs
```
