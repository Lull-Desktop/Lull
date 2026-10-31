# Lull Media Service 与音乐资料库

> 状态：P0 + P1 基础已落地（模块边界、SQLite 迁移、SQLx 仓储、lofty 扫描、只读 Media API、`@lull/media-sdk` 基础、设置页音乐库面板）。播放/队列、白噪音、歌单/喜欢/历史、标签与第三方开放按阶段推进。

## 1. 边界

```text
官方播放器 / 白噪音 / 资料库 UI
第三方 Widget（后续）
        │  @lull/media-sdk
        ▼
Media API（protocol 1，media_call）
        ▼
Media Service（Rust）
 ├─ library：来源 / 文件 / 曲目 / 艺术家 / 专辑 / 扫描
 ├─ repository：SQLx + SQLite
 ├─ playback / queue / noise（P2）
 └─ playlists / favorites / history / tags（P3/P4）
        │
        └─ Media Engine（P2：隐藏 media-engine WebView；后续可换原生）
```

- **Music Library 与 Playback 分离**：关闭播放器不影响曲库；P1 的曲库先独立可用。
- **Rust 是数据权威**：前端不扫描文件、不解析标签、不直接读 SQLite。
- **官方与第三方共用业务接口**：官方走 Tauri；第三方后续走宿主壳桥，不直接拿 Tauri IPC。
- **`media::video` 仍是视频壁纸运行时**；本服务是 `media::library` / `api` / `repository`，不要把两者混用。
- **只读用户文件**：扫描不改标签、不移动、不删除；数据库只存索引与元数据。

## 2. 数据库

- 路径：`%APPDATA%\app.lull.desktop\music\music.db`；`LULL_MUSIC_DIR` 可覆盖。
- SQLite WAL、`foreign_keys=ON`、`busy_timeout=5s`；SQLx migration 编译期嵌入。
- 迁移：`src-tauri/migrations/0001_library.sql`、`0002_search_fts.sql`。
- 核心表：
  - `music_sources`：本地/内置来源；`root_path` 不返回第三方。
  - `music_folders`、`music_files`：磁盘目录与真实文件；文件按 `source_id + path_key` 唯一。
  - `music_tracks`：可播放实体；`kind=file|builtin`；一个 Track 可有多个文件。
  - `music_artists` / `music_albums` + aliases：稳定实体，支持后续合并/拆分。
  - `music_track_artists` / `music_track_albums`：多艺术家、多角色、专辑关系与来源。
  - `music_track_metadata` / `music_field_sources`：导入快照、规范化、用户覆盖、逐字段来源。
  - `music_assets` / `music_track_assets` / `music_lyrics`：内容寻址封面与歌词（P1 已建表，扫描侧逐步接入）。
  - `music_scan_runs`、`music_search_text`、`app_meta`。
- 搜索：`music_search_text` 保存标题/艺术家/专辑/文件名，`music_search_fts`（FTS5 trigram）由触发器同步；>=3 字符走 FTS，1–2 字符/无法匹配时回退 `LIKE`。SQLite 构建已确认启用 `ENABLE_FTS5`（见 `db.rs` 测试输出）。
- 元数据优先级（P4 完整实现）：用户覆盖 > 已确认在线匹配 > 规范化本地标签 > 文件名推断；普通重扫不覆盖 `manual/split/online` 字段。
- 内置氛围曲已从 `src-tauri/src/media/library/catalog.json` 幂等 seed：`music_sources(kind=builtin)` + `music_tracks(kind=builtin, playback_preset_json)`，ID 与旧 `ONLINE_TRACKS` 保持一致。

## 3. 当前 Media API（P1）

命令：`media_call({ request })`，P1 仅 `settings` 窗口可调用。

```ts
{
  protocol: 1,
  requestId: string,
  namespace: "library",
  method: string,
  args?: unknown
}
```

