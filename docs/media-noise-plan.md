# Lull Media 2.5 + Noise Service 综合实施计划（含 Music P3 排序决策）

> 状态：2026-10-31 批准；N0 + N1 + P3 + N2 + N3 + N3.5 + N4 + N5/P5 + N6 + P4 已落地，P6 部分落地（歌词 sidecar/组织备份）；N1 仍待真机音频/设备切换/长稳验收，N2–N6/P4/P6 待手工验收；P6 剩余在线元数据、文件监听、缩略图。
>
> 归档说明：本文是 plan mode 批准版的可检索副本；更细的代码审查与实现决策见 [Lull Noise Service 技术设计 RFC](Lull%20Noise%20Service%20技术设计%20RFC.md) 第十六节。

## 0. 先做 Music P3 还是 Noise：结论

这里把“音乐服务”理解为原计划的 **P3**（歌单/喜欢/历史/M3U/资料库窗口），把“音境”理解为 Noise 的 **N2 及之后**。

**推荐顺序：**

```text
N0 → N1 → P3 → N2 → N3 → N4 → N5/P5 → N6 → P4 → P6
```

**硬约束（不能交换）：**

- **N1 必须先于 Noise**：N1 是 Music + Noise 共享输出/引擎协议/事件快照基础。
- **P3 与 N4 必须先于 P5**：P5 是 Music + Noise 共用的公开 SDK、Widget 桥和权限。
- **N2 必须先于 N3/N4/N6**：Noise 的 Asset/Session/Track 模型是后续阶段前置。

**软约束（可以交换）：**

- **P3 与 N2 互不依赖**，可以互换。
- 如果 Noise 有明确发布目标或独立负责人，`N1 → N2 → N3/N4 → P3` 可行，整体架构不变，只是 P5 等 P3。
- 不建议先做完整 Music P3–P6 再做 Noise，也不建议先做完整 Noise N2–N6 再做 Music；应交错推进。

**推荐 P3 先于 N2 的理由：**

1. **风险先收敛**：N1 是唯一高风险的音频内核改造；P3 不碰音频运行时，先做 P3 可以让 P2 的播放/队列在真实使用中稳定下来。
2. **交付节奏**：P3 补上 P2 遗留的队列 UI、歌单/喜欢/历史，是用户可见的连续交付；现有 EtherBubbles 通过兼容门面仍可用。
3. **P5 一次成型**：P3 先完成，P5 的 Music 权限/API 面就齐了；再叠加 Noise 的 8 个权限和桥，只需设计一次。
4. **实现经验复用**：P3 的分页、收藏、事务、资料库窗口模式，可作为 N3/N4 的工程参考。
5. **迁移编号简单**：按执行顺序递增迁移号，不留空号。

## 1. 代码级审查结论

### 1.1 现有音频输出链路

- `src-tauri/Cargo.toml` 没有 `cpal`/`rodio`/`symphonia` 等音频依赖；`media-pp` 是 `native-media` 可选特性，只用于视频 NV12/D3D11 解码。
- `src-tauri/native/` 的 C++ 桥没有音频 API。
- 实际发声路径：Rust `media::playback` → `media-engine-command` → `src/media-engine`。
- `AmbientStream`、`PlayerEngine` 的本地 `<audio>`、`NoiseEngine` 各自建 `AudioContext`，没有共享 bus/master/limiter/设备恢复。
- Noise 是固定 5 层 `noise_state`，没有 Asset/Track/Session/Preset。
- `media_call` 仅 `settings/player/noise`；第三方 Widget 没有媒体权限。
- `RunEvent::Exit` 保存状态、关闭 DB、关闭视频，但隐藏引擎没有显式 stop。

### 1.2 对 RFC 的判断

1. Music 与 Noise 应是同级业务域，共享底层输出，不共享 Track/Queue/Preset 模型。
2. RFC 的 Rust `AudioOutput`/`AudioSource` trait 当前没有落地基础；现在原生重写会把 Noise 业务变成播放器内核改造。
3. 当前 WebView 引擎有能力做 Shared Audio Output Mixer：一个 `AudioContext`、两条总线、master、limiter。
4. Noise 内置声音是程序化合成，V1 必须支持 `procedural` Asset，不能假设已有一组音频文件。
5. P5 不能只做 Music；Noise 的权限、事件和 SDK 与 Music P5 共用同一套桥。

## 2. 核心决策

