本 RFC 基于 Lull 当前的 Tauri 2 + Rust + Next.js / React + C++ Win32 DLL 架构，以及之前确定的 Media Service、Widget SDK 和社区扩展方向。

本次不推翻现有架构，而是在 src-tauri/src/media 内增加独立的 Noise 业务域，并逐步将音频输出能力抽象为共享服务。
一、架构决策与设计原则
1.1 已确定的三个决策
决策项	最终方案	架构影响
音频输出	Music + Noise 共享 Audio Output Mixer	统一音频设备和输出链路
应用重启	退出时停止，不自动恢复	不持久化活动播放状态
社区预设	只分发混音配置快照	不打包、不分发音频文件

这三个决策非常重要，因为它们决定了 Noise Service 不应该是一个独立音频播放器，而应该是 Lull 统一音频系统中的一个业务模块。
1.2 核心设计原则
1. 业务隔离，底层共享：Music 和 Noise 使用独立业务模型，但共享 Audio Output Mixer。
2. 后端权威状态：Rust 管理 Session、Track、播放状态和音频资源。
3. 资源与实例分离：Noise Asset 是素材，Noise Track 是播放实例。
4. UI 与业务解耦：官方 UI 和第三方 Widget 使用相同的 Noise API。
5. 社区配置不携带媒体：社区 Preset 只保存资源引用和参数。
6. 退出即停止：应用关闭后，音频引擎不保留运行状态。
7. 离线优先：本地素材、预设和混音功能不依赖云端 Services。

二、总体架构设计
2.1 Noise Service 在 Lull 中的位置
建议最终形成以下架构：
Lull Media Architecture
Presentation Layer
Music UI
官方播放器
Noise UI
官方混音器
Third-party Widgets
第三方扩展 UI
Other UI
其他桌面组件
Tauri IPC / Widget postMessage Bridge
Media Service Layer
Music Service
Library / Queue / Playback
Noise Service
Assets / Tracks / Sessions / Presets
Audio Runtime
Music Playback Source + Noise Mixer Source
Shared Audio Output Mixer
统一音量、混音、设备输出和音频生命周期
Audio Device Output
Windows 音频设备 / 输出流
Persistence Layer
SQLite · Repository · Assets Storage · Migrations
注意：上图表达的是逻辑架构。数据库与运行时的调用关系不代表音频 PCM 数据需要经过数据库。
2.2 Music 与 Noise 共享什么？
建议共享：
- 音频输出设备管理。
- 音频输出流。
- PCM 混音能力。
- 主音量和输出设备音量策略。
- 音频设备变化监听。
- 音频引擎诊断。
- 资源读取和解码基础设施（在后端支持相应格式的前提下）。
不建议共享：
- Music Track 与 Noise Track 数据模型。
- Music Queue 与 Noise Session。
- 歌单与混音预设。
- 音乐收藏与音境收藏。
- 音乐元数据与 Noise 分类标签。
- 两个业务域的权限和 API 命名空间。
2.3 共享 Mixer 的关键设计
这里有一个需要特别明确的架构边界：
共享 Audio Output Mixer，不等于 Music 和 Noise 必须使用同一种播放业务逻辑。
建议音频链路：
Music Playback
    │
    ├── Music Decoder
    │
    └── Music PCM Source
             │
             │
             ▼
       Shared Audio Graph
             ▲
             │
    Noise Mixer
    ├── Rain Decoder
    ├── Wind Decoder
    ├── Fire Decoder
    └── Noise PCM Source
             │
             ▼
       Audio Output Mixer
             │
             ▼
       Windows Audio Output
Audio Output Mixer 应负责：
- 接收多个 PCM Source。
- 将多个 Source 混合。
- 控制各 Source 的增益。
- 统一输出采样率和声道布局。
- 统一向音频设备提交数据。
- 处理设备中断和恢复。
Noise Mixer 负责：
- 多条 Noise Track 解码。
- Track 独立音量。
- Track 启用和禁用。
- 循环。
- 淡入淡出。
- Session 主音量。
Music Playback 负责：
- 歌曲播放。
- 队列。
- 单曲循环、列表循环。
- 随机播放。
- 歌曲进度。
重要：主音量与设备音量需要区分。
建议：
音量	所属层	作用
Music Volume	Music Service	音乐业务音量
Noise Master Volume	Noise Service	音境整体音量
Noise Track Volume	Noise Mixer	单条音轨音量
Master Output Volume	Shared Audio Graph	Lull 全部音频的总增益
Windows Device Volume	操作系统	系统音量
推荐计算关系：
\[
G_{\text{music}} = G_{\text{music-master}} \times G_{\text{music-track}}
\]
\[
G_{\text{noise}} = G_{\text{noise-master}} \times G_{\text{noise-track}}
\]
\[
G_{\text{output}} = G_{\text{source}} \times G_{\text{master-output}}
\]
实际混音还需要考虑峰值、削波保护和限幅处理。不能简单将多条音轨的 PCM 数值直接相加而不做保护。
三、Noise 数据模型设计
3.1 核心实体关系
我建议将 Noise 设计为五个主要实体：
实体	作用	是否持久化
Noise Asset	声音素材	是
Noise Category	分类	是
Noise Track	当前会话中的播放实例	否，运行时对象
Noise Session	当前混音会话	否，运行时对象
Noise Preset	保存的混音配置	是
这里根据你选择的退出策略做一个调整：
Noise Track 和 Noise Session 第一阶段都属于运行时对象，不作为需要恢复的持久化业务记录。
数据库可以保存用户最近使用的 Preset ID 等偏好，但不保存一个可自动恢复的活动会话。
3.2 Noise Asset 数据结构
export type NoiseAssetSourceType =
  | "builtin"
  | "local"
  | "community"
  | "widget";
