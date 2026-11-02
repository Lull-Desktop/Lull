# Lull Media Service & Music Library 技术设计 RFC

> 状态：设计评审稿。P0 + P1 基础实现见 [Media Service](media-service.md)；本文保留架构决策与六部分设计摘要。

## 1. 目标与边界

把音乐资料库做成独立基础设施，而不是播放器的附属功能：

- Music Library 拥有文件、曲目、艺术家、专辑、元数据来源、标签、歌单、喜欢与历史。
- Playback 只负责当前播放、队列、进度、音量与播放历史写入。
- Noise 拥有声音层、混音与睡眠定时器，不强行套用 Track 模型。
- Media Engine 只负责实际发声；Media API/SDK 是唯一业务入口。

不做：独立服务器、拆仓库、HTTP API、在线曲库/账号/云同步（P6 可选）、写回用户文件标签、CUE 分轨、自动按标题合并曲目。

## 2. 总体架构

```text
Playback UI / Library UI / Third-party Widget
                  │  @lull/media-sdk
                  ▼
          Media API（protocol 1）
                  ▼
   Rust Media Service（library/playback/noise/playlists/permissions/events）
        ├─ SQLx Repository → SQLite music.db
        ├─ Asset Store（封面/歌词，内容寻址）
        └─ Media Engine（P2 隐藏 media-engine WebView；后续可换原生）
```

- 官方窗口直接走 Tauri；第三方走宿主壳的权限代理。
- Rust 持有数据与业务状态；前端只缓存与展示。
- 关闭/替换播放器 UI 不影响曲库、歌单、喜欢、标签与历史。
- `media::video` 仍是视频壁纸运行时，与音乐服务/`music.db` 完全分开。

## 3. 数据库

- SQLite + SQLx 0.8；WAL、foreign_keys、busy_timeout；migration 编译期嵌入。
- 物理目录与曲目：`music_sources(kind='local')` 直接作为 MusicFolder（root_path 唯一、recursive、状态、最近扫描）；`music_tracks` 用 `folder_id + relative_path` 指向真实文件，文件元数据直接存在 Track 上。一个物理文件只对应一条 Track，不再有 `music_files` 中间层；默认/内置曲库已移除，`music_tracks` 只保存用户导入目录中的文件。
- 艺术家/专辑是稳定实体，关系单独存储；合并保留 `merged_into_id` 与别名。
- `music_track_metadata` 保存导入/规范化/覆盖/在线快照；`music_field_sources` 记录逐字段来源。
- 封面/歌词内容寻址，数据库只存资产 ID 与 storage key；不暴露路径。
- 歌单只存 Track 引用与顺序；喜欢是独立表；历史按播放会话记录。
- 用户覆盖 > 已确认在线匹配 > 规范化本地标签 > 文件名推断；普通重扫不覆盖人工整理。
- 文件缺失先标记不可用，不立即删除 Track/歌单引用；提供显式清理。

## 4. Rust 后端

```text
src-tauri/src/media/
├─ api/          命令、DTO、协议、错误码
├─ library/      目录/曲目/实体、lofty 元数据、扫描
├─ repository/   SQLx 查询、迁移、播放/歌单仓储
├─ services/     播放、队列、歌单、喜欢、标签、历史、噪声（P2+）
├─ engine/       音频引擎协议与宿主窗口（P2）
├─ permissions/  窗口 label → 插件身份 → capability
├─ video/        既有视频壁纸运行时（P0 迁入）
└─ lifecycle.rs / config.rs / diagnostics.rs
```

- Service 负责事务、业务优先级、事件与 revision；Repository 只做 SQL。
- 扫描是后台任务：遍历 → 元数据 → 实体解析 → 资产/搜索 → 批事务 → 事件；可取消、可恢复。
- API 命令是薄壳：解析请求 → 权限 → Service → 响应；不写 SQL。
- 事件是主题化的完整快照或失效通知；revision 单调；订阅按窗口 label 定向发送。