| 决策 | 选择 | 理由与影响 |
| --- | --- | --- |
| Shared Audio Output v1 | 隐藏 `media-engine` 内唯一 `AudioGraph`：`musicBus` + `noiseBus` + `masterGain` + limiter + analysers | 复用 P2 路径；不改原生依赖；立即验证核心承诺 |
| 原生 Rust Audio Engine | 本期不实现，保留协议边界与迁移门 | 需要新依赖、设备/解码线程和程序化音乐重写 |
| 内置 Noise Asset | `procedural` 素材，稳定 ID，由引擎 profile 合成 | 与现有 5 层声音一致；安装包不膨胀 |
| 本地素材 | 导入时复制到 `music/noise/assets/<sha256>.<ext>` | 资源稳定、可去重、可校验；原文件移动不影响 Asset |
| Noise Session/Track | 进程内单例，退出即停止，不持久化 | 遵守已确定决策；只保留偏好 |
| 数据库 | 继续使用 `music.db`，新增 `noise_*` 表 | 复用连接池/迁移/备份；表前缀隔离 |
| API 兼容 | Media API 协议保持 1；新方法 additive；旧 `noise.*` 保留兼容门面 | P2 测试与 EtherBubbles 无需一次性重写 |
| 权限 | 8 个 `media.noise.*` capability；Rust 方法级校验；Widget 额外校验 bridge token | 最小权限；不信任参数身份 |
| UI 顺序 | 先做设置页功能型面板；EtherBubbles 视觉迁移放最后 | 后端/API 可独立验收 |

### 2.1 原生引擎迁移门

只有出现以下任一情况，才启动原生 `AudioOutput` 项目：

- 音乐 + 5 条 Noise 连续 2 小时出现明显 CPU/内存增长或爆音；
- 切换 Windows 默认输出设备后无法在 1 秒内恢复；
- 需要独占模式、SMTC、按设备选择输出；
- 需要把引擎窗口从进程模型中移除。

原生迁移时保持 `media-engine` 协议语义不变，只替换实现方；业务层不感知。

## 3. 目标架构

### 3.1 Rust 模块

```text
src-tauri/src/media/
├─ api/
│  ├─ commands.rs          # 薄命令层
│  ├─ snapshot.rs          # PlaybackSnapshot 组合
│  ├─ permissions.rs       # N5
│  ├─ dto.rs / errors.rs / protocol.rs
│  └─ widget_auth.rs       # N5
├─ engine/                 # 隐藏引擎窗口 + protocol v2
├─ events.rs               # media:event 订阅/revision/eventId
├─ lifecycle.rs            # 后续抽出
├─ database.rs             # N2 抽出
├─ output.rs               # 全局输出音量
├─ library/                # 既有 Music 资料库
├─ playback/               # Music 播放与队列；旧 Noise 兼容期
├─ repository/
├─ noise/                  # N2+
│  ├─ catalog.rs/.json
│  ├─ session.rs / assets.rs / categories.rs / tags.rs
│  ├─ favorites.rs / presets.rs / import.rs
│  ├─ compat.rs
│  └─ events.rs
└─ video/
```

`playback` 与 `noise` 不互相依赖；组合快照放在 `api/snapshot.rs`。

### 3.2 TS 引擎

```text
src/media-engine/
├─ audio-graph.ts      # 唯一 AudioContext、总线、master、limiter、analysers
├─ host.ts             # 命令分发、ready、shutdown、devicechange
├─ player-engine.ts    # 本地音频 + 内置氛围曲，统一接 musicBus
├─ ambient-stream.ts   # 接受共享 context/bus
├─ noise-engine.ts     # 多轨 Noise 混音，接 noiseBus
├─ noise-profiles.ts   # N2 起
├─ gain.ts             # 纯增益计算
└─ protocol.ts         # engine protocol v2
```

```text
musicBus (player volume/mute)
  ├─ AmbientStream
  └─ MediaElementAudioSource (local audio)
noiseBus (session master/mute)
  └─ track gains (per-track volume/enabled/fade)
        ↓
masterGain (global output volume/mute)
        ↓
DynamicsCompressor limiter
        ↓
destination
```

- 本地音频 `audio.volume = 1`，音量只由 `musicBus` 控制。
- 移除 `captureStream` 电平回退，统一从 bus analyser 读数。
- 削波保护：per-track trim、noise master trim、master headroom，limiter 兜底；不允许简单 PCM 相加。
- 实时音频路径不执行文件 I/O、SQLite 或日志写盘。

### 3.3 数据流

```text
UI → media_call → Rust Service（权威状态）
  → engine command
  → WebView AudioGraph 实际发声
  → engine events (state/error/levels)
  → Rust 状态校正 → media:event → 所有订阅窗口
```

### 3.4 音量关系

| 音量 | 所属层 | 实现 |
| --- | --- | --- |
| Music Volume | Playback | `musicBus` gain |
| Noise Master Volume | Noise Session | `noiseBus` gain |
| Noise Track Volume | Noise Mixer | 每轨 gain |
| Master Output Volume | `media/output` | `masterGain` |
| Windows Device Volume | OS | 不控制 |

## 4. 数据模型与迁移

### 4.1 迁移

- N1：`0005_media_output.sql`（已落地）。
- 推荐顺序 P3 在 N2 前：P3 使用 `0006_*`，N2 使用 `0007_noise.sql`；如 Noise 优先则互换编号。
- 编号按实际执行顺序递增，不预留空号。
- 保留 `noise_state` 不删除、不改名，作为回滚与一次性偏好迁移来源；新代码不再读写它。
- `music.db` 继续作为 Media DB；Music 用 `music_*`，Noise 用 `noise_*`。

### 4.2 Noise 表

