# Lull 第三方扩展体系：同类型扩展注册、发现、管理与单例运行架构 RFC

> **2026-11 实施收敛**：本文保留为问题分析。最终契约以
> [扩展槽位与 Provider](./extension-slots.md) 为准。与下文的主要差异：
>
> - 不建 SQLite `extensions` / `extension_providers` / `extension_slot_selections` 三表；
>   installed 与 providers 由目录扫描实时派生，只持久化一份 `.slots.json`。
> - `activation: "exclusive"` 不再写在 Provider 上；互斥是 Slot 的属性。
> - Category 不单独建实体，收敛为 Slot 的展示元数据。
> - 不做 mock 数据预览；v1 用可回退的一键切换，运行时预览留到后续。
> - v1 一个扩展只声明一个 Provider（固定 `widget-<id>` 只能承载一个窗口）。
> - 切换必须等宿主壳页 `widget_package_ready` 后再提交 Selected，失败回滚旧实现。
> - 不向第三方 SDK 暴露 `getProviderInfo()`；只有 active Provider 会运行。
>
> 下文中的 “我建议” 均指当时的分析，不代表最终实现。

我认为需要重新调整之前的设计思路。

你现在真正要解决的，不只是「音乐播放器和音境同一时间只能运行一个」，而是一个更完整的第三方扩展生态问题：

> 当社区中存在几十个甚至上百个同类型 Widget 时，Lull 如何统一发现、安装、分类、选择、激活和管理它们，同时确保每种功能在运行时只有一个活动实现？

这涉及三个不同的层面：

1. **扩展管理（Extension Management）**：管理所有已经安装的扩展。
2. **扩展选择（Extension Selection）**：管理用户希望使用哪个扩展。
3. **扩展运行（Extension Runtime）**：管理当前真正运行的扩展实例。

这三个层面不能混为一谈。

结合你目前的 Lull Widget SDK 设计，我建议保留现有的静态 Web 包、`widget.json`、独立 iframe、`@lull/widget-sdk` 和 postMessage 桥接机制，不必推翻现有扩展体系。

需要增加的是一套位于现有 Widget Runtime 之上的 Extension Provider / Slot 管理机制。

## 一、重新定义扩展的组织模式

我建议将扩展体系划分为三个概念：

### Extension（扩展）——安装单位

社区开发者提供的独立扩展包，每个扩展有自己的 ID、版本、Manifest、UI 和权限声明。

### Extension Category（扩展类别）——分类单位

用于组织和筛选扩展，例如音乐播放器、音境、时钟、番茄钟。

### Extension Slot（功能槽位）——运行单位

宿主为某项功能提供的唯一活动入口。同一个 Slot 同一时间只能有一个扩展实例处于 Active 状态。

这里有一个关键区别：

> **Category 负责分类，Slot 负责互斥。**

例如：

| 扩展 ID | Category | Slot |
| --- | --- | --- |
| `music-glass` | `music-player` | `music-player` |
| `music-vinyl` | `music-player` | `music-player` |
| `music-minimal` | `music-player` | `music-player` |
| `noise-nature` | `noise-controller` | `noise-controller` |
| `noise-studio` | `noise-controller` | `noise-controller` |
| `pomodoro-focus` | `productivity` | `pomodoro` |

这样，用户可以安装 20 个音乐播放器、15 个音境控制器，但运行时：

- `music-player` 只有一个活动扩展。
- `noise-controller` 只有一个活动扩展。
- `pomodoro` 可以独立运行。
- 音乐和音境可以同时运行。

## 二、整个扩展体系应该如何组织？

我建议采用以下架构：

```text
Lull Host（统一扩展管理中心）
├── Extension Registry / Installed Extensions   已安装扩展索引
├── Extension Catalog                           社区扩展目录
├── Extension Manager                           安装、更新、卸载、启用、禁用、版本兼容性检查
├── Slot Manager
│   ├── Music Slot    Music Vinyl（其他音乐扩展等待选择）
│   └── Noise Slot    Noise Studio（其他音境扩展等待选择）
├── Widget Runtime Manager                      窗口创建、iframe 加载、生命周期、实例回收
└── Host Services                               Music Service / Noise Service / Audio Output Mixer
```

这里需要注意，Extension Registry 和 Extension Catalog 不是同一件事：

- **Registry** 是本机实际安装的扩展记录。
- **Catalog** 是社区提供的扩展发现目录。
- **Slot Manager** 只管理当前用户选择的功能实现。
- **Runtime Manager** 只负责实际运行的实例。