export interface NoiseAsset {
  id: string;
  sourceType: NoiseAssetSourceType;
  sourceId: string;
  name: string;
  description?: string;
  media: {
    format: string;
    durationMs?: number;
    sampleRate?: number;
    channels?: number;
    sizeBytes: number;
    contentHash?: string;
  };
  categoryId?: string;
  tags: string[];
  capabilities: {
    loop: boolean;
    seek: boolean;
    fade: boolean;
  };
  coverAssetId?: string;
  status: "available" | "missing" | "invalid";
  createdAt: number;
  updatedAt: number;
}
资源 ID 建议使用全局唯一 ID，例如 UUID。
同时建议保留：
- sourceType：资源来源类型。
- sourceId：资源来源身份。
- contentHash：文件内容校验和。
- id：资源自身的稳定身份。
不要把资源文件路径直接作为 Asset ID。
这样即使文件移动位置，Asset ID 仍然可以保持不变。
3.3 Noise Track 数据结构
Noise Track 是运行时实例。
export interface NoiseTrack {
  id: string;
  assetId: string;
  name: string;
  state: "playing" | "paused" | "stopped";
  volume: number;
  enabled: boolean;
  loop: boolean;
  positionMs: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  order: number;
}
注意：
- id 是 Track 实例 ID。
- assetId 指向素材。
- 一份 Asset 可以创建多个 Track。
- 每条 Track 的音量、播放状态互相独立。
- Track 删除不影响 Asset。
- Track 不应该负责管理音频输出设备。
3.4 Noise Session 数据结构
export interface NoiseSession {
  id: string;
  name?: string;
  state: "idle" | "playing" | "paused";
  masterVolume: number;
  tracks: NoiseTrack[];
  createdAt: number;
}
第一阶段建议限制：
- 同一 Lull 进程只存在一个活动 Noise Session。
- Session 可以处于 idle、playing、paused。
- Session 不需要在应用退出后恢复。
- 新建 Session 不自动播放。
- 加载 Preset 时替换当前 Session 的音轨配置。
未来如果要支持多个混音场景，可以扩展为多个 Session，但应先明确音频设备资源和并发混音策略。
3.5 Noise Preset 数据结构
这是社区扩展最重要的数据对象。
export interface NoisePreset {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  cover?: string;
  source: {
    type: "builtin" | "user" | "community";
    author?: string;
  };
  masterVolume: number;
  tracks: NoisePresetTrack[];
  createdAt?: number;
  updatedAt?: number;
}

export interface NoisePresetTrack {
  assetRef: {
    assetId?: string;
    contentHash?: string;
    sourceType?: string;
    sourceId?: string;
    name: string;
  };
  volume: number;
  enabled: boolean;
  loop: boolean;
  fadeInMs?: number;
  fadeOutMs?: number;
  order: number;
}
为什么社区预设不能只保存 Asset ID？
因为社区预设可能引用作者本机的素材 ID，而使用者的电脑并没有相同的 Asset。
例如：
作者电脑：
  assetId = local:abc123
  文件 = rain.wav
用户电脑：
  assetId = local:xyz999
  文件 = rain.wav
两边是同一个声音文件，但 Asset ID 不同。
因此 Preset 应该保存资源引用描述：
1. 首选可识别的资源 ID。
2. 辅助使用内容 Hash。
3. 保留来源与资源名称。
4. 加载时允许用户映射缺失素材。
这符合你选择的「只分发混音配置快照」。
3.6 社区预设缺失素材处理
建议加载 Preset 时返回资源解析结果，而不是发现缺失资源就直接失败。
export interface PresetLoadResult {
  session: NoiseSession;
  resolved: Array<{
    presetTrackIndex: number;
    assetId: string;
  }>;
  missing: Array<{
    presetTrackIndex: number;
    expectedName: string;
    expectedHash?: string;
  }>;
}
处理规则：
情况	处理
Asset ID 完全匹配	自动关联
ID 不匹配但 Hash 匹配	提供自动匹配
Hash 不匹配但名称相同	仅提供候选，不自动关联
素材不存在	标记缺失，允许用户补充
格式不支持	标记不可播放
不要仅凭文件名自动认定两个声音是同一资源。
四、SQLite 数据库设计
4.1 表结构
建议第一阶段创建以下表：
noise_assets
noise_sources
noise_categories
noise_tags
noise_asset_tags
noise_favorites
noise_presets
noise_preset_tracks
noise_preset_favorites
不需要创建：
noise_sessions
noise_session_tracks
因为你已经选择退出停止、不自动恢复。第一阶段 Session 和 Track 是内存对象。
如果以后增加会话历史或多会话持久化，再添加相关表。
4.2 具体 SQL 设计
以下是建议的初始 Schema，实际迁移时应根据 Lull 现有 SQLite 版本、命名规则和迁移工具进行适配。
noise_sources
CREATE TABLE noise_sources (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    owner_id TEXT,
    name TEXT NOT NULL,
    root_path TEXT,
    status TEXT NOT NULL DEFAULT 'available',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
noise_assets
CREATE TABLE noise_assets (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    file_path TEXT NOT NULL,
    format TEXT NOT NULL,
    duration_ms INTEGER,
    sample_rate INTEGER,
    channels INTEGER,
    size_bytes INTEGER NOT NULL,
    content_hash TEXT,
    category_id TEXT,
    capabilities_json TEXT NOT NULL,
    cover_asset_id TEXT,
    status TEXT NOT NULL DEFAULT 'available',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (source_id)
        REFERENCES noise_sources(id)
        ON DELETE CASCADE
);
noise_categories
CREATE TABLE noise_categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT,
    icon TEXT,
    source_type TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (parent_id)
        REFERENCES noise_categories(id)
);


noise_tags
CREATE TABLE noise_tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_type TEXT NOT NULL,
    created_at INTEGER NOT NULL
);


noise_asset_tags
CREATE TABLE noise_asset_tags (
    asset_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    PRIMARY KEY (asset_id, tag_id),
    FOREIGN KEY (asset_id)
        REFERENCES noise_assets(id)
        ON DELETE CASCADE,
    FOREIGN KEY (tag_id)
        REFERENCES noise_tags(id)
        ON DELETE CASCADE
);


noise_favorites
CREATE TABLE noise_favorites (
    asset_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (asset_id)
        REFERENCES noise_assets(id)
        ON DELETE CASCADE
);
noise_presets
CREATE TABLE noise_presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    cover_asset_id TEXT,
    source_type TEXT NOT NULL,
    author TEXT,
    schema_version INTEGER NOT NULL DEFAULT 1,
    master_volume REAL NOT NULL DEFAULT 1.0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
