# Lull Media Service 与音乐资料库

> 状态：P0 + P1 + P2 + N1 + P3 + N2 + N3 + N3.5 + N4 + N5/P5 + N6 + P4 + P7 + P8 已落地；P6 部分落地（`.lrc/.txt/.srt` sidecar、组织数据备份/恢复），在线元数据、文件监听、缩略图未开始（SQLite 曲库、扫描进度/取消、封面/歌词资产、完整列表筛选、revision/`media:event`、隐藏音频引擎、播放/队列、官方播放器迁移、Shared AudioGraph/engine protocol v2/全局输出音量、订阅与快照基础、歌单/喜欢/历史、M3U 导入导出与资料库窗口、Noise Asset/Track/Session 与旧 5 层兼容门面、Noise 本地素材导入/分类/标签/收藏/搜索/缺失检测、分类/标签独立 CRUD、Preset 保存/加载/导入导出/缺失映射、Widget 媒体桥/bridge token/8 个 Noise capability/React hooks/示例、官方 Noise UI 动态轨道/Preset/本地轨、P4 元数据编辑/标签/实体合并拆分/智能歌单、P7 物理目录 1:N Track/`folders` API/我的目录与最近添加 UI、P8 移除默认曲库与在线氛围合成）。Noise 决策见 [Noise RFC](Lull%20Noise%20Service%20技术设计%20RFC.md)。

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
- 迁移：`0001_library.sql`、`0002_search_fts.sql`、`0003_playback.sql`、`0004_library_filters.sql`、`0005_media_output.sql`、`0006_library_p3.sql`、`0007_noise.sql`、`0008_music_p4.sql`、`0009_music_folders.sql`、`0010_remove_builtin_music.sql`。首次升级前会尽力生成 `music.db.pre-0010.bak`；0009 删除 `music_files` 并把文件字段并入 Track，0010 删除旧内置曲。
- 播放状态：`player_state`（当前曲目/进度/音量/模式）、`player_queue`（Track 引用顺序）、`noise_state`（旧五层，仅保留作回滚/一次性偏好迁移）。进度每 250ms 只走内存与事件，暂停/停止/切歌/退出才落盘。
- 输出音量：`media_output` 单行表保存 Music + Noise 共享的 master output volume；与 `player.volume`、Noise master、Windows 系统音量分离。
- 歌单/喜欢/历史：`music_playlists`、`music_playlist_tracks`（只存 Track 引用与顺序）、`music_favorites`、`music_play_history`（按播放尝试记录，最多保留 2000 条）。
- Noise：`noise_sources`、`noise_assets`、`noise_categories`、`noise_tags`、`noise_asset_tags`、`noise_favorites`、`noise_presets`、`noise_preset_tracks`、`noise_preset_favorites`、`noise_preferences`；N2 seed builtin procedural Asset 与默认/示例 Preset，N3 把本地文件复制到 `<music>/noise/assets/<sha256>.<ext>` 后写 Asset；Session/Track 仍不落盘。
- 封面/歌词：`music/assets/` 下按 SHA-256 内容寻址保存二进制；`music_assets.storage_key` 只存文件名，`music_track_assets` 关联主封面，`music_lyrics` 存内嵌/同名 `.lrc` 文本。扫描只读用户文件，资产是 Lull 副本。
- 核心表：
  - `music_sources`：本地音乐目录。`kind='local'` 的行就是对外的 **MusicFolder**（root_path 唯一、显示名、recursive、status、last_scan_at）；旧 `kind='builtin'` 来源已由 `0010_remove_builtin_music.sql` 清理。
  - `music_tracks`：可播放实体。一个物理文件只对应一条 Track；曲目直接持有 `folder_id`（指向 `music_sources.id`）、`relative_path` 与 `file_name/file_size/file_modified_at/format/bitrate/sample_rate`。默认/内置曲已移除，曲目全部来自用户导入的物理目录。
  - 旧的 `music_files` 中间层与虚拟 `music_folders` 表已在 `0009_music_folders.sql` 删除；绝对路径由 `source.root_path + track.relative_path` 计算，不再落库。
  - `music_artists` / `music_albums` + aliases：稳定实体，支持后续合并/拆分。
  - `music_track_artists` / `music_track_albums`：多艺术家、多角色、专辑关系与来源。
  - `music_track_metadata` / `music_field_sources`：导入快照、规范化、用户覆盖、逐字段来源。
  - `music_assets` / `music_track_assets` / `music_lyrics`：内容寻址封面与歌词；已接入内嵌封面、文件夹封面、内嵌歌词与同名 `.lrc`。
  - `music_scan_runs`、`music_search_text`、`app_meta`。