| 表 | 关键字段 |
| --- | --- |
| `noise_sources` | `id, kind(builtin/local/community/widget), name, root_path, status, created_at, updated_at` |
| `noise_assets` | `id, source_id, name, description, media_kind(procedural/file), format, storage_key, size_bytes, mtime_ms, duration_ms, sample_rate, channels, content_hash, generator_json, category_id, capabilities_json, status, created_at, updated_at` |
| `noise_categories` | `id, name, parent_id, icon, source_type, sort_order, created_at` |
| `noise_tags` | `id, name, normalized_name, source_type, created_at` |
| `noise_asset_tags` | `asset_id, tag_id` |
| `noise_favorites` | `asset_id, created_at` |
| `noise_presets` | `id, origin_id, name, description, source_type, author, schema_version, master_volume, cover_ref, created_at, updated_at` |
| `noise_preset_tracks` | `id, preset_id, asset_id, asset_hash, asset_source_type, asset_source_id, expected_name, volume, enabled, loop, fade_in_ms, fade_out_ms, sort_order` |
| `noise_preset_favorites` | `preset_id, created_at` |
| `noise_preferences` | `id=1, master_volume, muted, last_preset_id, updated_at` |

约束：

- `noise_assets.content_hash` 唯一（非空时）。
- `noise_assets.storage_key` 只存文件名，不存绝对路径；procedural 为 NULL。
- `noise_preset_tracks.asset_id` 外键 `ON DELETE SET NULL`，删除 Asset 不破坏 Preset。
- `noise_sources.root_path` 只给内部，不进入 DTO。

### 4.3 内置 catalog

- `noise_src_builtin` source。
- 5 个内置 Asset：`noise:builtin:rain`、`thunder`、`wind`、`waves`、`fire`；`media_kind=procedural`。
- 内置分类、标签。
- 内置 Preset：`noise:preset:default` 与 2–3 个示例。
- `app_meta.noise_catalog_seed_version` 幂等 seed；升级不覆盖用户数据。

### 4.4 本地素材导入

- 仅 host（settings）可调用 `importAssets` / `importFolder`。
- 复制到临时文件 → 流式 SHA-256 → 原子 rename → `lofty` 元数据 → 单文件事务。
- hash 已存在返回已有 Asset。
- 格式矩阵：`mp3/flac/wav/ogg/m4a/aac`；实际解码以 WebView2 为准。
- 单文件上限 100 MB、时长上限 30 分钟。
- 启动/手动 `revalidateAssets`；不每次打开都全量 hash。
- 删除 Asset 级联标签/收藏，Preset 引用置空。

## 5. API 与 SDK

### 5.1 协议与快照

Media API 协议保持 1；新增走 `media_call` 的 `namespace:"noise"`，不新增 Tauri command。

```ts
{
  protocol: 1,
  revision: number,
  player?: PlayerState | null,      // Widget 可为 null（N5）
  queue?: QueueState | null,        // Widget 可为 null（N5）
  output: { volume: number; muted: boolean },
  noise: NoiseState,                // 旧 5 层兼容视图
  noiseSession: NoiseSession        // N2 加入
}
```

### 5.2 Noise 方法

| 域 | 方法 |
| --- | --- |
| Library | `listAssets`, `getAsset`, `getCategories`, `getTags`, `importAssets`, `importFolder`, `updateAsset`, `removeAsset`, `revalidateAssets`, `setAssetFavorite` |
| Session | `getSession`, `createSession`, `playSession`, `pauseSession`, `stopSession`, `setSessionVolume`, `setSessionMuted`, `setSleepTimer` |
| Tracks | `addTrack`, `removeTrack`, `setTrackVolume`, `setTrackEnabled`, `setTrackLoop`, `reorderTracks` |
| Presets | `listPresets`, `getPreset`, `savePreset`, `updatePreset`, `deletePreset`, `loadPreset`, `exportPreset`, `importPreset`, `mapPresetTrack`, `setPresetFavorite` |
| System | `getAudioStatus`, `getOutput`, `setOutput` |
| Legacy | `getState`, `getSounds`, `activate`, `setLayer`, `setMaster`, `setMuted`, `setSleepTimer`, `reset` |

约定：

- 结构化错误 `{code,message,details?}`；缺失素材走 `PresetLoadResult.missing`。
- 路径/`storage_key`/`root_path` 不进入公开 DTO。
- 变更返回轻量结果；完整状态靠事件或 `getSession`。
- 新增错误码：`noise.asset.not-found/missing/unsupported/too-large`、`noise.session.empty`、`noise.track.not-found/limit`、`noise.preset.not-found/invalid/version/builtin`、`capability.denied`。

### 5.3 Preset 快照

`.lull-noise.json`：`schemaVersion:1` + `type:"lull-noise-preset"`。