noise_preset_tracks
CREATE TABLE noise_preset_tracks (
    id TEXT PRIMARY KEY,
    preset_id TEXT NOT NULL,
    asset_id TEXT,
    asset_hash TEXT,
    expected_name TEXT NOT NULL,
    volume REAL NOT NULL DEFAULT 1.0,
    enabled INTEGER NOT NULL DEFAULT 1,
    loop INTEGER NOT NULL DEFAULT 1,
    fade_in_ms INTEGER,
    fade_out_ms INTEGER,
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (preset_id)
        REFERENCES noise_presets(id)
        ON DELETE CASCADE,
    FOREIGN KEY (asset_id)
        REFERENCES noise_assets(id)
        ON DELETE SET NULL
);
noise_preset_favorites
CREATE TABLE noise_preset_favorites (
    preset_id TEXT PRIMARY KEY,

    created_at INTEGER NOT NULL,

    FOREIGN KEY (preset_id)
        REFERENCES noise_presets(id)
        ON DELETE CASCADE
);
4.3 数据库设计注意事项
这里有几个需要在正式编码前明确的地方。
第一，文件路径与 Asset ID 分离。
file_path 只是当前资源位置，不能用它作为稳定身份。
第二，社区预设与本地素材关联可以为空。
社区 Preset 不一定能在本机找到对应素材，因此 asset_id 允许为空。
第三，删除素材时不能级联删除预设。
素材可能被多个预设引用。删除素材后应将预设中的引用置空，保留预设配置。
第四，Asset 和 Preset 的收藏分开。
用户可以喜欢某个雨声音频，也可以喜欢某个「雨夜阅读」预设，这两个行为不应该混为一谈。
第五，资源导入和预设加载必须有事务保护。
特别是批量导入和替换 Session 时，避免出现一部分成功、一部分失败的中间状态。
4.4 关于 Asset Hash
建议采用 SHA-256。
Hash 可以用于：
- 文件去重。
- 社区预设素材匹配。
- 资源完整性验证。
- 资源版本识别。
但不建议在每次打开素材时都重新计算整个文件 Hash。

更合理的是在导入时计算，后续根据文件大小、修改时间和扫描策略判断是否需要重新校验。

五、Rust 后端接口设计
5.1 目标目录
建议：
src-tauri/src/media/
│
├── api/
│   ├── commands.rs
│   ├── events.rs
│   ├── dto.rs
│   ├── errors.rs
│   └── protocol.rs
│
├── music/
│   ├── library/
│   ├── playback.rs
│   ├── queue.rs
│   └── service.rs
│
├── noise/
│   ├── mod.rs
│   ├── assets.rs
│   ├── categories.rs
│   ├── tags.rs
│   ├── tracks.rs
│   ├── sessions.rs
│   ├── presets.rs
│   ├── service.rs
│   ├── repository.rs
│   ├── dto.rs
│   └── errors.rs
│
├── engine/
│   ├── mod.rs
│   ├── audio/
│   │   ├── mod.rs
│   │   ├── output.rs
│   │   ├── mixer.rs
│   │   ├── source.rs
│   │   ├── decoder.rs
│   │   └── device.rs
│   │
│   ├── video/
│   └── backends/
│
├── permissions/
│   └── media_access.rs
│
├── lifecycle.rs
├── config.rs
└── diagnostics.rs
这是一份目标结构，不代表当前仓库已经具备这些模块。
我建议把 noise 和 music 作为同级业务域，而不是把 Noise Service 塞进 services/playback.rs。
5.2 Rust 服务接口
建议对外提供统一的 NoiseService：
pub trait NoiseService: Send + Sync {
    // Library
    fn list_assets(
        &self,
        query: NoiseAssetQuery,
    ) -> Result<NoiseAssetPage>;

    fn get_asset(
        &self,
        asset_id: &str,
    ) -> Result<Option<NoiseAsset>>;

    // Session
    fn get_current_session(
        &self,
    ) -> Result<Option<NoiseSession>>;

    fn create_session(
        &self,
    ) -> Result<NoiseSession>;

    fn play_session(
        &self,
    ) -> Result<()>;

    fn pause_session(
        &self,
    ) -> Result<()>;

    fn stop_session(
        &self,
    ) -> Result<()>;

    // Tracks
    fn add_track(
        &self,
        asset_id: &str,
    ) -> Result<NoiseTrack>;

    fn remove_track(
        &self,
        track_id: &str,
    ) -> Result<()>;

    fn set_track_volume(
        &self,
        track_id: &str,
        volume: f32,
    ) -> Result<()>;

    fn set_track_enabled(
        &self,
        track_id: &str,
        enabled: bool,
    ) -> Result<()>;

    // Presets
    fn save_preset(
        &self,
        name: &str,
    ) -> Result<NoisePreset>;

    fn load_preset(
        &self,
        preset_id: &str,
    ) -> Result<PresetLoadResult>;
}
这里只展示核心业务接口。实际项目可以拆分成多个 Trait，减少接口职责。
5.3 Audio Engine 接口
Noise Service 不应直接依赖某个具体音频库。
建议：
pub trait AudioOutput: Send + Sync {
    fn start(&self) -> Result<()>;

    fn stop(&self) -> Result<()>;

    fn set_master_volume(
        &self,
        volume: f32,
    ) -> Result<()>;

    fn add_source(
        &self,
        source: Box<dyn AudioSource>,
    ) -> Result<AudioSourceId>;

    fn remove_source(
        &self,
        source_id: AudioSourceId,
    ) -> Result<()>;
}
音源接口：
pub trait AudioSource: Send {
    fn read_samples(
        &mut self,
        output: &mut [f32],
    ) -> Result<usize>;

    fn set_gain(
        &mut self,
        gain: f32,
    );
    fn is_finished(&self) -> bool;
}
这里的 read_samples 是逻辑示意，正式实现还需要处理：
- 固定音频帧大小。
- 采样率和声道格式。
- 解码线程与音频回调线程隔离。
- 无锁或低锁数据传递。
- 缓冲区欠载。
- 音频设备重建。
- 实时线程不执行文件 I/O 和数据库查询。
特别建议：不要在实时音频回调中执行 SQLite 操作、日志磁盘写入或复杂内存分配。
5.4 Music 和 Noise 的共享接口
可以在统一 Audio Graph 中注册不同的 Source：
pub enum AudioSourceKind {
    Music,
    Noise,
}
但不要将所有业务控制都放进：
set_track_volume()
play_track()
stop_track()
这种泛化 API 中。
Music Track 和 Noise Track 的生命周期和行为差异较大。
建议 Audio Engine 只负责音频数据流和底层输出，业务层各自管理播放逻辑。
六、TypeScript SDK 设计
6.1 SDK 包结构
建议将媒体 SDK 作为独立 npm 包：
packages/
└── media-sdk/
    ├── src/
    │   ├── core/
    │   │   ├── client.ts
    │   │   ├── types.ts
    │   │   ├── errors.ts
    │   │   └── events.ts
    │   │
    │   ├── noise/
    │   │   ├── assets.ts
    │   │   ├── tracks.ts
    │   │   ├── sessions.ts
    │   │   ├── presets.ts
    │   │   └── index.ts
    │   │
    │   ├── music/
    │   ├── adapters/
    │   │   ├── tauri/
    │   │   └── widget/
    │   │
    │   └── react/
    │       ├── useNoiseSession.ts
    │       ├── useNoiseTracks.ts
    │       ├── useNoiseLibrary.ts
    │       └── index.ts
    │
    ├── package.json
    └── tsconfig.json