- 搜索：`music_search_text` 保存标题/艺术家/专辑/文件名，`music_search_fts`（FTS5 trigram）由触发器同步；>=3 字符走 FTS，1–2 字符/无法匹配时回退 `LIKE`。SQLite 构建已确认启用 `ENABLE_FTS5`（见 `db.rs` 测试输出）。
- 元数据优先级（P4 完整实现）：用户覆盖 > 已确认在线匹配 > 规范化本地标签 > 文件名推断；普通重扫不覆盖 `manual/split/online` 字段。
- 默认曲库已移除：`music/library/catalog.json`、内置曲 seed 与播放器 `ONLINE_TRACKS` 兜底均已删除；`0010_remove_builtin_music.sql` 清理旧库中的 `kind='builtin'` Track、来源、`catalog_seed_version` 与只由它们产生的孤立艺术家。

## 3. 当前 Media API（P1 + P2）

命令：`media_call({ request })`；`settings` 可访问全部；官方 `widget-player` / `widget-noise` 按 Widget 能力清单访问播放/队列/噪声与资料库读取，第三方 `widget-*` 走 bridge token。`media_connect` 注册订阅并返回快照，事件走 `media:event`。

### 3.1 Provider 切换

- 音乐播放器、白噪音 UI 是可替换的 Provider；同一 Slot 只运行一个窗口。
- 播放/白噪音状态由 Media Service 持有，不随 Provider 窗口销毁而丢失。
- `extensions_slot_use` 切换 Provider 时：旧窗口销毁会由 `media::on_window_destroyed`
  清理订阅；新 Provider 通过 `media_connect` 拿快照并重新订阅 `media:event`。
- 因此切换播放器 UI 不打断播放，切换白噪音 UI 不停止 Session；Provider 不得自行创建
  第二套音频服务。
- 能力校验不变：Widget 仍需要 `widget.media`、对应读能力与 bridge token；Slot 只负责
  选择与互斥，不额外授予能力。

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
| `folders.list` | `{}` | `MusicFolderView[]`（仅 local 目录，含 trackCount） |
| `folders.get` | `{folderId}` | `MusicFolderView` |
| `folders.add` | `{path?, recursive?}` | `MusicFolderView \| null`（无 path 时打开系统目录选择器） |
| `folders.rename` | `{folderId, name}` | `MusicFolderView`（只改显示名） |
| `folders.remove` | `{folderId}` | `{removed: boolean}`（只删库记录，不删磁盘文件） |
| `folders.scan` | `{folderId}` | `ScanJobView`（立即返回，扫描后台执行） |
| `folders.cancelScan` | `{folderId}` | `{cancelled: boolean}` |
| `folders.getTracks` | `{folderId, ...TrackQuery}` | `Page<FolderTrackView>`（host 窗口可读 relativePath） |
| `library.listDirectory` | `{folderId?, path?, page?, pageSize?}` | `DirectoryListing`（单层目录；只含显示名/相对 path，不含 rootPath） |
| `library.listSources` / `addSource` / `removeSource` / `startScan` / `cancelScan` | 旧参数 | 兼容别名：listSources 保留原来源列表，其余委托 `folders`，逐步弃用 |
| `library.listTracks` | `{keyword?, sourceIds?, folderId?, artistId?, albumId?, genre?, format?, year?, yearFrom?, yearTo?, page?, pageSize?, sortBy?, sortOrder?, includeUnavailable?}` | `Page<TrackSummary>` |
| `library.getTrack` | `{trackId}` | `TrackDetail`（含文件格式/码率、元数据 JSON 与主歌词，不含路径） |
| `library.getCoverUrl` | `{trackId}` | `{url: string \| null}`（仅官方窗口） |
| `library.listArtists` | `{}` | `ArtistSummary[]` |
| `library.listAlbums` | `{}` | `AlbumSummary[]` |
| `library.listGenres` | `{}` | `string[]` |
| `player.getState` / `play` / `pause` / `resume` / `stop` / `seek` / `next` / `previous` | `trackId?`, `positionMs` | `PlayerState` |
| `player.setVolume` / `setMuted` / `setMode` | `volume`, `muted`, `mode` | `PlayerState` |
| `player.setAdvanceList` | `trackIds` | `null` |
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
| `noise.presets.importPreset` / `exportPreset` | `path?` | `NoisePresetDetail`（取消为 null）/ `NoisePresetExportResult`（仅 settings） |
| `noise.presets.setPresetFavorite` | `presetId`, `favorite` | `NoisePresetSummary` |
| `system.snapshot` | `{}` | `PlaybackSnapshot`（含 `output` / `noiseSession`） |
| `system.getOutput` / `setOutput` | `volume?`, `muted?` | `MediaOutput` |

