# 程序员便利贴（浏览器扩展）

一个 Manifest V3 浏览器扩展，用便利贴形式记录程序员日常工作信息：测试/正式环境网址、测试账号、需求清单、缺陷修复、BUG 记录、网址链接、提醒事项、开会时间地点。

支持本地文件夹实时同步 + Notion 云同步，跨设备获取。

## 加载扩展（开发模式）

1. 打开 Chrome / Edge：`chrome://extensions`
2. 右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择本目录 `extension/`
4. 工具栏出现 📌 图标，点击打开侧边栏

> 要求 Chrome 114+（Side Panel API）。

## 使用

- **侧边栏（主操作面）**：点图标打开。顶部分类 tab 筛选 + 搜索；「+ 新建」创建便利贴；卡片点击编辑。
- **Popup（快速查看）**：在未配置侧边栏自动打开时，点图标弹出精简列表；点「⇱ 侧边栏」打开常驻面板。
- **底栏**：导出（JSON 可恢复 / Markdown 可读）、同步 Notion、设置。

## 本地文件夹同步

设置页 →「绑定文件夹」选择一个目录。绑定后：

- 每条便利贴保存为 `<文件夹>/<分类key>/<id>.md`
- 增删改实时同步到文件
- 「立即同步全部到文件夹」可对齐整棵目录

> 文件夹未绑定时该功能静默跳过，不影响主数据。

## Notion 云同步

设置页 →「Notion 云同步」：

1. 访问 https://www.notion.so/my-integrations 创建 integration，复制 `secret_xxx` token
2. 在 Notion 新建 database，列设为：
   - `Title`(title)、`Category`(select)、`Content`(rich_text)、`URL`(url)
   - `RemindAt`(date)、`Pinned`(checkbox)、`NoteID`(rich_text)
3. 把该 database 页面「分享」给刚才创建的 integration
4. 复制 database URL 末段 ID，与 token 一起填入设置页
5. 点「测试连接」确认

侧边栏「🔄 同步」：1=推送本地到 Notion，2=从 Notion 拉取（覆盖本地）。

## 提醒事项

带「提醒时间」的便利贴（提醒事项/会议类）到点会弹系统通知，点击通知聚焦该条。

## 备份

设置页 →「备份导入」：选择导出的 JSON 文件恢复（覆盖当前数据）。

## 数据存储

| 层 | 介质 | 角色 |
|----|------|------|
| 主存储 | chrome.storage.local | 唯一可信源 |
| 本地文件 | File System Access API | 镜像（.md） |
| 云 | Notion API | 镜像（database 行） |
| 备份 | chrome.downloads | JSON/Markdown 文件 |

## 目录结构

```
extension/
├── manifest.json          # MV3 清单
├── background.js          # service worker：消息路由/Notion/alarms/downloads
├── sidepanel.{html,js,css}# 主操作面
├── popup.{html,js,css}    # 快速查看
├── options.{html,js,css}  # 设置页
├── lib/
│   ├── store.js           # chrome.storage CRUD
│   ├── fs.js              # File System Access 封装
│   ├── notion.js          # Notion API 客户端
│   ├── categories.js      # 9 分类定义
│   └── idb.js             # IndexedDB（存目录句柄）
└── icons/                 # 16/48/128 PNG
```