这样即使未来社区有几百个扩展，运行时也不需要加载所有扩展。

## 三、第三方扩展如何声明自己属于哪种功能？

这里建议在现有 `widget.json` 中增加一个 `provides` 字段。

不建议直接把 `type` 扩展成音乐播放器、音境、时钟等大量业务类型，因为这样会让 Widget SDK 越来越依赖具体业务。

应该继续保留：

```json
"type": "widget"
```

再通过 `provides` 声明它提供的功能。

### 1. 音乐播放器 Manifest

```json
{
  "schemaVersion": 2,
  "type": "widget",
  "id": "music-vinyl",
  "name": "Vinyl Music Player",
  "version": "1.0.0",
  "hostApi": 1,
  "entry": "index.html",

  "provides": [
    {
      "slot": "music-player",
      "version": 1,
      "activation": "exclusive"
    }
  ],

  "capabilities": [
    "widget.theme",
    "widget.state",
    "widget.chrome"
  ]
}
```

### 2. 音境 Manifest

```json
{
  "schemaVersion": 2,
  "type": "widget",
  "id": "noise-studio",
  "name": "Noise Studio",
  "version": "1.0.0",
  "hostApi": 1,
  "entry": "index.html",

  "provides": [
    {
      "slot": "noise-controller",
      "version": 1,
      "activation": "exclusive"
    }
  ],

  "capabilities": [
    "widget.theme",
    "widget.state",
    "widget.audio",
    "widget.chrome"
  ]
}
```

### 3. 普通 Widget 不需要声明 Slot

例如时钟、天气、系统监控等普通工具：

```json
{
  "schemaVersion": 2,
  "type": "widget",
  "id": "desktop-clock",
  "name": "Desktop Clock",
  "version": "1.0.0",
  "hostApi": 1,
  "entry": "index.html",
  "capabilities": [
    "widget.theme",
    "widget.state"
  ]
}
```

没有声明 `provides`，就按照普通 Widget 处理。

这样可以保留现有第三方 Widget 的兼容性。

### 4. 为什么我推荐 exclusive 而不是 singleton？

这里两个概念容易混淆：

- **singleton**：一个扩展 ID 只允许一个运行实例。
- **exclusive**：同一个功能 Slot 只允许一个扩展占用。

例如用户安装了：

- Music Vinyl
- Music Glass
- Music Minimal

这三个扩展都有不同的 ID，但都声明了 `music-player`。

那么它们之间的互斥关系是 `exclusive`，而不是简单的扩展 ID 单例。

我的建议是：

| 机制 | 作用 |
| --- | --- |
| Extension ID | 防止同一扩展重复安装 |
| Runtime Singleton | 防止同一扩展重复运行 |
| Slot Exclusive | 防止同类功能扩展同时激活 |

这三个机制应该分别实现。

## 四、宿主如何管理大量同类型扩展？

这是整个设计中最重要的部分。

我不建议用户每次打开 Lull，都从几十个音乐播放器中选择一个。

应该采用类似浏览器扩展管理、应用启动器的管理模式。

### 1. 扩展管理页面

建议在 Lull 设置中增加独立的「扩展中心」。页面分为三个区域。

#### 已安装扩展

展示所有已经安装的扩展，无论是否正在使用。

每张卡片展示：

- 扩展图标
- 名称
- 作者
- 版本
- 功能分类
- 兼容性
- 是否启用
- 是否当前活动

#### 功能槽位管理

单独显示每种功能当前使用的扩展。例如：

| 功能槽位 | 当前实现 | 详情 | 状态 | 操作 |
| --- | --- | --- | --- | --- |
| 音乐播放器 | Vinyl Music Player | `music-vinyl` · v1.0.0 | 当前活动 | 管理 |
| 音境控制器 | Noise Studio | `noise-studio` · v1.0.0 | 当前活动 | 管理 |

#### 社区扩展发现

展示社区所有可以安装的同类型扩展。例如音乐播放器分类（已安装 3 个）：

| 扩展 | 描述 | 状态 | 操作 |
| --- | --- | --- | --- |
| Music Minimal | 极简风格播放器 | 已安装 | 预览 |
| Music Glass | 透明玻璃风格播放器 | 未安装 | 安装 |
| Vinyl Player | 复古黑胶唱片播放器 | 当前使用 | 管理 |

这里我特别建议：

> **安装扩展不等于激活扩展，启用扩展也不等于运行扩展。**