`player.setAdvanceList` 是官方播放器的运行时提示：自然播完与 `shuffle` 手动上/下一首都按
这份列表选曲；`shuffle` 走多因素加权随机 + 轮次袋（见 3.2），其他模式按列表顺序。列表为空
或未设置时回退到宿主队列。它不修改用户队列。

约定：

- 结果不含 `path/storage_key` 之外的文件系统细节；`rootPath` 只给 settings/library 窗口，相对路径只给 host-only 的 `folders.getTracks`。
- `TrackSummary` 新增 `folderId/folderName/addedAt/fileName/format/fileSize/bitrate/sampleRate/fileModifiedAt/albumArtId` 可选字段；`FolderTrackView` 在此基础上额外返回 `relativePath`（仅 host）。
- `DirectoryListing` 只描述“当前一层”：`folder`、`breadcrumbs`、`parent`、`directories`（名称/相对 path/曲目数）与当前目录直接音频文件的 `tracks` 分页；`folderId` 省略时返回根目录列表。
- 错误用 `{code,message,details?}`；前端按 `code` 分支。
- `media_connect({topics,progressMs,levels})` 原子注册订阅并返回 `PlaybackSnapshot`；事件 envelope 为 `{protocol,topic,revision,at,eventId,payload}`。顶层 revision 取 Player/Output/Noise 最大值；过滤事件时用各自 domain 的 revision（如 `snapshot.player.revision` / `snapshot.noise.revision`），不要用顶层值。
- 资料库事件也走 `media:event`：`library.changed`、`library.scan.started`、`library.scan.progress`、`library.scan.finished`；Noise 素材库变更发 `noise.library.changed`。`app_meta.revision` 持久化，列表响应同时带 revision。
- 播放状态事件发完整 `PlayerState`；进度/电平只发给订阅窗口；音频电平最高 20Hz。
- 引擎窗口只接收 `media-engine-command`，通过 `media_engine_ready/event` 上报；命令携带 `loadId`，旧加载事件被丢弃。N1 起 engine protocol 为 v2，Music 与 Noise 共用 `AudioGraph`（musicBus/noiseBus/master/limiter），并支持 `output.volume` 与 `engine.shutdown`；N2 起 Noise 用 `noise.session.sync` 下发完整 Session/Track 快照，N3 文件轨道的 `source.kind=asset` 通过 asset protocol URL 进入同一 `noiseBus`。
- 本地音频经 Tauri asset protocol 进入引擎；`<audio>` 必须设置 `crossOrigin="anonymous"`，asset protocol 返回的 `Access-Control-Allow-Origin` 才能让 `MediaElementAudioSourceNode` 输出非静音。缺少 CORS opt-in 时元素可直出，但接入 Web Audio 后会静音。

