# Lull Media Service 与音乐资料库

> 状态：P0 + P1 + P2 + N1 + P3 + N2 + N3 + N3.5 + N4 已落地（SQLite 曲库、扫描进度/取消、封面/歌词资产、完整列表筛选、revision/`media:event`、隐藏音频引擎、播放/队列、官方播放器迁移、Shared AudioGraph/engine protocol v2/全局输出音量、订阅与快照基础、歌单/喜欢/历史、M3U 导入导出与资料库窗口、Noise Asset/Track/Session 与旧 5 层兼容门面、Noise 本地素材导入/分类/标签/收藏/搜索/缺失检测、分类/标签独立 CRUD、Preset 保存/加载/导入导出/缺失映射）。第三方开放按阶段推进；Noise 决策见 [Noise RFC](Lull%20Noise%20Service%20技术设计%20RFC.md)。

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
 ├─ playback / queue / noise（P2 旧 5 层）
 ├─ output：全局输出音量
 ├─ events / snapshot：订阅、revision 与组合快照
 ├─ noise：Asset / Track / Session / Preset（N2+）
 └─ playlists / favorites / history / tags（P3/P4）
        │
        └─ Media Engine（隐藏 media-engine WebView：Shared AudioGraph = musicBus + noiseBus + master + limiter）
