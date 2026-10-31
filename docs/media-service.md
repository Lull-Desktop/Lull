# Lull Media Service 与音乐资料库

> 状态：P0 + P1 + P2 已落地（SQLite 曲库、扫描进度/取消、封面/歌词资产、完整列表筛选、revision/`media:event`、隐藏音频引擎、播放/队列/白噪音、官方播放器与白噪音迁移）。歌单/喜欢/历史、标签实体、第三方开放按阶段推进。

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
 ├─ playback / queue / noise（P2 已落地）
 └─ playlists / favorites / history / tags（P3/P4）
        │
        └─ Media Engine（隐藏 media-engine WebView：AmbientStream / <audio> / 噪声混音）
```

- **Music Library 与 Playback 分离**：关闭播放器不影响曲库；P1 的曲库先独立可用。
- **Rust 是数据权威**：前端不扫描文件、不解析标签、不直接读 SQLite。
- **官方与第三方共用业务接口**：官方走 Tauri；第三方后续走宿主壳桥，不直接拿 Tauri IPC。
- **`media::video` 仍是视频壁纸运行时**；本服务是 `media::library` / `api` / `repository`，不要把两者混用。
- **只读用户文件**：扫描不改标签、不移动、不删除；数据库只存索引与元数据。

## 2. 数据库

- 路径：`%APPDATA%\app.lull.desktop\music\music.db`；`LULL_MUSIC_DIR` 可覆盖。
- SQLite WAL、`foreign_keys=ON`、`busy_timeout=5s`；SQLx migration 编译期嵌入。
- 迁移：`0001_library.sql`、`0002_search_fts.sql`、`0003_playback.sql`、`0004_library_filters.sql`。
- 播放状态：`player_state`（当前曲目/进度/音量/模式）、`player_queue`（Track 引用顺序）、`noise_state`（五层/主音量/睡眠）。进度每 250ms 只走内存与事件，暂停/停止/切歌/退出才落盘。
- 封面/歌词：`music/assets/` 下按 SHA-256 内容寻址保存二进制；`music_assets.storage_key` 只存文件名，`music_track_assets` 关联主封面，`music_lyrics` 存内嵌/同名 `.lrc` 文本。扫描只读用户文件，资产是 Lull 副本。
- 核心表：
  - `music_sources`：本地/内置来源；`root_path` 不返回第三方。
  - `music_folders`、`music_files`：磁盘目录与真实文件；文件按 `source_id + path_key` 唯一。
  - `music_tracks`：可播放实体；`kind=file|builtin`；一个 Track 可有多个文件。
  - `music_artists` / `music_albums` + aliases：稳定实体，支持后续合并/拆分。
  - `music_track_artists` / `music_track_albums`：多艺术家、多角色、专辑关系与来源。
  - `music_track_metadata` / `music_field_sources`：导入快照、规范化、用户覆盖、逐字段来源。
  - `music_assets` / `music_track_assets` / `music_lyrics`：内容寻址封面与歌词；已接入内嵌封面、文件夹封面、内嵌歌词与同名 `.lrc`。
  - `music_scan_runs`、`music_search_text`、`app_meta`。
- 搜索：`music_search_text` 保存标题/艺术家/专辑/文件名，`music_search_fts`（FTS5 trigram）由触发器同步；>=3 字符走 FTS，1–2 字符/无法匹配时回退 `LIKE`。SQLite 构建已确认启用 `ENABLE_FTS5`（见 `db.rs` 测试输出）。
- 元数据优先级（P4 完整实现）：用户覆盖 > 已确认在线匹配 > 规范化本地标签 > 文件名推断；普通重扫不覆盖 `manual/split/online` 字段。
- 内置氛围曲已从 `src-tauri/src/media/library/catalog.json` 幂等 seed：`music_sources(kind=builtin)` + `music_tracks(kind=builtin, playback_preset_json)`，ID 与旧 `ONLINE_TRACKS` 保持一致。

## 3. 当前 Media API（P1 + P2）

命令：`media_call({ request })`；`settings` 可访问全部，`player`/`noise` 可访问播放/队列/噪声与资料库读取。`media_connect` 注册订阅并返回快照，事件走 `media:event`。

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
| `library.cancelScan` | `{sourceId}` | `{cancelled: boolean}` |
| `library.listTracks` | `{keyword?, sourceIds?, artistId?, albumId?, genre?, format?, year?, yearFrom?, yearTo?, page?, pageSize?, sortBy?, sortOrder?, includeUnavailable?}` | `Page<TrackSummary>` |
| `library.getTrack` | `{trackId}` | `TrackDetail`（含文件格式/码率、元数据 JSON 与主歌词，不含路径） |
| `library.getCoverUrl` | `{trackId}` | `{url: string \| null}`（仅官方窗口） |
| `library.listArtists` | `{}` | `ArtistSummary[]` |
| `library.listAlbums` | `{}` | `AlbumSummary[]` |
| `library.listGenres` | `{}` | `string[]` |
| `player.getState` / `play` / `pause` / `resume` / `stop` / `seek` / `next` / `previous` | `trackId?`, `positionMs` | `PlayerState` |
| `player.setVolume` / `setMuted` / `setMode` | `volume`, `muted`, `mode` | `PlayerState` |
| `queue.get` / `add` / `remove` / `clear` / `move` / `playAt` | `trackId`, `index` | `QueueState` / `PlayerState` |
| `noise.getState` / `getSounds` / `activate` / `setLayer` / `setMaster` / `setMuted` / `setSleepTimer` / `reset` | `soundId`, `enabled`, `volume`, `minutes` | `NoiseState` |
| `system.snapshot` | `{}` | `PlaybackSnapshot` |

约定：

- 结果不含 `path/storage_key` 之外的文件系统细节；`rootPath` 只给 host 设置窗。
- 错误用 `{code,message,details?}`；前端按 `code` 分支。
- `media_connect({topics,progressMs,levels})` 原子注册订阅并返回 `PlaybackSnapshot`；事件 envelope 为 `{protocol,topic,revision,at,payload}`。
- 资料库事件也走 `media:event`：`library.changed`、`library.scan.started`、`library.scan.progress`、`library.scan.finished`；`app_meta.revision` 持久化，列表响应同时带 revision。
- 播放状态事件发完整 `PlayerState`；进度/电平只发给订阅窗口；音频电平最高 20Hz。
- 引擎窗口只接收 `media-engine-command`，通过 `media_engine_ready/event` 上报；命令携带 `loadId`，旧加载事件被丢弃。

## 4. 前端 SDK

`packages/media-sdk`（Apache-2.0）：

- `createMediaClient({ transport? })`：Tauri 环境自动使用 `media_call` / `media_connect`；测试传内存 transport。
- `library.*`（含 scan progress/cancel、cover URL、genre/filter 参数）、`player.*`、`queue.*`、`noise.*`、`connect/disconnect`、`events.on`。
- `@lull/media-sdk/react`：`LullMediaProvider` / `useMediaClient`。
- `@lull/media-sdk/testing`：`createMemoryTransport`。
- 设置页音乐库面板、官方播放器与白噪音都只通过 SDK/Media Service 访问；不直接 `invoke`、不自己创建音频图。

P5 扩展：`./widget`（宿主壳 transport）、`./vue`、查询缓存与公开文档。

## 5. 安全与隐私

- `media_call` 仅 `settings/player/noise`；引擎命令仅 `media-engine`；`window-widgets` 仍未获得媒体命令。
- 第三方后续能力见 `docs/widget-sdk.md` 规划：`media.library.read/search/scan/edit`、`media.playlists.*`、`media.favorites.*`、`media.tags.*`、`media.history.read`、`media.player.*`、`media.queue.*`、`media.noise.*`。
- 添加/移除音乐目录只允许 host；第三方只能重扫已授权来源，永远拿不到根路径或音频源。
- 音频播放源只在宿主引擎内部解析；DTO/事件不传文件路径。
- 扫描只读；文件解析失败回退文件名，不阻断整次扫描。
- 全局 Chromium 参数关闭自动播放限制与后台定时器节流，供隐藏引擎使用；所有 WebView 必须共用同一份参数。

## 6. 当前限制

- 扫描每个文件一个小事务；取消只在文件之间生效，大文件解析期间不会立即中断。
- 已接入内嵌/文件夹封面与内嵌/同名 `.lrc` 歌词；歌词 UI、文件移动检测、`.lullignore` 尚未接入。
- `library.listTracks` 已支持艺术家/专辑/流派(genre)/格式/年份筛选；完整标签实体、多值标签与 P4 元数据编辑仍在后续。
- 播放/队列/白噪音已迁移到 Media Service；本地音频优先用 `captureStream` 分析电平，浏览器不支持时回退占位值；播放器队列 UI 尚未暴露。
- 没有第三方媒体权限；`media:event` 只对官方窗口开放。
- 扫描错误最多保留 100 条，写入 `music_scan_runs.errors_json`。
- 多设备音频输出切换、独占模式、系统媒体控制（SMTC）尚未接入。

## 7. 阶段

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | `media/video` 迁移、SQLx/lofty 依赖、迁移骨架 | 已完成基础 |
| P1 | 来源/文件/Track/艺术家/专辑、扫描、只读 API、SDK 基础、设置面板 | 已完成（含资产、筛选、扫描进度/取消、revision/事件） |
| P2 | Playback/Queue/Noise 服务、隐藏音频引擎、官方播放器/白噪音迁移 | 已完成，待长稳/多设备验收 |
| P3 | 歌单/喜欢/历史、M3U、资料库窗口 | 未开始 |
| P4 | 元数据编辑、标签、实体合并/拆分、智能歌单 | 未开始 |
| P5 | 公开 SDK、Widget 桥、权限、示例 | 未开始 |
| P6 | 在线元数据、歌词格式、监听、缩略图、备份 | 未开始 |

## 8. 设计参考

Folia（AGPL-3.0）的本地曲库文档与领域模型提供了重要设计参考：文件与 Track 分离、实体/关系分离、导入/在线/人工来源保护、内容寻址封面、歌单只存引用、增量扫描、合并/拆分保留别名。本实现只借鉴设计，不复用其代码或 SQL；如未来复用任何片段，先做许可证评估。