### 3.2 随机播放（智能）

`shuffle` 不再使用时间取模或前端 `Math.random()`，由 Rust 侧统一选曲，自然播完与
`player.next/previous` 共用同一套逻辑：

- **候选**：优先 `player.setAdvanceList` 同步的当前页签列表，未设置或为空时回退
  `player_queue`；两者都空返回 `queue.empty`。`shuffle` 下 `player.next/previous` 也优先
  使用这份列表（外部 Widget 同样生效），但不会修改 `player_queue`。
- **轮次袋（Shuffle Bag）**：一轮内不重复，`remaining` 为空才开启下一轮，并排除刚播完的
  当前曲；分页追加/筛选缩小保留已播进度，切换页签等「互不包含」的列表变化重置一轮。
  轮次状态只在内存，应用重启后重新开始；手动点播同样计入本轮。
- **特征**：主要/合作艺术家、主专辑、`music_tracks.genre`（小写归一化）、收藏。
- **最近播放**：`music_play_history` 中最近 6 小时、最多 32 条；同一首歌按最近一次出现
  的位置降权。
- **权重**（基础 1.0，逐项相乘）：

| 因素 | 规则 | 乘数 |
| --- | --- | --- |
| 最近播放位置 | 0–2 / 3–7 / 8–15 / 16–31 | 0.02 / 0.15 / 0.5 / 0.85 |
| 同歌手 | 最近 3 首命中 1 首 / ≥2 首 | 0.2 / 0.05 |
| 同专辑 | 与上一首相同 / 最近 3 首内相同 | 0.15 / 0.5 |
| 同曲风 | 最近 3 首命中 1 / 2 / 3 首 | 0.45 / 0.2 / 0.09 |
| 收藏 | 候选已被收藏 | ×1.2 |

  最终权重夹在 `[1e-6, 8]`，再按权重随机抽取（内置 SplitMix64，不引入额外依赖）；
  没有元数据的曲目按中性权重处理，不会把「未知专辑」当成同一张专辑。
- **失败兜底**：候选曲目连续不可播放时最多重试 3 首并移出本轮，再回退队列顺序播放。
- **限制**：曲库没有 BPM 字段，节奏/情绪维度暂不参与；`shuffle` 下「上一首」同样是随机
  选曲；单曲列表重播当前曲；轮次不持久化。

## 4. 前端 SDK

`packages/media-sdk`（Apache-2.0）：

- `createMediaClient({ transport? })`：Tauri 环境自动使用 `media_call` / `media_connect`；测试传内存 transport。
- `library.*`（含 scan progress/cancel、cover URL、genre/filter/tag 参数、`updateTrackMetadata`、标签 CRUD/`setTrackTags`、`mergeArtists`/`splitArtist`/`mergeAlbums`/`splitAlbum`、智能歌单 CRUD/`runSmartPlaylist`、`exportBackup`/`importBackup`）、`player.*`、`queue.*`、`playlists.*`、`favorites.*`、`history.*`、`noise.*`（含 `noise.session.*` / `noise.tracks.*` / `noise.library.*` / `noise.presets.*`）、`system.getOutput/setOutput`、`connect/disconnect`、`events.on`。
- `@lull/media-sdk/react`：`LullMediaProvider` / `useMediaClient` / `useNoiseSession` / `useNoiseTracks` / `useNoiseLibrary` / `useNoisePresets` / `usePlayerSession` / `useDirectoryBrowser`；hooks 按 client 共享连接，最后一个订阅卸载时断开。
- `@lull/media-sdk/widget`：`createWidgetTransport` / `createWidgetMediaClient`，翻译为 Widget 桥的 `media.call/connect/disconnect`，并通过 `onMediaEvent` 接收宿主转发事件。
- `@lull/media-sdk/testing`：`createMemoryTransport`。
- 音乐库 / 壁纸库 / 白噪音库窗口、官方播放器与白噪音窗口都只通过 SDK/Media Service 访问；不直接 `invoke`、不自己创建音频图。音乐库窗口（label `library`）包含全部歌曲/最近添加/我的目录/歌单/我的收藏/最近播放/队列/智能歌单，以及「曲库整理」「媒体测试」两个调试页签，并负责导入、扫描、重命名与移除目录；壁纸库（label `backdrop`）承载壁纸层与媒体壁纸配置；白噪音库（label `noise-library`）承载 Noise 素材、Preset 与 API 调试。