已实现方法：

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `library.listSources` | `{}` | `SourceView[]` |
| `library.addSource` | `{}` | `SourceView \| null`（系统目录选择器） |
| `library.removeSource` | `{sourceId}` | `{removed: boolean}` |
| `library.startScan` | `{sourceId}` | `ScanJobView`（立即返回，扫描后台执行） |
| `library.listTracks` | `{keyword?, sourceIds?, page?, pageSize?, sortBy?, sortOrder?, includeUnavailable?}` | `Page<TrackSummary>` |
| `library.getTrack` | `{trackId}` | `TrackDetail`（含文件格式/码率与元数据 JSON，不含路径） |
| `library.listArtists` | `{}` | `ArtistSummary[]` |
| `library.listAlbums` | `{}` | `AlbumSummary[]` |

约定：

- 结果不含 `path/root_path` 之外的文件系统细节；`rootPath` 只给当前 host 设置窗。
- 错误用 `{code,message,details?}`；前端按 `code` 分支。
- 扫描完成/来源变化通过 Tauri 事件 `library-changed` 通知；P2 增加带 revision 的 `media:event` 总线、快照与订阅。
- 当前 `revision=0`；P2 接入全局 revision 与 `connect` 快照。

## 4. 前端 SDK

`packages/media-sdk`（Apache-2.0）：

- `createMediaClient({ transport? })`：Tauri 环境自动使用 `media_call`；测试传内存 transport。
- `library.listSources/addSource/removeSource/startScan/listTracks/getTrack/listArtists/listAlbums`。
- `@lull/media-sdk/react`：`LullMediaProvider` / `useMediaClient`。
- `@lull/media-sdk/testing`：`createMemoryTransport`。
- 设置页 `src/components/settings/music-library-panel.tsx` 只通过 SDK 访问；不直接 `invoke`。

P2/P5 扩展：播放/队列/白噪音、`./widget`（宿主壳 transport）、`./vue`、事件订阅与查询缓存。

## 5. 安全与隐私

- P1 `media_call` 只允许 `settings`；`window-widgets` 未获得媒体命令。
- 第三方后续能力见 `docs/widget-sdk.md` 规划：`media.library.read/search/scan/edit`、`media.playlists.*`、`media.favorites.*`、`media.tags.*`、`media.history.read`、`media.player.*`、`media.queue.*`、`media.noise.*`。
- 添加/移除音乐目录只允许 host；第三方只能重扫已授权来源，永远拿不到根路径或音频源。
- 音频播放源只在宿主引擎内部解析；DTO/事件不传文件路径。
- 扫描只读；文件解析失败回退文件名，不阻断整次扫描。
- 扫描任务目前是单进程内后台任务，尚未支持取消/进度明细；P1 的 UI 通过轮询来源状态刷新，P2 接入 `library.scan.progress`。

## 6. 当前限制

- 扫描每个文件一个小事务，未做批量事务与取消；大库需要 P2 优化。
- 尚未接入封面/歌词资产写入、文件移动检测、`.lullignore`。
- `library.listTracks` 只实现关键词/来源/分页/基础排序；艺术家/专辑/标签/格式/年份筛选在 P3/P4 补。
- 播放器/白噪音仍走旧 React Web Audio；P2 才迁移到 Media Service。
- 没有第三方媒体权限；没有事件快照/订阅。
- 扫描错误最多保留 100 条，写入 `music_scan_runs.errors_json`。

## 7. 阶段

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | `media/video` 迁移、SQLx/lofty 依赖、迁移骨架 | 已完成基础 |
| P1 | 来源/文件/Track/艺术家/专辑、扫描、只读 API、SDK 基础、设置面板 | 基础已落地，待补资产/FTS/筛选 |
| P2 | Playback/Queue/Noise 服务、隐藏音频引擎、官方播放器/白噪音迁移 | 未开始 |
| P3 | 歌单/喜欢/历史、M3U、资料库窗口 | 未开始 |
| P4 | 元数据编辑、标签、实体合并/拆分、智能歌单 | 未开始 |
| P5 | 公开 SDK、Widget 桥、权限、示例 | 未开始 |
| P6 | 在线元数据、歌词格式、监听、缩略图、备份 | 未开始 |

## 8. 设计参考

Folia（AGPL-3.0）的本地曲库文档与领域模型提供了重要设计参考：文件与 Track 分离、实体/关系分离、导入/在线/人工来源保护、内容寻址封面、歌单只存引用、增量扫描、合并/拆分保留别名。本实现只借鉴设计，不复用其代码或 SQL；如未来复用任何片段，先做许可证评估。