6.2 核心 API
建议使用统一入口：
const media = createMediaClient({
  adapter
});
media.noise.library
media.noise.session
media.noise.tracks
media.noise.presets
media.music.player
media.music.queue
media.music.library
这样第三方开发者只需要学习一个 SDK，而不必分别接入不同的底层系统。
6.3 Noise API 定义
export interface NoiseLibraryAPI {
  listAssets(
    query?: NoiseAssetQuery
  ): Promise<NoiseAssetPage>;
  getAsset(
    assetId: string
  ): Promise<NoiseAsset | null>;
  getCategories(): Promise<NoiseCategory[]>;
  getTags(): Promise<NoiseTag[]>;
}
export interface NoiseSessionAPI {
  getCurrent(): Promise<NoiseSession | null>;
  create(): Promise<NoiseSession>;
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  setMasterVolume(
    volume: number
  ): Promise<void>;
}
export interface NoiseTrackAPI {
  add(
    assetId: string
  ): Promise<NoiseTrack>;

  remove(
    trackId: string
  ): Promise<void>;

  setVolume(
    trackId: string,
    volume: number
  ): Promise<void>;

  setEnabled(
    trackId: string,
    enabled: boolean
  ): Promise<void>;

  setLoop(
    trackId: string,
    loop: boolean
  ): Promise<void>;

  reorder(
    trackId: string,
    position: number
  ): Promise<void>;
}
export interface NoisePresetAPI {
  list(): Promise<NoisePreset[]>;
  get(id: string): Promise<NoisePreset>;
  save(name: string): Promise<NoisePreset>;
  load(id: string): Promise<PresetLoadResult>;
  delete(id: string): Promise<void>;
  importSnapshot(
    snapshot: NoisePresetSnapshot
  ): Promise<NoisePreset>;
  exportSnapshot(
    id: string
  ): Promise<NoisePresetSnapshot>;
}
6.4 建议 SDK 的实际使用方式
import { createMediaClient } from "@lull/media-sdk";
import { createWidgetAdapter } from "@lull/media-sdk/widget";
const media = createMediaClient({
  adapter: createWidgetAdapter()
});
// 获取当前混音会话
const session =
  await media.noise.session.getCurrent();
// 查询素材
const assets =
  await media.noise.library.listAssets({
    categoryIds: ["nature"],
    page: 1,
    pageSize: 20
  });
// 添加音轨
const track =
  await media.noise.tracks.add(
    assets.items[0].id
  );
// 调整音量
await media.noise.tracks.setVolume(
  track.id,
  0.5
);
// 开始播放
await media.noise.session.play();
SDK 不应让 Widget 直接知道 Tauri Command 名称，也不应该让 Widget 自己构造 postMessage 协议。
协议变化由 SDK Adapter 负责兼容。
6.5 React Hooks
官方 UI 和 React 第三方 Widget 可以使用：
function NoiseMixer() {
  const {
    session,
    loading,
    error
  } = useNoiseSession();
  const {
    setVolume,
    removeTrack
  } = useNoiseTracks();
  if (loading) return <Loading />;
  if (error) return <Error />;
  return (
    <div>
      {session?.tracks.map(track => (
        <NoiseTrackItem
          key={track.id}
          track={track}
          onVolumeChange={value =>
            setVolume(track.id, value)
          }
          onRemove={() =>
            removeTrack(track.id)
          }
        />
      ))}
    </div>
  );
}

建议 Hooks 内部采用：
- Snapshot 获取。
- 事件订阅。
- 本地状态投影。
- API 修改。
- 事件同步。
- 组件卸载后取消订阅。
不要让每个组件都独立监听全部事件。
七、Widget 权限和通信安全
这是 Lull 社区生态需要重点设计的部分。
7.1 权限清单
建议权限：
Permission	允许操作
media.noise.library.read	浏览声音素材
media.noise.session.read	读取当前 Session
media.noise.session.control	播放、暂停、停止
media.noise.tracks.read	查看音轨
media.noise.tracks.write	添加、删除、排序音轨
media.noise.volume.write	修改音量
media.noise.presets.read	查询预设
media.noise.presets.write	保存和管理预设
建议权限申请遵循最小权限原则。

例如，一个只显示当前音境状态的 Widget，只需要：
[
  "media.noise.session.read",
  "media.noise.tracks.read"
]
一个完整的混音器 Widget 则可能需要：
[
  "media.noise.library.read",
  "media.noise.session.read",
  "media.noise.session.control",
  "media.noise.tracks.read",
  "media.noise.tracks.write",
  "media.noise.volume.write",
  "media.noise.presets.read",
  "media.noise.presets.write"
]
7.2 Rust 端权限验证
不能信任 Widget 传来的身份信息。
错误方式：
await bridge.invoke("noise.play", {
  widgetId: "trusted-widget"
});

因为第三方可以修改传入的 widgetId。
正确方式：
Widget iframe
    │
    ▼
Host Bridge
    │
    ▼
根据当前窗口 label 识别 Widget
    │
    ▼
Rust 权限验证
    │
    ▼
Noise Service

权限验证至少包含：
1. 确认调用来源是受管理的 Widget。
2. 从宿主上下文获得 Widget ID。
3. 查询该 Widget 的已授权权限。
4. 检查本次 API 所需权限。
5. 检查参数合法性。
6. 执行服务。
7. 返回结构化结果。
7.3 共享 Session 的权限策略
由于你选择全局共享 Audio Output Mixer，我建议 Noise Session 也先采用单一全局会话。
但需要区分：
- Session 的全局状态。
- Widget 的访问权限。
- Widget 的 UI 状态。
例如：
官方 Noise UI ───────┐
                    │
Widget A ───────────┼── Global Noise Session
                    │
Widget B ───────────┘

Widget A 修改音量后，Widget B 和官方 UI 都收到事件。
这意味着 Widget 之间不是拥有各自独立的音频空间，而是在访问同一个用户级服务。
建议 SDK 暂时不开放创建任意全局 Session 的能力。
八、事件与状态同步
8.1 事件命名
建议统一命名：
export type NoiseEventType =
  | "noise.session.changed"
  | "noise.session.state-changed"

  | "noise.track.added"
  | "noise.track.removed"
  | "noise.track.updated"

  | "noise.track.state-changed"

  | "noise.volume.changed"

  | "noise.preset.created"
  | "noise.preset.updated"
  | "noise.preset.deleted";

8.2 事件结构
export interface NoiseEvent<T = unknown> {
  eventId: string;

  type: NoiseEventType;

  revision: number;

  timestamp: number;

  payload: T;
}
8.3 状态同步规则
建议：
Widget 初始化
    │
    ▼