P5 已落地：`./widget` 传输、8 个 Noise capability、Rust bridge token、`noise-mixer` 示例；`./vue` 与查询缓存仍未实现。

P2（官方扩展迁移）已落地：Widget 新增 `media.player.read/control/volume.write`、`media.queue.read/write`、`media.library.read/favorites.write`、`media.library.sources.write`；`media_connect` 按授权裁剪 player/queue 快照与 topic；封面在授权时放开 `asset:` 的 CSP。

P4 已落地：资料库窗口曲目行可编辑元数据与标签，标签 CRUD/多标签分配，智能歌单创建/运行/删除；实体合并/拆分通过 SDK/API 提供，暂未做专用管理 UI。音乐库窗口新增「曲库整理」调试页签，直接驱动同一组 SDK 方法并显示原始返回。

## 5. 安全与隐私

- `media_call` 对 `settings/player/noise/library/noise-library` 走官方矩阵；`widget-*` 必须携带 Rust 生成的 bridge token，并逐方法校验 Noise（8）+ Player/Queue/Library（9）共 17 个 `media.*` capability。引擎命令仅 `media-engine`。
- 官方窗口矩阵：`settings` 全部；`noise-library` Noise 全量（素材/Preset/Session 管理）；`noise` Noise 读写但不导入/删除 Asset、不导入/导出 Preset 文件；`player` 仅播放/队列；`library` 读取 Noise Library。Widget 不获得 `system.snapshot`、Asset 写与 Preset 文件导入导出。
- Widget `media_connect` 至少需要一项读能力；snapshot 按授权裁剪：`player` 需 `media.player.read`，`queue` 需 `media.queue.read`，output/noise 维持现状；topic 白名单 = 已授权读能力的并集。
- bridge token 只注入顶层壳页，插件 iframe 拿不到；`media_call`/`media_connect`/`media_disconnect` 都校验 token，伪造 label/token 失败。
- 第三方能力见 [Widget SDK](widget-sdk.md)：`media.noise.*` 八项，以及 `media.player.read/control/volume.write`、`media.queue.read/write`、`media.library.read/directory.read/favorites.write`、`media.library.sources.write`（最后一项只允许 `folders.add` / `folders.scan`，通过系统选择器添加并扫描）。
- 目录的 `rootPath` 与 `folders.getTracks` 的 `relativePath` 只允许 host 窗口读取；带
  `media.library.sources.write` 的 Widget 只能通过系统选择器添加目录，返回的目录视图也会去掉 `rootPath`。
- 播放器目录浏览使用 `library.listDirectory`：只返回当前层子目录和直接音频文件，返回的
  `path` 是相对根目录的显示路径，不返回 `rootPath` / 绝对路径；需要
  `media.library.directory.read`。
- 音频播放源只在宿主引擎内部解析；绝对路径不进入 DTO/事件。
- 扫描只读；文件解析失败回退文件名，不阻断整次扫描。
- 全局 Chromium 参数关闭自动播放限制与后台定时器节流，供隐藏引擎使用；所有 WebView 必须共用同一份参数。

## 6. 当前限制