- 最多 32 条 Track；名称 1–80；描述 ≤ 2 KB；音量 0–1；fade 0–10000ms；order 不重复。
- `cover` 只作为 opaque token，拒绝绝对路径/`file:`；不读取、不下载。
- 不允许脚本、命令、任意本地路径、音频二进制。
- 导入生成新本地 ID，原 ID 存 `origin_id`；不自动覆盖同来源 Preset。
- 解析顺序：assetId → contentHash → 同名候选 → missing。
- `PresetLoadResult` 返回 `session`、`resolved`、`missing`（含 candidates）。
- `loadPreset` 替换 Session 轨道与 master，不自动播放。
- `mapPresetTrack` 手动映射后按 assetId 信任。

### 5.4 SDK 与 React

- `packages/media-sdk` 保持扁平核心，新增 `noise.library/session/tracks/presets`；旧 `noise.*` 保留 deprecated。
- `./widget`：`createWidgetTransport()`，通过 `@lull/widget-sdk` 桥发 `media.call/connect/disconnect`，订阅 `media-event`。
- React hooks：共享事件 store，`useNoiseSession`、`useNoiseTracks`、`useNoiseLibrary`、`useNoisePresets`；单次 connect、snapshot+pending、卸载 disconnect。
- 补 `packages/media-sdk/README.md`。

## 6. 事件与状态同步

| 主题 | 载荷 |
| --- | --- |
| `noise.session.changed` | 完整 `NoiseSession` |
| `noise.session.state-changed` | `{state, revision}` |
| `noise.track.added` | `{track, sessionRevision}` |
| `noise.track.removed` | `{trackId}` |
| `noise.track.updated` | `NoiseTrack` |
| `noise.track.state-changed` | `{trackId, state, error?}` |
| `noise.volume.changed` | `{scope, trackId?, volume, muted?}` |
| `noise.preset.created/updated/deleted` | `{presetId, name}` / `{presetId}` |
| `noise.library.changed` | `null` |
| `noise.state` | 旧 5 层 `NoiseState` |
| `noise.level` | `{noise, player}` |
| `player.*` / `queue.*` | 不变 |

- envelope：`{protocol,topic,revision,at,eventId,payload}`；`eventId = topic:revision`。
- 各 domain 独立 revision；SDK 按 topic 比较，不跨 domain 排序。
- 连接流程：先注册订阅 → 再取快照 → 丢弃快照 revision 之前的事件。
- 音量事件 50ms 合并，结构变更立即发送。

## 7. 权限与 Widget 安全

### 7.1 Capability

- `media.noise.library.read`
- `media.noise.session.read`
- `media.noise.session.control`
- `media.noise.tracks.read`
- `media.noise.tracks.write`
- `media.noise.volume.write`
- `media.noise.presets.read`
- `media.noise.presets.write`

官方窗口矩阵：

| 窗口 | 权限 |
| --- | --- |
| `settings` | 全部 Noise 方法 + 素材导入/删除/更新 |
| `noise` | library read、session read/control、tracks read/write、volume write、presets read/write；不能导入/删除 Asset |
| `player` | 仅播放/队列；不开放 Noise |
| `widget-*` | 按 `.grants.json` 的 8 个 capability 逐方法校验 |

### 7.2 Rust 强制校验

- 官方 label 走静态矩阵；`widget-*` 从 label 解析 plugin id，查 `require_grant`。
- 方法 → capability 映射集中在一张表，测试覆盖每个方法。
- `media_connect` 校验 topics；无对应 read 权限不能订阅。
- `system.snapshot` 不对 Widget 开放；Widget 只通过 `media_connect` 拿 redacted snapshot。
- 不把 `widgetId` 当参数信任。

### 7.3 Widget bridge token

- `widget_package::open_window` 生成随机 token，注入：
  ```js
  if (window.top === window) {
    window.__LULL_MEDIA_TOKEN__ = "<random>";
  }
  ```
- Rust 存 label → token；窗口销毁清理。
- `media_call`/`media_connect`/`media_disconnect` 增加可选 `bridgeToken`；官方不传，Widget 必须传。
- 宿主壳读取 token 并随 invoke 传递；iframe 因 opaque origin 拿不到。
- 保留“插件自己的 Web Audio 不受 Noise Service 控制”的软约束说明。

## 8. 官方 UI 范围

1. **功能型面板（N3/N4）**：设置页 `noise-mixer-panel`、`noise-library-panel`、`noise-preset-gallery`。
2. **EtherBubbles 迁移（N6）**：固定 `sound-model` → `NoiseSession.tracks`；内置 5 个 procedural Asset 仍渲染为泡泡，本地轨道用紧凑列表；Preset 入口；关闭不停止 Session；重开取 Snapshot；多窗口同步。

UI 路径沿用 `src/components/noise/` 与 `src/components/settings/`，不新造 `src/features/` 顶层约定。文案走 Paraglide。

## 9. 实施阶段与验收