获取 Noise Snapshot
    │
    ▼
订阅 Noise Events
    │
    ▼
接收增量状态
    │
    ▼
更新本地 UI
这里建议修正一个常见竞态问题：
如果先获取 Snapshot，再订阅事件，可能在两者之间漏掉状态变化。
更稳妥的做法是让 Rust 提供带 Revision 的快照和订阅机制：
- 建立订阅并取得当前 Revision。
- 获取对应 Snapshot。
- 如果订阅期间出现更新，根据 Revision 补齐增量或重新获取 Snapshot。
第一阶段也可以采用更简单的方案：先订阅，再获取 Snapshot；Snapshot 带 Revision，丢弃早于或等于该 Revision 的旧事件。
8.4 高频事件
音量滑块拖动时，不建议每次变化都广播完整 Session。
建议：
事件	处理策略
添加音轨	立即推送
删除音轨	立即推送
播放状态变化	立即推送
音量变化	节流或合并
播放进度	仅在有需要时推送
可视化数据	独立低优先级通道
Noise Service 第一阶段不必提供实时波形数据。可以等未来确定可视化 API 后再设计。
九、Noise UI 可扩展设计
Noise UI 应该被视为一个独立的前端应用，而不是 Noise Service 的组成部分。
9.1 官方 UI 结构
src/
└── features/
    └── noise/
        ├── components/
        │   ├── NoiseMixer.tsx
        │   ├── NoiseTrackItem.tsx
        │   ├── NoiseLibrary.tsx
        │   ├── NoisePresetGallery.tsx
        │   ├── NoiseMiniPlayer.tsx
        │   └── NoiseVolumeControl.tsx
        │
        ├── hooks/
        │   ├── useNoiseSession.ts
        │   ├── useNoiseTracks.ts
        │   └── useNoiseLibrary.ts
        │
        ├── pages/
        │   ├── NoiseHome.tsx
        │   ├── NoiseMixerPage.tsx
        │   └── NoiseLibraryPage.tsx
        │
        └── index.ts
9.2 官方 UI 和社区 Widget 的区别
能力	官方 UI	第三方 Widget
使用 Noise API	完整	授权后
自定义布局	完整	完整
自定义视觉主题	完整	完整
使用本地媒体绝对路径	不直接暴露	禁止
控制全局音轨	完整	授权后
使用底层音频引擎	不直接调用	禁止
使用 Rust IPC	通过官方 Adapter	禁止直接调用
创建自己的混音器 UI	可以	可以
9.3 推荐的官方 UI 功能
Noise Mixer
音轨管理、独立音量、主音量。
Noise Library
素材搜索、分类、标签、收藏。
Preset Gallery
预设浏览、保存、导入。
Noise Mini Player
轻量悬浮控制面板。

我建议官方 UI 先实现一个组合式页面：
Noise Window
    ├── Header
    ├── Current Session
    ├── Active Tracks
    ├── Add Sound
    ├── Master Volume
    └── Preset Gallery
之后再把组件拆出来，让社区开发者使用 SDK 实现不同风格的 UI。
十、社区 Preset 快照规范
你已经决定社区不分发音频文件，因此需要一个稳定的配置交换格式。
建议定义：
.lull-noise.json

10.1 示例
{
  "schemaVersion": 1,
  "type": "lull-noise-preset",
  "id": "rainy-night-reading",
  "name": "Rainy Night Reading",
  "description": "Rain, distant thunder and fireplace",
  "source": {
    "author": "community-author"
  },
  "masterVolume": 0.8,
  "tracks": [
    {
      "assetRef": {
        "assetId": "builtin:rain.light",
        "contentHash": "sha256:..."
      },
      "name": "Light Rain",
      "volume": 0.65,
      "enabled": true,
      "loop": true,
      "order": 0
    },
    {
      "assetRef": {
        "assetId": "builtin:thunder.distant",
        "name": "Distant Thunder"
      },
      "volume": 0.25,
      "enabled": true,
      "loop": true,
      "order": 1
    }
  ]
}

10.2 导入流程
导入 Preset
    │
    ▼
验证 Schema Version
    │
    ▼
验证字段与数值范围
    │
    ▼
解析 Asset References
    │
    ├── 全部找到
    │       │
    │       ▼
    │   创建 Preset
    │
    └── 存在缺失素材
            │
            ▼
       返回缺失列表
            │
            ▼
       用户手动匹配
            │
            ▼
       创建 Preset

社区 Preset 不允许：
- 包含可执行脚本。
- 包含任意本地文件路径并直接访问。
- 自动导入音频文件。
- 自动安装 Widget。
- 自动执行系统命令。
它只是一个 JSON 配置文件。
这与 Lull 社区中壁纸和 Widget 的资源分发应该保持一致：配置文件描述资源关系，不获得执行权限。
十一、生命周期管理
这是本次决策的另一个重要部分。
11.1 应用运行期间
Lull Startup
    │
    ▼
Initialize Audio Output
    │
    ▼
Initialize Music Service
    │
    ▼
Initialize Noise Service
    │
    ▼
Wait for User Action

Noise Service 初始化时：
- 加载 Asset Library 索引。
- 加载 Preset 列表。
- 初始化空 Session 或等待首次创建。
- 不自动播放。
- 不自动恢复上次音轨。
11.2 应用退出
Lull Shutdown
    │
    ▼
Stop Noise Session
    │
    ▼
Release Noise Tracks
    │
    ▼
Stop Music Playback
    │
    ▼
Release Audio Sources
    │
    ▼
Stop Shared Audio Output
    │
    ▼
Release Audio Device
    │
    ▼
Exit Process