这三个状态必须区分。

### 2. 扩展的状态体系

建议定义：

| 状态 | 含义 |
| --- | --- |
| Installed | 已安装到本机 |
| Enabled | 用户允许使用 |
| Selected | 用户选择作为该 Slot 的实现 |
| Active | 当前已经启动并运行 |
| Suspended | 已暂停或窗口已销毁 |
| Failed | 启动或运行失败 |
| Incompatible | 与当前宿主 API 不兼容 |

其中：

- **Installed** 是文件和注册信息。
- **Enabled** 是用户授权和管理状态。
- **Selected** 是用户的功能选择。
- **Active** 是实际运行状态。

这可以避免很多状态混乱。

### 3. 切换扩展时不要重新安装

用户从 Music Vinyl 切换到 Music Glass 时：

```text
Music Vinyl
    ↓
停止旧 Widget Runtime
    ↓
释放旧窗口和事件订阅
    ↓
加载 Music Glass
    ↓
创建新窗口
    ↓
恢复 Music Service 当前状态
```

其他已安装的音乐播放器完全不需要加载。

只有当前 Selected 的扩展才进入 Runtime。

## 五、Slot Manager 的 Rust 设计

我建议单独建立一个 `ExtensionSlotManager`，不要把 Slot 管理逻辑直接塞进现有 Widget Window Manager。

### 1. 核心数据结构

```rust
pub struct ExtensionSlot {
    pub slot_id: String,

    // 用户选择的扩展
    pub selected_extension_id: Option<String>,

    // 当前运行的扩展
    pub active_extension_id: Option<String>,

    // 当前状态
    pub status: SlotStatus,
}

pub enum SlotStatus {
    Empty,
    Stopped,
    Starting,
    Active,
    Switching,
    Failed,
}
```

扩展注册信息：

```rust
pub struct ExtensionProvider {
    pub extension_id: String,
    pub slot_id: String,
    pub api_version: u32,
    pub enabled: bool,
    pub compatible: bool,
}
```

这里建议把 Provider 作为独立的注册关系，而不是直接把扩展目录当作运行对象。

一个扩展未来可以声明多个 Provider，但每个 Provider 都必须经过对应 Slot 的授权和兼容性检查。

### 2. 核心 API

建议提供以下宿主 API：

| API | 功能 |
| --- | --- |
| `list_extensions()` | 获取所有已安装扩展 |
| `list_providers(slot)` | 获取某功能下的全部扩展 |
| `get_slot(slot)` | 获取 Slot 当前状态 |
| `select_provider(slot, id)` | 选择某个扩展 |
| `activate_slot(slot)` | 激活当前选择的扩展 |
| `deactivate_slot(slot)` | 停止当前扩展 |
| `switch_provider(slot, id)` | 切换扩展 |
| `get_active_provider(slot)` | 查询当前活动扩展 |

这些是宿主内部 API 的建议，不需要全部暴露给第三方 Widget。

第三方 Widget 仍然只通过 `@lull/widget-sdk` 调用授权的业务服务。

### 3. 扩展切换必须具备事务语义

这里我建议采用：

> **Stop Old → Start New → Commit Selection**

也就是：

1. 锁定 Slot。
2. 验证新扩展是否安装、启用、兼容。
3. 停止旧扩展。
4. 启动新扩展。
5. 确认新窗口和 SDK 桥正常。
6. 更新 Selected 和 Active 状态。
7. 释放 Slot 锁。

如果新扩展启动失败：

- 清理新扩展的 Runtime。
- 保留原有 Selected 记录，或者按切换请求策略恢复原实现。
- 尝试重新启动旧扩展。
- 如果旧扩展也无法恢复，Slot 进入 Failed 状态。

这里需要区分 Selected 和 Active，否则切换失败时会产生错误的数据库状态。

## 六、数据库设计如何完善？

考虑到未来扩展数量会增长，我不建议把所有扩展信息直接放在一张表中。

建议至少分成三张表。

### 1. extensions：本地安装扩展

```sql
CREATE TABLE extensions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    author TEXT,
    install_path TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    host_api INTEGER NOT NULL,
    installed_at INTEGER NOT NULL
);
```

### 2. extension_providers：扩展提供的功能