| 波次 | 内容 | 依赖 | 粗估 | 验收 |
| --- | --- | --- | --- | --- |
| N0 | 冻结决策、写 RFC 实现版、更新架构文档 | 无 | 0.5–1 人日 | 设计评审通过 |
| N1 | Media 2.5：Shared AudioGraph、engine protocol v2、共享事件/快照、全局输出音量、P2 长稳/设备恢复 | N0 | 5–7 人日 | 音乐 + 5 Noise 同时播放、独立音量、设备切换、退出停止；事件/快照契约稳定 |
| P3 | Music 歌单/喜欢/历史/M3U/资料库窗口 | N1 | 按原计划 | 原 P3 验收；补 P2 队列 UI |
| N2 | Noise Core：Session/Track、内置 procedural Asset、旧 API 兼容门面、schema/seed | N1（推荐 P3 后） | 5–7 人日 | 新 API 可用；旧 UI 不回归；无自动恢复 |
| N3 | Noise Library：导入、分类、标签、收藏、搜索、缺失检测 | N2 | 5–7 人日 | 任意数量素材、格式矩阵、删除不破坏 Preset |
| N4 | Presets：保存/加载/导入/导出/缺失映射 | N3 | 4–6 人日 | 社区 Preset 全流程；无音频/脚本；事务 |
| N5/P5 | Media SDK 完整化、Widget 桥、8 个权限、token、React hooks、示例 | N4 + P3 | 6–10 人日 | 第三方混音器；越权/伪造身份失败 |
| N6 | EtherBubbles 动态轨道、Preset 入口、官方 UI 打磨 | N4 | 6–10 人日 | 关闭 UI 不停止；重开快照；多窗口同步 |
| P4 | 元数据编辑/标签实体/合并拆分/智能歌单 | P3 | 按原计划 | 原 P4 验收 |
| P6 | 在线元数据/歌词/监听/缩略图/备份 | P3/P4 | 按原计划 | 原 P6 验收 |

推荐单人顺序：

```text
N0 → N1 → P3 → N2 → N3 → N4 → N5/P5 → N6 → P4 → P6
```

Noise 优先时：

```text
N0 → N1 → N2 → N3 → N4 → P3 → N5/P5 → N6 → P4 → P6
```

## 10. 测试与验证

### Rust

- 迁移 0005 / 后续 noise 表、catalog seed 幂等、旧 `noise_state` 偏好迁移。
- Session 单例、增删轨/重排/音量 clamp/32 轨上限、Legacy facade。
- Asset 导入 hash/去重/格式/大小/缺失/删除级联。
- Preset 保存/加载/导出/导入、schema、ID/hash/name 解析、映射、事务。
- 权限矩阵、token、topic 过滤。
- Engine 协议命令/事件、旧 loadId 丢弃。
- P2 播放/队列回归。

### TypeScript

- media-sdk 新/旧 Noise API、snapshot output、widget transport。
- widget-sdk 桥、权限拒绝、token、卸载。
- React hooks 单次 connect、snapshot+pending、音量节流。
- 引擎 gain/fade/buffer cache/limiter 常量。
- UI 导入/搜索/加载 Preset/缺失映射、EtherBubbles 动态轨道。

### 手工矩阵

- 音乐 + 5 轨 Noise 2 小时长稳；CPU/内存无持续增长。
- Windows 默认输出设备切换、蓝牙断开/重连。
- 引擎窗口销毁/重建、托盘退出、快速开关窗口。
- 导入大/损坏/重复文件；删除正在播放的 Asset。
- 社区 Preset：全部命中、仅 hash、仅同名、全缺失。
- Widget：8 个 capability 逐项授权/撤销；两个 Widget 同时改音量；iframe 直接调用。

### 命令

```powershell
cd src-tauri
cargo fmt --check
cargo test
cargo clippy --lib --tests
```

```powershell
pnpm i18n:compile
pnpm test
pnpm typecheck
pnpm media:sdk; pnpm media:sdk:check
pnpm widgets:sdk; pnpm widgets:sdk:check
pnpm widgets:check
```

文档改动后运行 `node website/scripts/check-docs-sync.mjs`。

## 11. 风险、回滚与边界

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| WebView 设备切换/后台节流 | 音频中断 | Chromium 参数；N1 `devicechange` 重载引擎 + Rust resync；不满足走原生门 |
| AudioGraph 回归音乐 | P2 播放异常 | 协议测试 + 音乐矩阵；保留旧 noise 门面；N1 单独验收 |
| 多轨解码内存 | 5–10 轨占用高 | 同素材共享 AudioBuffer；单文件上限；长稳测试 |
| 削波/爆音 | 体验差 | 统一 gain staging + limiter；不直接相加 |
| 迁移破坏旧数据 | 偏好丢失 | 不删 `noise_state`；additive 表；保留回滚 |
| Preset 缺失/误匹配 | 加载不完整 | missing + candidates；绝不按文件名自动关联 |
| Widget 绕过权限 | 越权控制 | Rust 方法级校验 + label 推导 + token |
| Widget 自行发声 | 不受共享 Mixer 控制 | 文档软约束；SDK 规范 |
| P3 被 Noise 阻塞 | 播放器计划延迟 | N1 先做；P3/N2 可互换；推荐 P3 先 |
| P5 做两遍 | 重复桥/权限 | P5 等 P3 + N4；单边 P5 视为范围错误 |
| 原生引擎诱惑 | 范围爆炸 | 明确迁移门；本期不改 Cargo 音频依赖 |