建议由统一的 Media Lifecycle 协调退出，而不是 Music 和 Noise 分别直接关闭底层音频设备。
11.3 退出后保留什么？
数据	是否保留
Noise Asset	保留
Noise Category	保留
Noise Tags	保留
Noise Preset	保留
收藏状态	保留
当前播放音轨	不保留
当前播放位置	不保留
Session 运行状态	不保留
音量设置	可以作为用户偏好保留
上次使用的 Preset ID	可以保留，但不自动加载
这样能够满足你要求的「退出停止且不自动恢复」，同时不会丢失用户整理的声音资源和混音预设。
十二、Rust Command 与 SDK API 对照
建议第一阶段将 Tauri Commands 保持为相对稳定的 IPC 层。
Tauri Command	SDK API	说明
noise_assets_list	library.listAssets()	素材查询
noise_assets_get	library.getAsset()	素材详情
noise_categories_list	library.getCategories()	分类
noise_session_get	session.getCurrent()	当前 Session
noise_session_create	session.create()	创建 Session
noise_session_play	session.play()	播放
noise_session_pause	session.pause()	暂停
noise_session_stop	session.stop()	停止
noise_session_volume_set	session.setMasterVolume()	主音量
noise_track_add	tracks.add()	添加音轨
noise_track_remove	tracks.remove()	删除音轨
noise_track_volume_set	tracks.setVolume()	音量
noise_track_enabled_set	tracks.setEnabled()	启用状态
noise_track_loop_set	tracks.setLoop()	循环
noise_track_reorder	tracks.reorder()	排序
noise_presets_list	presets.list()	预设列表
noise_preset_save	presets.save()	保存
noise_preset_load	presets.load()	加载
noise_preset_import	presets.importSnapshot()	导入
noise_preset_export	presets.exportSnapshot()	导出
所有 Command 都应该调用 Rust Service，不应该把业务逻辑直接写在 Tauri Command 中。
十三、实施计划与验收标准
我建议分成六个阶段，而不是一次性改造所有模块。
Lull Noise Service 实施路线
1. 阶段 1：Shared Audio Output
   - 确定共享音频输出接口。
   - Music 和 Noise 接入统一 Audio Graph。
   - 统一设备生命周期。
   - 验证音乐与多路声音同时播放。
   基础设施优先
2. 阶段 2：Noise Core
   - Noise Asset。
   - Noise Track。
   - Noise Session。
   - Noise Mixer。
   - 独立音量、循环、播放暂停。
3. 阶段 3：Noise Library
   - SQLite Schema。
   - 本地素材导入。
   - 分类与标签。
   - 收藏。
   - 搜索与分页。
4. 阶段 4：Preset System
   - 预设保存。
   - 预设加载。
   - JSON 导入导出。
   - 缺失资源映射。
5. 阶段 5：Media SDK
   - Tauri Adapter。
   - Widget Bridge Adapter。
   - Noise API。
   - 事件订阅。
   - 权限检查。
6. 阶段 6：UI 扩展
   - 官方 Noise Mixer。
   - Noise Library。
   - Preset Gallery。
   - 第三方 Widget 示例。
   - SDK 文档。

13.1 第一阶段验收：Audio Output
验收项目	标准
Music 播放	可以正常播放
Noise 播放	可以正常播放
同时播放	音乐与多路 Noise 同时输出
输出设备	共享设备输出链路
音量	Music 与 Noise 可以独立控制
设备切换	按统一设备策略处理
退出	所有音频停止并释放
13.2 第二阶段验收：Noise Core
验收项目	标准
多音轨	至少 5 条音轨同时混音
独立音量	每条音轨可独立调节
主音量	可调整 Noise 整体音量
静音	可以独立禁用某条音轨
循环	支持持续循环
淡入淡出	音量变化平滑
删除	删除一条音轨不影响其他音轨
Session	可以创建、暂停、恢复、停止
至少 5 条是第一阶段测试目标，不是系统最大音轨数量。后续最大数量应根据目标机器性能和音频格式测试确定。
13.3 第三阶段验收：Library
- 支持任意数量素材，不在代码中写死资源清单。
- 支持多种音频格式，但仅限解码器明确支持的格式。
- 支持本地导入和扫描。
- 支持分类和标签。
- 支持内容 Hash。
- 支持搜索和分页。
- 文件移动或丢失后能正确标记状态。
- 删除 Asset 不会破坏已有 Preset。
13.4 第四阶段验收：Preset
- 可以将当前 Session 保存为 Preset。
- 可以加载 Preset。
- 可以导出 .lull-noise.json。
- 可以导入社区 Preset。
- 不存在的素材能够识别。
- 不同 Asset ID 但 Hash 相同可以辅助匹配。
- 缺失素材不导致整个预设数据丢失。
- Preset 不包含音频文件和可执行脚本。
13.5 第五阶段验收：SDK
- 官方 UI 和 Widget 使用相同业务 API。
- SDK 不直接暴露 Rust 内部结构。
- Widget 只能调用已授权 API。
- Widget 不能伪造身份。
- 不同 Widget 能同步 Session 状态。
- Widget 销毁后订阅正确释放。
- 不存在授权的操作必须被拒绝。
- 不暴露本地绝对路径。
13.6 第六阶段验收：UI
- 官方 Noise UI 不直接控制底层 Audio Engine。
- UI 关闭不自动停止 Session。
- UI 重开可以获取当前 Snapshot。
- 第三方 Widget 能实现独立混音器 UI。
- 多窗口操作状态保持一致。
- 官方 UI 和第三方 UI 的音量状态实时同步。

十四、主要技术风险与需要提前规避的问题
风险	可能影响	建议
音频输出接口选型不合适	Music 和 Noise 无法稳定共享	先验证统一 PCM 输出链路
解码器资源消耗过大	多音轨 CPU 占用增加	解码线程池、缓冲与格式测试
多路混音削波	声音失真	混音增益管理、限幅
设备切换	音频中断	Shared Output 统一管理设备重建
高频 IPC	UI 操作卡顿	事件合并、滑块节流
社区素材缺失	Preset 无法完整加载	资源引用映射
Widget 权限不足	第三方误用 API	Rust 端强制验证
Widget 自行播放音频	无法由 Noise Service 完全控制	明确软约束和 SDK 使用规范
退出清理顺序错误	设备未释放或崩溃	统一 Media Lifecycle
特别强调：共享 Audio Output 不代表必须共享解码器
Music 和 Noise 可以有独立解码器，也可以使用相同的底层解码库，但最终输出到同一个 Audio Graph。
建议先确定音频输出与混音协议，再选择解码后端。不要因为目前视频壁纸路径使用 media-pp，就直接把它作为音乐和音境的音频引擎。
十五、最终建议：将 Media Service 设计成三个层次
我认为 Lull 最终应该形成如下的模块边界：
层次	模块	责任
业务层	Music Service	音乐库、歌曲、播放队列
业务层	Noise Service	声音素材、音轨、混音会话、预设
业务层	Video Media Service	动态壁纸视频资源与播放
引擎层	Audio Engine	音频解码、混音、输出
引擎层	Video Engine	视频解码、纹理输出
接口层	Media API	统一 DTO、Command、事件
接口层	Media SDK	官方 UI 与第三方 Widget 适配