```sql
CREATE TABLE extension_providers (
    extension_id TEXT NOT NULL,
    slot_id TEXT NOT NULL,
    api_version INTEGER NOT NULL,
    activation_policy TEXT NOT NULL DEFAULT 'exclusive',

    PRIMARY KEY (extension_id, slot_id),

    FOREIGN KEY (extension_id)
        REFERENCES extensions(id)
        ON DELETE CASCADE
);

CREATE INDEX idx_provider_slot
ON extension_providers(slot_id);
```

这张表的作用是：

> 快速查出所有支持 `music-player` 的第三方扩展。

### 3. extension_slot_selections：用户的功能选择

```sql
CREATE TABLE extension_slot_selections (
    slot_id TEXT PRIMARY KEY,
    selected_extension_id TEXT,
    updated_at INTEGER NOT NULL
);
```

例如：

| slot_id | selected_extension_id |
| --- | --- |
| `music-player` | `music-vinyl` |
| `noise-controller` | `noise-studio` |
| `pomodoro` | `pomodoro-focus` |

注意，**Active 不建议作为持久化状态**。

运行状态应该在 Runtime Manager 中维护，应用重启后重新初始化。

这也符合你之前确定的生命周期策略：应用退出时停止音频服务，不自动恢复播放。

## 七、如何与现有 Widget SDK 集成？

这是需要特别注意的地方。

你目前的 Widget SDK 已经有比较明确的安全边界：

- 第三方扩展是静态 Web 包。
- 宿主创建独立窗口。
- 插件运行在不透明源 iframe 中。
- 宿主能力通过 `@lull/widget-sdk` 的 postMessage 桥接。
- 插件不能直接调用 Tauri IPC。

这些设计我建议全部保留。

但需要增加一层业务服务 SDK。

### 1. 将 SDK 分为两类能力

| SDK | 职责 | 使用者 |
| --- | --- | --- |
| Widget SDK | 窗口、主题、状态、生命周期 | 所有 Widget |
| Media SDK | 音乐、音境、曲库、混音服务 | 对应业务扩展 |

例如音乐：

```ts
import {
  connectMusicService
} from "@lull/media-sdk/music";

const music = await connectMusicService();

const tracks = await music.library.listTracks();

await music.player.play(tracks[0].id);

await music.player.pause();
```

音境：

```ts
import {
  connectNoiseService
} from "@lull/media-sdk/noise";

const noise = await connectNoiseService();

const assets = await noise.assets.list();

await noise.session.start();

await noise.session.setTrackVolume(
  "rain",
  0.6
);
```

这里的 API 只是建议接口，具体方法还需要结合你之前确定的 Music Service 和 Noise Service RFC。

最重要的是：

> **扩展只能访问宿主提供的业务 API，不能自行创建第二套 Music Service 或 Noise Service。**

### 2. 是否需要让扩展 SDK 感知 Slot？

可以提供只读接口：

```ts
const provider = await lull.extension.getProviderInfo();

console.log(provider.slot);
console.log(provider.extensionId);
console.log(provider.isActive);
```

但不建议让第三方扩展拥有以下能力：

- 自己切换 Slot。
- 自己停止其他扩展。
- 自己启动同类型扩展。
- 自己修改宿主的活动扩展记录。

这些必须由 Host 管理。

## 八、需要特别设计：预览模式

当用户在社区扩展中心看到一个新的音乐播放器时，可能希望先预览，再决定是否使用。

这里容易出现一个问题：

> 如果预览 Music Glass 时直接激活 `music-player` Slot，就会导致当前 Music Vinyl 被停止。

我建议将预览和正式激活分开。

| 模式 | 行为 |
| --- | --- |
| Preview | 临时预览，不修改 Slot 选择 |
| Selected | 用户已经选择该扩展 |
| Active | 正式占用 Slot 并运行 |

预览模式可以有两种实现：

- **方案 A：独立预览窗口**
  - 使用临时预览 Runtime。
  - 不占用正式 Slot。
  - 不授予 Music Service 控制权限。
  - 只展示 UI 和模拟数据。
- **方案 B：真实功能试用**
  - 先停止当前 Slot 的旧扩展。
  - 临时启动新扩展。
  - 用户确认后正式提交选择。
  - 用户取消则恢复原扩展。

我更推荐第一种作为默认方式，第二种作为高级试用功能。

## 九、建议的项目代码组织

结合你当前的 Tauri + Rust + React 架构，我建议逐步整理为：