回滚：N1/N2 数据库变更 additive；保留 `noise_state`；旧 Media API 保留；代码回退后旧版本仍可读取原 `noise_state`。

## 12. 文档与交付物

- 将本计划写入 `docs/Lull Noise Service 技术设计 RFC.md` 的实现决策节。
- 更新 `docs/media-service.md`：Noise 数据模型/API/事件/权限、阶段表与排序。
- 更新 `docs/architecture.md`：模块树、命令/事件、`media-engine`/`media-pp` 边界、音量关系。
- 更新 `docs/widget-sdk.md`：8 个 `media.noise.*` capability、媒体桥、token、软约束。
- 新增 `packages/media-sdk/README.md`。
- website docs sync：内部设计稿登记 `NOT_ON_SITE` 或补站点页。
- 新增 `examples/widgets/noise-mixer`，扩展 `scripts/build-widget-examples.mjs` 解析 `@lull/media-sdk`。
- 代码交付：迁移、Rust 模块、TS 引擎、SDK、设置面板、EtherBubbles 迁移、测试。

## 13. 假设与非目标

### 假设

- 内置 5 个 Noise 声音继续程序化合成；不打包音频文件。
- 本地导入复制到受管存储；不支持“引用原路径、不复制”。
- V1 只使用 Windows 默认输出设备；不提供设备选择、独占模式、SMTC。
- 只保留 master/muted、输出音量、上次 Preset ID 等偏好；不恢复 Session/Track/播放状态。
- 一个进程只有一个全局 Noise Session。
- 社区只分发 `.lull-noise.json`；社区音频包、签名、在线目录不在本期。
- Noise 封面/图片资产、实时波形、可视化 API 不在本期。
- `music.db` 作为统一 Media DB；Noise 表与 Repository 独立。
- 第三方 Widget 不能导入/删除素材。

### 非目标

- 不新写 Rust 原生音频设备/解码/混音线程。
- 不把 `media-pp` 当作音频引擎。
- 不重写现有 Music 资料库、播放器主体或视频壁纸运行时。
- 不在本期实现 Music P3/P4/P6 的具体业务。
- 不把 Noise UI 作为后端前置条件。

## 14. 执行记录（2026-10-31）

N0 + N1 已落地：

- Rust：`media/engine.rs`、`media/events.rs`、`media/output.rs`、`media/api/snapshot.rs`；`media_connect` 改为订阅 + 快照；退出先发 `engine.shutdown`；新增 `0005_media_output.sql`。
- TS：`audio-graph.ts`、`gain.ts`；`PlayerEngine`/`AmbientStream`/`NoiseEngine` 接入共享 graph；engine protocol v2 增加 `output.volume`/`engine.shutdown`。
- SDK：`MediaOutput`、`system.getOutput/setOutput`、`output.changed`、`eventId`。
- 验证：`cargo test --lib` 160 项、`cargo clippy`、`pnpm test` 254 项、`pnpm typecheck`、`pnpm build:next`、`pnpm widgets:check`、docs sync 均通过。
- 待办：N1 真机音频/设备切换/2 小时长稳验收；通过后按推荐顺序进入 P3，再 N2。

P3 已落地（待手工验收）：

- Rust：`0006_library_p3.sql`；`media/repository/{playlists,favorites,history}.rs`；`media/library/{playlists,favorites,history,p3}.rs`；`library` 窗口接入 `media_call`；播放历史在真正开始播放时写入。
- SDK：`playlists.*`、`favorites.*`、`history.*`；`TrackSummary.favorite`。
- UI：`library` 资料库窗口（曲库/歌单/喜欢/历史/队列）、歌单新建/重命名/删除/排序/导入导出 M3U、队列播放/移除；`WindowShell` 支持非贴合窗口。
- 验证：`cargo test --lib` 166 项、`cargo clippy`、`pnpm test` 256 项、`pnpm typecheck`、`pnpm build:next`、`pnpm widgets:check`、docs sync 均通过。
- 下一阶段：N2 Noise Core（Session/Track、内置 procedural Asset、旧 API 兼容门面、Noise schema 0007）。

N2 已落地（待手工验收）：

- Rust：`0007_noise.sql`；`media/noise/{catalog,repository,session,dto}.rs`；Noise 从 `playback` 拆出，`media_connect` 快照增加 `noiseSession`；旧 5 层 `noise.*` 由兼容门面映射到同一 Session。
- 引擎：`noise.session.sync` 替代旧 `noise.sync`；TS `NoiseEngine` 按 trackId 动态建/拆声道，内置 5 个 procedural profile。
- 数据：catalog seed 5 个 builtin procedural Asset、分类/标签、默认与 3 个示例 Preset；Session/Track 不持久化，只保存 master/muted。
- SDK：`noise.session.*`、`noise.tracks.*`、`NoiseSession`/`NoiseTrack` 类型；`PlaybackSnapshot.noiseSession`。
- 睡眠定时到点暂停 Session（保留 muted 偏好），不再以 playing 状态静音；恢复需播放，原本 muted 时还需解除静音。
- 验证：`cargo test --lib` 170 项、`cargo clippy`（设置 `RC` 后）、`pnpm test` 257 项、`pnpm typecheck`、`pnpm build:next`、`pnpm widgets:check`、docs sync 均通过。
- 下一阶段：N3 Noise Library（文件导入、分类/标签/收藏、搜索、缺失检测），N4 Preset CRUD。