这里尤其需要强调：Music、Noise 和 Video Media 是不同业务域。音频与视频底层可以共享部分资源管理、诊断和生命周期基础设施，但不应该为了统一而把它们硬塞进一个过度抽象的播放器接口。
最终架构结论
Lull Media Platform
统一媒体基础设施，独立业务模型，开放 UI 扩展能力。
Music Service
Music Library · Playback · Queue · Playlists
Noise Service
Noise Library · Assets · Tracks · Sessions · Presets
Shared Audio Engine
Decoder · Mixer · Output · Device Management
Media SDK
Tauri Adapter · Widget Adapter · React Hooks · Events · Permissions
我建议实际开发时先不要急着开发 Noise UI，也不要先开发社区预设。
最重要的第一步是验证：
当前 Lull 的音频播放架构能否将 Music Playback 和多路 Noise PCM Source 接入同一个 Audio Output Mixer，并保持各自独立控制？
只要这个基础能力稳定，Noise Service 的业务模型、API 和 UI 扩展都可以逐步建设，而且不会因为前端设计变化而返工。
下一步最有价值的技术工作，是先对当前 src-tauri/src/media 进行代码级审查，确认现有 media-pp、音频输出依赖、Music 播放路径和 Tauri 生命周期之间的实际关系，再制定 Shared Audio Engine 的迁移方案。

---

## 十六、代码级审查结论（N0，2026-10-31）

### 16.1 现状

- **没有原生音频输出**：`Cargo.toml` 只有可选的 `media-pp`（视频 D3D11/NV12），没有 `cpal`/`rodio`/`symphonia`；`lull_native.dll` 也没有音频 API。
- **实际发声在隐藏 WebView**：Rust `media::playback` 只持有状态，通过 `media-engine-command` 驱动 `src/media-engine`。
- **三个独立音频图**：`AmbientStream`、`PlayerEngine` 的本地 `<audio>`、`NoiseEngine` 各自建 `AudioContext`，没有共享 bus/master/limiter/设备恢复。
- **Noise 是固定 5 层**：`noise_state` 单行表 + `layers_json`，没有 Asset/Track/Session/Preset。
- **权限只到窗口级**：`media_call` 仅 `settings/player/noise`；第三方 Widget 没有媒体权限。
- **退出顺序未统一**：`RunEvent::Exit` 保存状态、关闭 DB、关闭视频，但隐藏引擎没有显式 stop。

### 16.2 实现调整（相对本 RFC 原文）

1. **Shared Audio Output v1 放在 WebView 内**：建立一个 `AudioGraph`（musicBus / noiseBus / masterGain / limiter / analysers），而不是本期新写 Rust PCM 引擎。原因是 Rust 不接触 PCM，现有 `AmbientStream` 的程序化作曲与 5 层噪声合成都在 TS；原生重写会把 Noise 业务变成播放器内核改造。协议边界保留，未来可换原生后端。
2. **内置 Noise 使用 `procedural` Asset**：现有 5 个声音不是音频文件，V1 以稳定 ID + generator profile 表示；本地素材才走文件导入。
3. **本地素材复制到内容寻址存储**：`music/noise/assets/<sha256>.<ext>`，DB 只存 `storage_key`，不存绝对路径；导入时计算 SHA-256，不每次打开重算。
4. **单 DB**：继续使用 `music.db`，新增 `noise_*` 表；不新建第二个数据库，避免连接池/迁移/备份重复。
5. **Session/Track 不持久化**：进程内单例；只保留 master/muted、输出音量、上次 Preset ID 等偏好。保留 `noise_state` 旧表用于回滚，新代码只做一次性偏好迁移。
6. **旧 `noise.*` API 保留为兼容门面**：N2 将旧 5 层 API 映射到新 Session/Track，EtherBubbles 不必先重写。
7. **P5 与 Noise SDK 合并**：8 个 `media.noise.*` capability、Widget bridge 与 token 在 N5/P5 一次完成，不做两套媒体桥。
8. **顺序建议**：`N1 → P3 → N2 → N3 → N4 → N5/P5 → N6`。N1 必须先于 Noise；P3 与 N2 可互换；P5 必须等 P3 + N4。

### 16.3 N1 已落地内容

- Rust 新增 `media/engine.rs`（隐藏引擎窗口与 engine protocol v2）、`media/events.rs`（订阅总线、eventId/revision）、`media/output.rs`（全局输出音量）、`media/api/snapshot.rs`（组合快照）。
- `media/playback` 不再拥有订阅表与 `PlaybackSnapshot`；`media_connect` 先注册订阅再取快照。
- `system.snapshot` / `system.getOutput` / `system.setOutput` 通过 `media_call` 提供；`output.changed` 事件。
- TS 新增 `AudioGraph`/`gain.ts`；`PlayerEngine`、`AmbientStream`、`NoiseEngine` 全部接入共享 graph；engine protocol v2 增加 `output.volume`、`engine.shutdown`。
- 迁移 `0005_media_output.sql`；`music.db` 新增 `media_output`。
- 退出时先发送 `engine.shutdown`，并保留 `pagehide` 释放；设备切换 fallback 为重载引擎页并由 Rust 全量 resync。

N1 仍需手工验收：Music + 5 层 Noise 同时播放、独立音量、设备切换、2 小时长稳、退出无音频残留。

### 16.4 后续阶段要点

- **N2**：`noise_sources/assets/categories/tags/favorites/presets/preferences` 表；内置 catalog 与默认 Preset；Session/Track；旧 5 层兼容门面。
- **N3**：文件导入、hash 去重、lofty 元数据、分类/标签/收藏/搜索、缺失检测。
- **N4**：Preset 保存/加载、`.lull-noise.json` 导入导出、ID/hash/名称解析、缺失映射。
- **N5/P5**：media-sdk `./widget`、8 个 `media.noise.*` capability、Rust 方法级校验、per-window bridge token、React hooks、示例 Widget。
- **N6**：设置页功能型 Noise 面板 → EtherBubbles 动态轨道迁移；关闭 UI 不停止 Session。

### 16.5 N2 Noise Core 已落地

- 迁移 `0007_noise.sql`：Noise sources/assets/categories/tags/favorites/presets/preferences；`noise_state` 保留作回滚，偏好一次性复制到 `noise_preferences`。
- `media/noise`：`catalog.rs`（5 个 builtin procedural Asset、分类/标签、默认 + 3 个示例 Preset）、`repository.rs`、`session.rs`、`dto.rs`、`compat` 逻辑集中在 session。
- `playback` 不再持有 NoiseData；`media_connect` 快照同时返回旧 `noise` 与新的 `noiseSession`，顶层 revision 取各 domain 最大值。
- 引擎协议改为 `noise.session.sync`：Rust 下发完整 Session/Track 快照，TS `NoiseEngine` 按 trackId 建/拆 procedural 声道。
- 旧 `noise.getState/getSounds/activate/setLayer/setMaster/setMuted/setSleepTimer/reset` 保留，返回值仍是旧 `NoiseState`，内部映射同一 Session。
- Session/Track 不持久化；启动只恢复 master/muted 偏好，不自动播放。
- 验证：Rust 170 项、前端 257 项、typecheck/build/clippy/docs sync 通过；真机听感与旧 EtherBubbles 回归待手工验收。