```

- **Music Library 与 Playback 分离**：关闭播放器不影响曲库；P1 的曲库先独立可用。
- **Rust 是数据权威**：前端不扫描文件、不解析标签、不直接读 SQLite。
- **官方与第三方共用业务接口**：官方走 Tauri；第三方后续走宿主壳桥，不直接拿 Tauri IPC。
- **`media::video` 仍是视频壁纸运行时**；本服务是 `media::library` / `api` / `repository`，不要把两者混用。
- **只读用户文件**：扫描不改标签、不移动、不删除；数据库只存索引与元数据。

## 2. 数据库

- 路径：`%APPDATA%\app.lull.desktop\music\music.db`；`LULL_MUSIC_DIR` 可覆盖。
- SQLite WAL、`foreign_keys=ON`、`busy_timeout=5s`；SQLx migration 编译期嵌入。
- 迁移：`0001_library.sql`、`0002_search_fts.sql`、`0003_playback.sql`、`0004_library_filters.sql`、`0005_media_output.sql`、`0006_library_p3.sql`、`0007_noise.sql`。
- 播放状态：`player_state`（当前曲目/进度/音量/模式）、`player_queue`（Track 引用顺序）、`noise_state`（旧五层，仅保留作回滚/一次性偏好迁移）。进度每 250ms 只走内存与事件，暂停/停止/切歌/退出才落盘。
- 输出音量：`media_output` 单行表保存 Music + Noise 共享的 master output volume；与 `player.volume`、Noise master、Windows 系统音量分离。
- 歌单/喜欢/历史：`music_playlists`、`music_playlist_tracks`（只存 Track 引用与顺序）、`music_favorites`、`music_play_history`（按播放尝试记录，最多保留 2000 条）。
- Noise：`noise_sources`、`noise_assets`、`noise_categories`、`noise_tags`、`noise_asset_tags`、`noise_favorites`、`noise_presets`、`noise_preset_tracks`、`noise_preset_favorites`、`noise_preferences`；N2 seed builtin procedural Asset 与默认/示例 Preset，N3 把本地文件复制到 `<music>/noise/assets/<sha256>.<ext>` 后写 Asset；Session/Track 仍不落盘。
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
| `playlists.list` / `get` / `create` / `update` / `delete` | `playlistId`, `name`, `description` | `PlaylistSummary[]` / `PlaylistDetail` |
| `playlists.addTrack` / `removeTrack` / `reorder` | `playlistId`, `trackId`, `position` | `{ok}` / `{removed}` / `{moved}` |
| `playlists.importM3u` / `exportM3u` | `playlistId?` | `M3uImportResult` / `M3uExportResult`（仅 settings/library） |
| `favorites.list` / `set` | `page`, `pageSize`, `trackId`, `favorite` | `Page<TrackSummary>` / `FavoriteView` |
| `history.list` / `clear` | `page`, `pageSize` | `Page<HistoryEntry>` / `{cleared}` |
| `noise.getState` / `getSounds` / `activate` / `setLayer` / `setMaster` / `setMuted` / `setSleepTimer` / `reset` | `soundId`, `enabled`, `volume`, `minutes` | `NoiseState`（旧 5 层兼容） |
| `noise.getSession` / `createSession` / `playSession` / `pauseSession` / `stopSession` | — | `NoiseSession` |
| `noise.setSessionVolume` / `setSessionMuted` / `setSessionSleepTimer` | `volume`, `muted`, `minutes` | `NoiseSession` |
| `noise.addTrack` | `assetId` | `NoiseTrack` |
| `noise.removeTrack` / `setTrackVolume` / `setTrackEnabled` / `setTrackLoop` / `reorderTracks` | `trackId`, `volume`, `enabled`, `loop`, `position` | `NoiseSession` |
| `noise.library.listAssets` / `getAsset` / `getCategories` / `getTags` | `keyword`, `categoryId`, `tagId`, `favoriteOnly`, `status`, `mediaKind`, `page`, `pageSize` | `Page<NoiseAsset>` / `NoiseAsset` / `NoiseCategory[]` / `NoiseTag[]` |
| `noise.library.importAssets` / `importFolder` / `revalidateAssets` | `paths?`, `path?`, `categoryId?`, `tagIds?` | `NoiseImportResult` / `NoiseRevalidateResult`（仅 settings） |
| `noise.library.updateAsset` / `removeAsset` | `assetId`, `name?`, `description?`, `categoryId?`, `tagIds?` | `NoiseAsset` / `{removed}`（仅 settings；内置 Asset 不可改删） |
| `noise.library.createCategory` / `updateCategory` / `deleteCategory` | `name`, `parentId?`, `icon?`, `sortOrder?` | `NoiseCategory` / `{removed}`（仅 settings；内置分类不可改删） |
| `noise.library.createTag` / `updateTag` / `deleteTag` | `name` | `NoiseTag` / `{removed}`（仅 settings；内置标签不可改删） |
| `noise.library.setAssetFavorite` | `assetId`, `favorite` | `NoiseAsset` |
| `noise.presets.listPresets` / `getPreset` | `keyword`, `sourceType`, `favoriteOnly`, `page` | `Page<NoisePresetSummary>` / `NoisePresetDetail` |
| `noise.presets.savePreset` / `updatePreset` / `deletePreset` | `name`, `description?`, `cover?`, `presetId` | `NoisePresetDetail` / `{removed}`（内置 Preset 不可改删） |
| `noise.presets.loadPreset` / `mapPresetTrack` | `presetId`, `presetTrackId`, `assetId` | `NoisePresetLoadResult` / `NoisePresetDetail` |
| `noise.presets.importPreset` / `exportPreset` | `path?` | `NoisePresetDetail` / `NoisePresetExportResult`（仅 settings） |
| `noise.presets.setPresetFavorite` | `presetId`, `favorite` | `NoisePresetSummary` |
| `system.snapshot` | `{}` | `PlaybackSnapshot`（含 `output` / `noiseSession`） |
| `system.getOutput` / `setOutput` | `volume?`, `muted?` | `MediaOutput` |

约定：

- 结果不含 `path/storage_key` 之外的文件系统细节；`rootPath` 只给 host 设置窗。
- 错误用 `{code,message,details?}`；前端按 `code` 分支。
- `media_connect({topics,progressMs,levels})` 原子注册订阅并返回 `PlaybackSnapshot`；事件 envelope 为 `{protocol,topic,revision,at,eventId,payload}`。顶层 revision 取 Player/Output/Noise 最大值；过滤事件时用各自 domain 的 revision（如 `snapshot.player.revision` / `snapshot.noise.revision`），不要用顶层值。
- 资料库事件也走 `media:event`：`library.changed`、`library.scan.started`、`library.scan.progress`、`library.scan.finished`；Noise 素材库变更发 `noise.library.changed`。`app_meta.revision` 持久化，列表响应同时带 revision。
- 播放状态事件发完整 `PlayerState`；进度/电平只发给订阅窗口；音频电平最高 20Hz。
- 引擎窗口只接收 `media-engine-command`，通过 `media_engine_ready/event` 上报；命令携带 `loadId`，旧加载事件被丢弃。N1 起 engine protocol 为 v2，Music 与 Noise 共用 `AudioGraph`（musicBus/noiseBus/master/limiter），并支持 `output.volume` 与 `engine.shutdown`；N2 起 Noise 用 `noise.session.sync` 下发完整 Session/Track 快照，N3 文件轨道的 `source.kind=asset` 通过 asset protocol URL 进入同一 `noiseBus`。
- 本地音频经 Tauri asset protocol 进入引擎；`<audio>` 必须设置 `crossOrigin="anonymous"`，asset protocol 返回的 `Access-Control-Allow-Origin` 才能让 `MediaElementAudioSourceNode` 输出非静音。缺少 CORS opt-in 时元素可直出，但接入 Web Audio 后会静音。

## 4. 前端 SDK

`packages/media-sdk`（Apache-2.0）：

- `createMediaClient({ transport? })`：Tauri 环境自动使用 `media_call` / `media_connect`；测试传内存 transport。
- `library.*`（含 scan progress/cancel、cover URL、genre/filter 参数）、`player.*`、`queue.*`、`playlists.*`、`favorites.*`、`history.*`、`noise.*`（含 `noise.session.*` / `noise.tracks.*` / `noise.library.*` / `noise.presets.*`）、`system.getOutput/setOutput`、`connect/disconnect`、`events.on`。
- `@lull/media-sdk/react`：`LullMediaProvider` / `useMediaClient`。
- `@lull/media-sdk/testing`：`createMemoryTransport`。
- 设置页音乐库面板、官方播放器、白噪音与资料库窗口都只通过 SDK/Media Service 访问；不直接 `invoke`、不自己创建音频图。资料库窗口（label `library`）包含曲库/歌单/喜欢/历史/队列五页。

P5 扩展：`./widget`（宿主壳 transport）、`./vue`、查询缓存与公开文档。

## 5. 安全与隐私

- `media_call` 仅 `settings/player/noise/library`；引擎命令仅 `media-engine`；`window-widgets` 仍未获得媒体命令。`library` 可管理歌单/收藏/历史/队列与读取 Noise Library，但 Noise 导入/编辑/删除/缺失检查仍只允许设置窗。
- 第三方后续能力见 `docs/widget-sdk.md` 规划：`media.library.read/search/scan/edit`、`media.playlists.*`、`media.favorites.*`、`media.tags.*`、`media.history.read`、`media.player.*`、`media.queue.*`、`media.noise.*`。
- 添加/移除音乐目录只允许 host；第三方只能重扫已授权来源，永远拿不到根路径或音频源。
- 音频播放源只在宿主引擎内部解析；DTO/事件不传文件路径。
- 扫描只读；文件解析失败回退文件名，不阻断整次扫描。
- 全局 Chromium 参数关闭自动播放限制与后台定时器节流，供隐藏引擎使用；所有 WebView 必须共用同一份参数。

## 6. 当前限制

- 扫描每个文件一个小事务；取消只在文件之间生效，大文件解析期间不会立即中断。
- 已接入内嵌/文件夹封面与内嵌/同名 `.lrc` 歌词；歌词 UI、文件移动检测、`.lullignore` 尚未接入。
- `library.listTracks` 已支持艺术家/专辑/流派(genre)/格式/年份筛选；完整标签实体、多值标签与 P4 元数据编辑仍在后续。
- 播放/队列/白噪音已迁移到 Media Service；N1 起统一走共享 `AudioGraph`（本地音频 `MediaElementAudioSource`、内置曲 `AmbientStream`、Noise `noiseBus`），不再各自建 `AudioContext`。播放器队列 UI 仍未内置到播放器窗口；P3 在资料库窗口提供队列视图与移出/播放操作。
- P3 已支持歌单、喜欢、历史与 M3U 导入导出；本地音频元素已设置 `crossOrigin="anonymous"`，以配合 asset protocol 的 CORS 让 `MediaElementAudioSourceNode` 正常输出。
- N2 起 Noise 使用独立 `NoiseSession`/`NoiseTrack` 运行时；旧 5 层 `noise.*` 由兼容门面映射到同一 Session。Session/Track 不持久化，退出即停止；只保存 master/muted 等偏好。睡眠定时到点会暂停 Session（保留 muted 偏好），不会自动恢复播放。
- N3 的 Noise 本地素材在导入时复制到受管目录并流式 SHA-256；支持 `mp3/flac/wav/ogg/m4a/aac`、单文件 100 MB/30 分钟上限，重复 hash 返回已有 Asset。文件播放走 `<audio>` + `MediaElementAudioSourceNode`，缺失文件由 `revalidateAssets` 标记，不每次打开全量重算 hash。
- N3.5 起分类/标签有用户 CRUD：内置分类/标签只读，用户分类支持父子层级与循环保护，同名分类（同父级）和同名标签（跨内置/用户）拒绝；删除分类把素材置为未分类且子分类存在时拒绝删除，删除标签级联移除素材关联。
- N4 起 Preset 保存当前 Session 的 Asset 引用/哈希/名称/音量/loop/fade 快照，不含音频、脚本或路径；加载替换 Session 与 master 但不自动播放，缺失轨道返回 candidates，可 `mapPresetTrack` 后重载。`.lull-noise.json` 导入生成新本地 ID，原 ID 存 `origin_id`，同来源不自动覆盖。
- 设备切换依赖 `devicechange` 重载引擎页 + Rust 全量 resync；多设备选择、独占模式、SMTC 尚未接入。
- 没有第三方媒体权限；`media:event` 只对官方窗口开放。
- 扫描错误最多保留 100 条，写入 `music_scan_runs.errors_json`。

## 7. 阶段

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | `media/video` 迁移、SQLx/lofty 依赖、迁移骨架 | 已完成基础 |
| P1 | 来源/文件/Track/艺术家/专辑、扫描、只读 API、SDK 基础、设置面板 | 已完成（含资产、筛选、扫描进度/取消、revision/事件） |
| P2 | Playback/Queue/Noise 服务、隐藏音频引擎、官方播放器/白噪音迁移 | 已完成，待长稳/多设备验收 |
| N1（P2.5） | Shared AudioGraph、engine protocol v2、全局输出音量、订阅/快照基础 | 代码已落地，待长稳/设备验收 |
| P3 | 歌单/喜欢/历史、M3U、资料库窗口 | 代码已落地，待手工验收 |
| N2 | Noise Core：Session/Track、内置 procedural Asset、旧 API 兼容门面 | 代码已落地，待手工验收 |
| N3 | Noise Library：导入、分类、标签、收藏、搜索、缺失检测 | 代码已落地，待手工验收 |
| N3.5 | Noise Taxonomy：分类/标签独立 CRUD、层级循环保护、内置只读 | 代码已落地，待手工验收 |
| N4 | Noise Presets：保存/加载/导入/导出、缺失映射 | 代码已落地，待手工验收 |
| P4 | 元数据编辑、标签、实体合并/拆分、智能歌单 | 未开始 |
| N5/P5 | 公开 Media SDK、Widget 桥、媒体权限、示例 | 未开始 |
| N6 | 官方 Noise Mixer/Library/Preset UI | 未开始 |
| P6 | 在线元数据、歌词格式、监听、缩略图、备份 | 未开始 |

推荐顺序：`N1 → P3 → N2 → N3 → N4 → N5/P5 → N6 → P4 → P6`。N1 必须先于 Noise；P3 与 N2 可互换；N5/P5 必须等 P3 与 N4。

### 7.1 手工验收（开发调试）

设置窗新增「媒体测试」页签（`components/settings/media-api-test-panel.tsx`），它直接调用 `@lull/media-sdk` 并显示 API 结果与 `media:event`，用于验收：

- 添加音乐文件夹并扫描，得到可测试曲目；
- 新建/重命名/删除歌单，加入/移除/排序曲目；
- 收藏、清空历史、播放后确认 `history.changed` 与历史列表；
- 队列播放/移出后确认 `player.state` / `queue.changed` 刷新；
- 导入/导出 M3U，检查导入匹配与导出文件内容；
- 打开/关闭「音乐库」窗口，确认关闭后播放继续、重开恢复队列与列表。

该页签是调试工具，不是正式资料库 UI；正式界面是 `library` 窗口。

设置窗另有「白噪音测试」页签（`components/settings/noise-api-test-panel.tsx`），用于 N2 手工验收：

- 读取/切换 `noise.session.*` 状态，新建、播放、暂停、停止；
- 按内置 profile 或 Asset ID 添加音轨，调整音量/enabled/loop/顺序并移除；
- 调 master/muted/睡眠，观察 `noise.state`、`noise.session.changed`、`noise.track.*`、`noise.level`；
- 用旧 5 层 `noise.*` 控件修改同一 Session，确认与新 API、引擎听感一致；
- 查看 `PlaybackSnapshot` 的 player/noise/session revision，确认客户端按 domain revision 过滤事件。

该页签同样只是调试工具，不是 N6 的正式 Mixer/Library/Preset UI。

## 8. 设计参考

Folia（AGPL-3.0）的本地曲库文档与领域模型提供了重要设计参考：文件与 Track 分离、实体/关系分离、导入/在线/人工来源保护、内容寻址封面、歌单只存引用、增量扫描、合并/拆分保留别名。本实现只借鉴设计，不复用其代码或 SQL；如未来复用任何片段，先做许可证评估。