N3 已落地（待手工验收）：

- Rust：`media/noise/assets.rs`（受管目录、复制 + 流式 SHA-256、`lofty` 元数据、100 MB/30 分钟上限、缺失检查）与 `media/noise/library.rs`（Asset 分页/筛选、分类/标签、收藏、编辑/删除、导入结果）。
- 文件播放：`TrackSource::File`；Rust 生成 asset protocol URL，TS `NoiseEngine` 用 `<audio>` + `MediaElementAudioSourceNode` 接入共享 `noiseBus`；删除 Asset 会移除当前 Session 中引用它的 Track。
- API：`noise.library.listAssets/getAsset/getCategories/getTags/importAssets/importFolder/updateAsset/removeAsset/revalidateAssets/setAssetFavorite`；导入/编辑/删除/缺失检查仅 `settings`，`noise/library` 可读并可收藏，内置 Asset 不可改删。
- SDK：`noise.library.*`、`NoiseAsset/NoiseCategory/NoiseTag/NoiseImportResult/NoiseRevalidateResult`、`noise.library.changed`。
- UI：设置页新增“音境素材库”功能面板，支持导入文件/文件夹、搜索、分类/标签筛选、收藏、编辑、删除、加入混音与缺失检查。
- 验证：`cargo test --lib` 177 项、`cargo clippy`、`pnpm test` 262 项、`pnpm typecheck`、`pnpm build:next` 均通过。
- 下一阶段：N3.5 分类/标签独立 CRUD。

N3.5 已落地（待手工验收）：

- API：`noise.library.createCategory/updateCategory/deleteCategory/createTag/updateTag/deleteTag`；仅 settings 可写，`noise/library` 只读。
- 规则：内置分类/标签只读；用户分类支持父子层级、循环保护、同父级重名检查；标签按 normalized name 去重（跨内置/用户）；子分类存在时拒绝删除分类；删除分类把素材置为未分类，删除标签级联移除素材关联。
- DTO/SDK：`NoiseCategory/NoiseTag` 增加 `sourceType`；SDK 增加对应 CRUD；`noise.library.changed` 复用。
- UI：音境素材库面板新增“分类与标签”管理卡，支持创建/重命名/移动父级/删除；内置项标只读。
- 验证：`cargo test --lib` 177 项、`cargo clippy`、`pnpm test` 262 项、`pnpm typecheck`、`pnpm build:next` 均通过。
- 下一阶段：N4 Noise Presets（保存/加载/导入/导出、Preset 缺失映射、社区 Preset 事务）。

N4 已落地（待手工验收）：

- API：`noise.presets.listPresets/getPreset/savePreset/updatePreset/deletePreset/loadPreset/exportPreset/importPreset/mapPresetTrack/setPresetFavorite`；settings 全量，noise 读写，library 只读，import/export 文件仅 settings。
- 数据：`noise_presets`/`noise_preset_tracks`/`noise_preset_favorites` 启用；保存当前 Session 的 Asset 引用、content hash、source 类型/ID、名称、音量、enabled、loop、fade；不含音频/脚本/路径。
- `.lull-noise.json`：schemaVersion 1 + `type=lull-noise-preset`；最多 32 轨；名称 1–80、描述 ≤2 KB、音量 0–1、fade 0–10000ms、order 不重复；cover 必须是不透明 token；导入生成新本地 ID 并写 `origin_id`，不自动覆盖。
- 加载：解析顺序 assetId → contentHash → 同名候选 → missing；替换 Session 轨道/master，state=idle，不自动播放；缺失返回 candidates，可 `mapPresetTrack` 后重载。
- 内置 Preset 不可改删；加载/导出/收藏可用。删除 Preset 清理 `last_preset_id` 并依赖 FK 级联 tracks/favorites。
- SDK：`noise.presets.*` 与 `NoisePresetSummary/Detail/Track/LoadResult/Missing/ExportResult`；事件 `noise.preset.created/updated/deleted`。
- UI：设置页“音境预设”面板，支持保存当前混音、加载、收藏、重命名/描述、删除、导入导出与缺失轨道映射。
- 验证：`cargo test --lib` 181 项、`cargo clippy`、`pnpm test` 263 项、`pnpm typecheck`、`pnpm build:next` 均通过。
- 下一阶段：N5/P5 公开 SDK/Widget 权限，或 N6 官方 Noise UI。

N5/P5 已落地（待手工验收）：