### 16.6 N3 Noise Library 已落地

- 迁移沿用 `0007_noise.sql`；新增 `noise/assets.rs` 与 `noise/library.rs`。
- 导入：`rfd` 选择文件/文件夹 → `lofty` 元数据校验 → 复制到 `<music>/noise/assets/<sha256>.<ext>`（临时文件 + 原子 rename）→ 单 Asset 事务；重复 hash 返回已有 Asset。
- 限制：`mp3/flac/wav/ogg/m4a/aac`、100 MB、30 分钟；`revalidateAssets` 只查文件存在性，不重算 hash。
- 查询：关键字/分类/标签/收藏/状态/媒体类型/分页/排序；公开 DTO 不含 `storage_key`/绝对路径。
- 编辑/删除：仅 settings；内置 procedural Asset 不可改删；删除时 Session 中对应 Track 同步移除，Preset FK `ON DELETE SET NULL`。
- 文件播放：Rust 通过 asset protocol 生成 URL，TS `NoiseEngine` 用 `<audio crossOrigin="anonymous">` + `MediaElementAudioSourceNode` 接入 `noiseBus`。
- 事件：新增 `noise.library.changed`；独立 library revision 保证 eventId 不重复。
- 验证：Rust 177 项、前端 262 项、typecheck/build/clippy/docs sync 通过；真实文件格式矩阵与导入 UI 待手工验收。

### 16.7 N3.5 分类/标签 CRUD 已落地

- API：`noise.library.createCategory/updateCategory/deleteCategory/createTag/updateTag/deleteTag`；仅 `settings` 可写，`noise/library` 只读。
- 内置分类/标签 `source_type=builtin` 只读；用户项 `source_type=user`。
- 分类支持 `parentId`，服务层检查父分类存在、自引用与祖先循环；同父级用户分类名不区分大小写去重；存在子分类时拒绝删除。
- 标签按 `trim().to_lowercase()` 归一化，同名标签（跨内置/用户）拒绝；删除级联清理 `noise_asset_tags`。
- 删除分类由 FK 把 Asset 置为未分类；删除 Asset/Preset 的既有约束不变。
- DTO/SDK 增加 `sourceType` 与 CRUD；设置页噪声素材库面板增加分类/标签管理卡。
- 验证：Rust 177 项、前端 262 项、typecheck/build/clippy/docs sync 通过。

### 16.8 N4 Noise Presets 已落地

- API：`noise.presets.listPresets/getPreset/savePreset/updatePreset/deletePreset/loadPreset/exportPreset/importPreset/mapPresetTrack/setPresetFavorite`；settings 全量，noise 读写，library 只读，文件导入导出仅 settings。
- 保存：从当前 Session 生成 Asset 引用、content hash、source 类型/ID、expectedName、音量、enabled、loop、fade；不含音频/脚本/路径。
- 文件：`.lull-noise.json` 固定 `schemaVersion=1`、`type=lull-noise-preset`；最多 32 轨；名称/描述/音量/fade/order 校验；cover 只接受不透明 token；导入生成新本地 ID 并写 `origin_id`，不自动覆盖。
- 加载：解析顺序 assetId → contentHash → 同名候选 → missing；替换 Session 轨道与 master、state=idle、不自动播放；缺失返回 candidates，可 `mapPresetTrack` 后重载。
- 权限：内置 Preset 不可改删；加载/导出/收藏可用。删除 Preset 清 `last_preset_id` 并依赖 FK 级联 tracks/favorites。
- SDK/UI：`noise.presets.*`、Preset 类型与事件 `noise.preset.created/updated/deleted`；音境库窗口的「音境预设」页签支持保存/加载/收藏/改元数据/删除/导入导出/缺失映射。
- 验证：Rust 181 项、前端 263 项、typecheck/build/clippy/docs sync 通过；真实社区 Preset 文件与缺失映射流程待手工验收。

### 16.9 N5/P5 Widget 媒体桥已落地

- 8 个 capability：`media.noise.library.read`、`session.read`、`session.control`、`tracks.read`、`tracks.write`、`volume.write`、`presets.read`、`presets.write`；Rust `media/api/permissions.rs` 集中方法/事件映射，测试覆盖。
- `widget-*` 访问 `media_call`/`media_connect`/`media_disconnect` 必须带 Rust 生成的 bridge token；token 只在顶层壳页的 `PluginContext.bridgeToken` 中，iframe 拿不到。iframe↔壳的 init token 与媒体 token 分离。
- Widget `media_connect` 返回 redacted snapshot（output/noise/noiseSession），topic 按 read capability 过滤；player/queue/output 不向 Widget 开放。
- Widget SDK 增加 `media.call/connect/disconnect` 桥方法、`media.event` 与 `onMediaEvent`；manifest 能力扩展到 15 个（7 widget + 8 Noise）。
- Media SDK 增加 `./widget` 传输、`useNoiseSession` / `useNoiseTracks` / `useNoiseLibrary` / `useNoisePresets`；示例 `examples/widgets/noise-mixer`（含睡眠定时）与 `noise-hooks`（共享连接/重渲染/disconnect）。
- 验证：Rust 185 项、前端 266 项、typecheck/build/clippy/SDK checks 通过；5 个 widget 示例 dist 已构建。真实 iframe 越权、撤销授权待手工验收。

### 16.10 N6 官方 Noise UI 已落地

- EtherBubbles 从旧 5 层 `noise.state` 迁到 `PlaybackSnapshot.noiseSession`，订阅 `noise.session.changed` 与 `noise.level`。
- 5 个内置 procedural 继续渲染为泡泡，按 `noise:builtin:*` 映射 Session Track；缺失 Track 在点击泡泡时 `addTrack`。
- 本地轨道以紧凑列表显示在主界面与设置面板，支持开关、音量、移除；播放/暂停、master/muted、睡眠与 Preset 加载走 N2/N4 API。
- 关闭窗口只断开 `media_connect` 订阅，不发送 stop；重开取 snapshot；多窗口靠 session 事件同步。
- 设置页 N3/N4 功能面板保留；N6 在音境窗口增加 Preset 选择/加载与本地轨管理。加载后保持 idle，泡泡显示“待播放”、主泡显示暂停；`applySession` 按 revision 忽略过期命令结果。
- 验证：Rust 185 项、前端 267 项、typecheck/build/clippy/SDK checks 通过；真机听感、关闭/重开、多窗口同步待手工验收。