```text
src-tauri/
├── src/
│   ├── extensions/
│   │   ├── registry.rs
│   │   ├── installer.rs
│   │   ├── catalog.rs
│   │   ├── manifest.rs
│   │   ├── provider.rs
│   │   ├── slot_manager.rs
│   │   ├── runtime_manager.rs
│   │   ├── lifecycle.rs
│   │   └── permissions.rs
│   │
│   ├── services/
│   │   ├── music/
│   │   ├── noise/
│   │   └── audio/
│   │
│   └── commands/
│       ├── extension_commands.rs
│       ├── music_commands.rs
│       └── noise_commands.rs

packages/
├── widget-sdk/
│
├── media-sdk/
│   ├── music/
│   ├── noise/
│   └── shared/
│
└── extension-types/

examples/
└── widgets/
    ├── music-vinyl/
    ├── music-glass/
    ├── music-minimal/
    ├── noise-studio/
    └── noise-nature/
```

这里有一个架构原则：

- `registry` 不负责运行扩展。
- `slot_manager` 不负责创建窗口。
- `runtime_manager` 不负责音乐业务。
- `services` 不负责扩展 UI。

每一层保持单一职责。

## 十、实施阶段建议

我不建议一次性实现完整的社区市场和扩展调度系统，可以分四个阶段。

| 阶段 | 工作内容 | 验收目标 |
| --- | --- | --- |
| P1 | Manifest 增加 Provider 声明 | 能识别同类型扩展 |
| P2 | Extension Registry + Slot Manager | 能管理多个候选扩展 |
| P3 | Runtime 切换机制 | 同一 Slot 只能有一个活动实例 |
| P4 | 社区扩展中心 + Media SDK | 第三方可独立开发、安装和切换 |

必须通过的验收测试：

1. 安装 10 个不同音乐播放器，全部可以被正确识别。
2. 安装 10 个不同音境扩展，全部可以被正确识别。
3. 选择 Music A 后，Music B 不会自动启动。
4. 切换 Music A 到 Music B，不产生两个活动 Runtime。
5. Music A 切换到 Music B 时，音乐播放状态由宿主服务保持。
6. Music 和 Noise 可以同时运行。
7. 卸载当前活动扩展时，宿主能够清理 Runtime 和 Slot 引用。
8. 扩展启动失败时，不会产生重复窗口或错误的 Active 状态。
9. 重启 Lull 后，能够恢复用户选择的扩展，但不会自动恢复音乐和音境播放。
10. 普通 Widget 不受 Slot 独占规则影响，仍然按照原来的运行模式工作。

## 十一、最终架构决策

我把这次设计归纳成以下建议，作为 Lull 后续扩展系统的基础规范。

| 设计项目 | 推荐决策 |
| --- | --- |
| 扩展组织 | Extension + Category + Provider + Slot |
| 扩展安装 | 多个同类型扩展可以共存 |
| 扩展发现 | 本地 Registry + 社区 Catalog |
| 扩展选择 | 用户独立选择每个 Slot 的实现 |
| 同类运行 | Slot Exclusive |
| 同扩展重复运行 | Runtime Singleton |
| 普通 Widget | 保留原有运行模式 |
| 扩展 UI | 独立 iframe |
| 宿主通信 | Widget SDK + Media SDK |
| 业务数据 | 宿主 Service 统一管理 |
| 扩展切换 | Stop Old → Start New → Commit |
| 扩展预览 | 默认独立预览，不占正式 Slot |
| 应用重启 | 恢复扩展选择，不自动恢复音频播放 |

我认为最重要的三个设计原则是：

1. **安装自由**：用户可以安装任意数量的同类型第三方扩展，不应该因为已经存在一个音乐播放器就禁止安装其他播放器。
2. **选择唯一**：每个功能 Slot 只能选择一个正式实现。
3. **运行唯一**：每个独占 Slot 同一时间只能存在一个正式活动 Runtime。

还有一点值得提前确定：你目前的 Widget 文档使用 `widget-<id>` 作为窗口 label，并且默认关闭窗口只隐藏而不销毁。这个机制可以继续用于普通 Widget，但对于独占 Slot，需要明确区分「关闭窗口」和「停用 Provider」；关闭音乐播放器窗口不能让另一个音乐播放器因此获得 Slot。

**我的最终意见**：不要把 Lull 的第三方扩展体系设计成一个简单的插件加载器，而应该设计成一个具有 Provider 注册、Slot 调度和 Runtime 生命周期管理的扩展平台。

这样未来无论是音乐播放器、音境、时钟、天气、桌面信息面板，还是社区开发者提交的新功能，都能沿用同一套基础设施，而不需要每增加一种扩展就修改宿主核心架构。