## 5. Media API 与 SDK

- 业务域：`library`、`playlists`、`favorites`、`tags`、`history`、`player`、`queue`、`noise`、`system`。
- 查询在后端完成：关键词、艺术家/专辑/标签、歌单、喜欢、来源、格式、时长/年份、排序、分页。
- 事件：`library.changed`、`library.scan.progress`、`playlists.changed`、`favorites.changed`、`tags.changed`、`history.changed`、`player.*`、`queue.*`、`noise.*`。
- `@lull/media-sdk` 框架无关；官方用 Tauri transport，第三方用 Widget transport，单测用 memory transport；React/Vue 适配器只做绑定。
- 权限在 Rust 端按 `.grants.json` 校验；SDK 的 has() 只做体验。第三方永远拿不到路径、SQLite 或引擎实例。

## 6. 实施阶段

| 阶段 | 交付 |
| --- | --- |
| P0 | 模块迁移、依赖/迁移/验证、SDK 骨架 |
| P1 | 音乐库读取、扫描、设置面板、SDK 基础（当前基础） |
| P2 | 播放/队列/白噪音、隐藏音频引擎、官方 UI 迁移 |
| P3 | 歌单/喜欢/历史、M3U、资料库窗口 |
| P4 | 元数据编辑、标签、实体合并/拆分、智能歌单 |
| P5 | 公开 SDK、Widget 桥、权限、示例 |
| P6 | 在线匹配、更多歌词格式、监听、缩略图、备份 |

P4 状态（已落地，待手工验收）：

- `migrations/0008_music_p4.sql`：`music_tags` / `music_track_tags` / `music_smart_playlists`。
- `library.updateTrackMetadata` 写 `overrides_json` 与 `music_field_sources(source='manual')`，同步更新曲目/艺术家/专辑规范化字段；扫描器对 `manual/split/online` 字段跳过覆盖，人工标题重扫测试通过。
- 标签 CRUD、Track 多标签分配、`TrackQuery.tagId` 筛选；TrackSummary 返回 `tags`。
- 艺术家/专辑 `merge` / `split`：保留 `merged_into_id` 与别名，迁移选中 Track 关系。
- 智能歌单保存 `TrackQuery` 规则快照，`runSmartPlaylist` 读取时实时查询，不缓存结果。
- 资料库窗口：曲目行元数据/标签编辑弹窗、智能歌单页签（创建/运行/删除）；合并/拆分暂只提供 SDK/API。音乐库窗口新增「曲库整理」调试页签，直接驱动 P4 SDK 并显示原始返回。
- 验证：Rust 189 项、前端 270 项、typecheck/build/clippy/SDK checks 通过；真实曲库编辑/合并/拆分待手工验收。

P6 状态（部分落地，待手工验收）：

- 歌词 sidecar 支持 `.lrc` / `.txt` / `.srt`，按 lrc → txt → srt 优先级原样保存；内嵌歌词仍优先。
- `library.exportBackup` / `importBackup` 使用系统文件对话框，导出 JSON 仅含 Track ID 引用、歌单、喜欢、历史、标签、智能歌单；不含音频、路径或资产。导入按 Track ID 校验，缺失自动跳过；重复导入不重复喜欢/历史。
- 设置页音乐库面板新增“备份与恢复”入口。
- 在线元数据、文件监听与缩略图尚未实现。
- 验证：Rust 191 项、前端 270 项、typecheck/build/clippy/SDK checks 通过；真实备份恢复、跨曲库与歌词格式待手工验收。

### 设计参考与许可证

Folia（AGPL-3.0）的本地曲库文档和领域模型提供了设计参考：稳定实体、导入/在线/人工来源保护、内容寻址封面、歌单引用、增量扫描、合并/拆分保留别名。Lull 只借鉴设计，不复用 Folia 代码、SQL 或数据实现；若未来复用任何片段，先单独评估许可证义务。