- Rust：`media/api/permissions.rs` 集中 8 个 Noise capability 的方法/事件映射；`media_call`/`media_connect`/`media_disconnect` 对 `widget-*` 校验 bridge token 与 `.grants.json` grant。
- Token：`widget_package` 生成随机 token，随 `PluginContext.bridgeToken` 只注入顶层壳页；窗口销毁清理。iframe init token 仍只用于 iframe↔壳的桥请求，两者分离。
- Snapshot：Widget `media_connect` 返回 redacted snapshot（output/noise/noiseSession），topic 按 read capability 过滤；player/queue/output 事件不向 Widget 开放。
- 官方矩阵：settings 全部；noise Noise 读写但禁止 Asset 写与 Preset 文件导入导出；player 仅播放/队列；library 读取 Noise Library。
- Widget SDK：新增 `media.call/connect/disconnect` 桥方法、`media.event` 转发、`onMediaEvent`；manifest 允许 15 个能力（7 个 widget + 8 个 Noise）。
- Media SDK：`@lull/media-sdk/widget` 的 `createWidgetTransport/createWidgetMediaClient`；`@lull/media-sdk/react` 新增 `useNoiseSession/useNoiseTracks/useNoiseLibrary/useNoisePresets`，按 client 共享一次连接。
- 示例：新增 `examples/widgets/noise-mixer`，演示 session read/control、track read/write、volume write、睡眠定时；新增 `examples/widgets/noise-hooks` 验证共享连接、重渲染与卸载 disconnect。构建脚本加入 media-sdk resolver，并改为 esbuild 内存产物由 Node 写盘以规避 esbuild 子进程写权限问题。
- 验证：`cargo test --lib` 185 项、`cargo clippy`、`pnpm test` 266 项、`pnpm typecheck`、`pnpm build:next`、SDK checks 均通过；5 个 widget 示例 dist 已构建。
- 下一阶段：N6 官方 Noise Mixer/Library/Preset UI，或 P4/P6。

N6 已落地（待手工验收）：

- EtherBubbles 改读 `PlaybackSnapshot.noiseSession`，订阅 `noise.session.changed` / `noise.level`；不再用旧 5 层 `noise.state`。
- 5 个内置 procedural 仍以泡泡呈现，按 `noise:builtin:*` 映射到 Session Track；缺失时点击泡泡自动 `addTrack`。
- 本地轨道在泡泡下方与设置面板显示紧凑列表，支持开关、音量、移除；Session 的播放/暂停、master/muted、睡眠、Preset 选择/加载均走 N2/N4 API。加载 Preset 后保持 idle，泡泡显示“待播放”、主泡显示暂停，点击播放/泡泡才出声；`applySession` 按 revision 拒绝过期命令结果，避免旧 play 响应把 UI 改回播放态。
- 关闭窗口只断开 UI 订阅，不停止 Session；重开从 snapshot 恢复；多窗口通过 `noise.session.changed` 同步。
- 设置页的 Noise Library/Preset 功能面板沿用 N3/N4；N6 增加音境窗口内的 Preset 入口与本地轨管理。
- 验证：`cargo test --lib` 185 项、`pnpm test` 267 项、`pnpm typecheck`、`pnpm build:next` 均通过；真机听感、关闭/重开和多窗口同步待手工验收。
- 下一阶段：P4 元数据/标签或 P6 在线元数据/备份。

P4 已落地（待手工验收）：

- 迁移 `0008_music_p4.sql`：`music_tags`、`music_track_tags`、`music_smart_playlists`。
- `library.updateTrackMetadata` 写 `overrides_json` 与 `music_field_sources(source='manual')`，同步更新曲目/艺术家/专辑；扫描器对 `manual/split/online` 字段跳过覆盖，人工标题重扫测试通过。
- 标签 CRUD、Track 多标签分配、`TrackQuery.tagId` 筛选；`TrackSummary.tags` 返回标签。
- 艺术家/专辑 `merge` / `split` 保留 `merged_into_id` 与别名；智能歌单保存 `TrackQuery` 规则并在读取时实时查询。
- 资料库窗口新增曲目元数据/标签编辑弹窗与智能歌单页签；合并/拆分暂只提供 SDK/API。设置页新增「曲库整理」调试面板，覆盖元数据/标签/合并拆分/智能歌单并显示原始返回。
- 验证：`cargo test --lib` 189 项、`pnpm test` 270 项、`pnpm typecheck`、`pnpm build:next`、clippy/SDK checks 通过；真实曲库编辑、合并/拆分与智能歌单规则待手工验收。

P6 部分落地（待手工验收）：

- 歌词 sidecar 增加 `.txt` / `.srt`，按 `.lrc` → `.txt` → `.srt` 读取；内嵌歌词优先。
- `library.exportBackup` / `importBackup`：系统文件对话框 + JSON 备份，仅含歌单、喜欢、历史、标签、智能歌单与 Track ID 引用，不含音频/路径/资产；缺失 Track 跳过。
- 设置页音乐库面板新增“备份与恢复”按钮。
- 尚未实现：在线元数据、文件系统监听、缩略图。
- 验证：`cargo test --lib` 191 项、`pnpm test` 270 项、typecheck/build/clippy/SDK checks 通过。
- 剩余：在线匹配 provider、notify 监听、封面缩略图缓存。
- 下一阶段：P6 在线元数据/歌词格式/监听/缩略图/备份。