- 扫描每个文件一个小事务；取消只在文件之间生效，大文件解析期间不会立即中断。未变化文件（size/mtime/format 相同）跳过；成功完成后才移除本次未发现的 Track（不删除磁盘文件）。
- 遍历发现阶段出现错误时跳过缺失清理；目录整体不可达时目录标记 `missing` 并保留 Track。文件移动/重命名在下一次扫描按“旧 Track 移除 + 新 Track 新增”处理，不按标题/Hash 合并。
- 已接入内嵌/文件夹封面与内嵌/同名 `.lrc` 歌词；歌词 UI、文件监听、`.lullignore` 尚未接入。
- `library.listTracks` 已支持关键词、艺术家/专辑/流派(genre)/标签/格式/年份与 `folderId` 筛选；P4 已接入标签实体、多值标签、元数据编辑、艺术家/专辑合并拆分与智能歌单。
- 播放/队列/白噪音已迁移到 Media Service；N1 起统一走共享 `AudioGraph`（本地音频 `MediaElementAudioSource`、Noise `noiseBus`），不再各自建 `AudioContext`。默认在线氛围曲与其合成引擎已移除；播放器队列 UI 仍未内置到播放器窗口；P3 在资料库窗口提供队列视图与移出/播放操作。
- P3 已支持歌单、喜欢、历史与 M3U 导入导出；本地音频元素已设置 `crossOrigin="anonymous"`，以配合 asset protocol 的 CORS 让 `MediaElementAudioSourceNode` 正常输出。
- N2 起 Noise 使用独立 `NoiseSession`/`NoiseTrack` 运行时；旧 5 层 `noise.*` 由兼容门面映射到同一 Session。Session/Track 不持久化，退出即停止；只保存 master/muted 等偏好。睡眠定时到点会暂停 Session（保留 muted 偏好），不会自动恢复播放。
- N3 的 Noise 本地素材在导入时复制到受管目录并流式 SHA-256；支持 `mp3/flac/wav/ogg/m4a/aac`、单文件 100 MB/30 分钟上限，重复 hash 返回已有 Asset。文件播放走 `<audio>` + `MediaElementAudioSourceNode`，缺失文件由 `revalidateAssets` 标记，不每次打开全量重算 hash。
- N3.5 起分类/标签有用户 CRUD：内置分类/标签只读，用户分类支持父子层级与循环保护，同名分类（同父级）和同名标签（跨内置/用户）拒绝；删除分类把素材置为未分类且子分类存在时拒绝删除，删除标签级联移除素材关联。
- N4 起 Preset 保存当前 Session 的 Asset 引用/哈希/名称/音量/loop/fade 快照，不含音频、脚本或路径；加载替换 Session 与 master 但不自动播放，缺失轨道返回 candidates，可 `mapPresetTrack` 后重载。`.lull-noise.json` 导入生成新本地 ID，原 ID 存 `origin_id`，同来源不自动覆盖。
- N5/P5 起 Widget 侧不直接拿 Tauri IPC；bridge token 只注入顶层壳页。Widget snapshot 为 redacted；8 个 Noise capability 按方法/事件逐项强制校验，伪造 token 或未授权方法返回 `capability.denied`。
- N6 起白噪音窗口改用 `NoiseSession`/`NoiseTrack`：5 个内置 procedural 仍渲染为泡泡，本地轨道显示紧凑列表；支持 Preset 选择/加载、播放/暂停、睡眠和本地轨开关/音量/移除。加载 Preset 后 Session 保持 idle，泡泡显示“待播放”、主泡显示暂停，点击播放/泡泡才出声；关闭窗口只断开 UI 订阅，不停止 Session；重开取 snapshot，多窗口靠 `noise.session.changed` 同步。
- P4 起元数据编辑写 `overrides_json` + `music_field_sources(source=manual)`，同步更新曲目/艺术家/专辑规范化字段；重扫看到 `manual/split/online` 不再覆盖该字段。标签是独立实体，`music_track_tags` 支持多标签与筛选；艺术家/专辑合并保留 `merged_into_id` 与别名，拆分把选中 Track 关系迁到新实体；智能歌单保存查询规则并在读取时实时查询。
- P6 已支持同名 `.lrc` / `.txt` / `.srt` sidecar 歌词（按 lrc → txt → srt 优先级，内容原样保存）；组织数据备份为 JSON，只含 Track ID 引用、歌单、喜欢、历史、标签与智能歌单，不含音频/路径/资产，导入缺失 Track 自动跳过。在线元数据、文件监听与缩略图仍未开始。
- 封面读取链路：`TrackSummary.hasCover` 表示是否有主封面；`library.getCoverUrl(trackId)` 返回经 asset protocol 授权的 URL；资产存 `music_assets`，关系存 `music_track_assets(role='cover')`，来源由扫描器写入 `embedded/folder`。当前没有用户上传/替换/删除封面的保存 API，`updateTrackMetadata` 也不覆盖封面；资料库元数据弹窗与音乐库窗口的曲库整理页签只做只读预览。
- 设备切换依赖 `devicechange` 重载引擎页 + Rust 全量 resync；多设备选择、独占模式、SMTC 尚未接入。
- Widget 已获得 8 个 `media.noise.*` 与 9 个 `media.player` / `media.queue` / `media.library` capability 的受限访问；bridge token 与 redacted snapshot 见 [Widget SDK](widget-sdk.md)。`system.snapshot`、文件夹根路径与 Asset/Preset 文件导入导出仍只属于宿主窗口。Slot Provider 的选择与切换不改变这些能力校验。
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
| P4 | 元数据编辑、标签、实体合并/拆分、智能歌单 | 代码已落地，待手工验收 |
| N5/P5 | 公开 Media SDK、Widget 桥、8 个 Noise 权限、token、React hooks、示例 | 代码已落地，待手工验收 |
| N6 | 官方 Noise Mixer/Library/Preset UI | 代码已落地，待手工验收 |
| P6 | 在线元数据、歌词格式、监听、缩略图、备份 | 部分落地：歌词 sidecar/备份；在线/监听/缩略图未开始 |
| P7 | 物理目录模型：文件字段前移、`folders` API、我的目录/最近添加 UI、删除 `music_files` | 代码已落地，待手工迁移/目录验收 |
| P8 | 移除默认曲库：删除 catalog seed、`ONLINE_TRACKS` 兜底、在线氛围合成与旧库内置曲 | 代码已落地，待旧库清理验收 |

推荐顺序：`N1 → P3 → N2 → N3 → N4 → N5/P5 → N6 → P4 → P6`。N1 必须先于 Noise；P3 与 N2 可互换；N5/P5 必须等 P3 与 N4。

### 7.1 手工验收（开发调试）

音乐库窗口的「媒体测试」页签（`components/settings/media-api-test-panel.tsx`）直接调用 `@lull/media-sdk` 并显示 API 结果与 `media:event`，用于验收：

- 添加音乐文件夹并扫描，得到可测试曲目；
- 新建/重命名/删除歌单，加入/移除/排序曲目；
- 收藏、清空历史、播放后确认 `history.changed` 与历史列表；
- 队列播放/移出后确认 `player.state` / `queue.changed` 刷新；
- 导入/导出 M3U，检查导入匹配与导出文件内容。

该页签是调试工具，不是正式资料库 UI；正式界面是同一窗口的曲库/歌单/收藏等页签。媒体连接由窗口根节点统一建立，页签只订阅事件，不重复 connect/disconnect。

白噪音库窗口的「噪音测试」页签（`components/settings/noise-api-test-panel.tsx`）用于 N2 手工验收：

- 读取/切换 `noise.session.*` 状态，新建、播放、暂停、停止；
- 按内置 profile 或 Asset ID 添加音轨，调整音量/enabled/loop/顺序并移除；
- 调 master/muted/睡眠，观察 `noise.state`、`noise.session.changed`、`noise.track.*`、`noise.level`；
- 用旧 5 层 `noise.*` 控件修改同一 Session，确认与新 API、引擎听感一致；
- 查看 `PlaybackSnapshot` 的 player/noise/session revision，确认客户端按 domain revision 过滤事件。

该页签同样只是调试工具，不是 N6 的正式 Mixer/Library/Preset UI。

## 8. 设计参考

Folia（AGPL-3.0）的本地曲库文档与领域模型提供了重要设计参考：文件与 Track 分离、实体/关系分离、导入/在线/人工来源保护、内容寻址封面、歌单只存引用、增量扫描、合并/拆分保留别名。本实现只借鉴设计，不复用其代码或 SQL；如未来复用任何片段，先做许可证评估。
