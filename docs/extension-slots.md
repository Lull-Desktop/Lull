# 扩展槽位与 Provider：官方模块的可替换运行契约

> 状态：**P1–P3 已落地，P4 加固中**。本文是 Lull 第三方扩展体系中「同类功能互斥、
> 官方模块可被替换、第三方同类扩展如何管理和运行」的唯一契约。
>
> 关联文档：[第三方扩展体系 RFC](./Lull%20第三方扩展体系.md)（问题分析）、
> [扩展中心](./extension-center.md)（安装 / 启用 / 授权 / 卸载）、
> [官方扩展](./official-extensions.md)（随包分发）、
> [Widget SDK](./widget-sdk.md)（包格式与能力）、
> [Media Service](./media-service.md)（播放与白噪音状态）、
> [架构与模块边界](./architecture.md)（模块与 IPC 接线）。
>
> **与 RFC 的关系**：RFC 保留为问题分析；本文收敛其实现细节。主要差异：
> 不建 SQLite 扩展表；不把 `activation` 写在 Provider 上；Category 收敛为 Slot 元数据；
> 不做假数据预览；v1 一个扩展只声明一个 Provider；切换必须等宿主壳页 ready 后再提交。

## 0. 一句话

**扩展负责声明它想提供哪种功能，宿主 Slot 负责该功能同一时间只运行一个实现，Media Service
负责跨实现保留播放/白噪音状态。**

官方 `player`、`noise` 只是 Slot 的默认 Provider，不再拥有特殊运行路径；第三方用同一份
`widget.json`、同一个 iframe 沙箱、同一套 Media SDK 参与竞争。

## 1. 目标与非目标

### 1.1 目标

- 用户可以安装任意数量的音乐播放器、白噪音控制器，全部出现在扩展中心。
- 每个功能槽位只选择、只运行一个正式实现；切换失败可回滚。
- 官方播放器/白噪音仍默认可用，但可被第三方替代，也可随时切回。
- 关闭窗口不等于让出 Slot；结束运行、停用、卸载的语义可区分。
- 音乐与白噪音可同时运行；切换 UI 不打断播放 / Noise Session。
- 普通 Widget（未声明 `provides`）完全保持现有行为。
- 应用重启恢复用户选择，但不自动开窗、不自动播放。

### 1.2 非目标

- 在线扩展市场 / Catalog / 评分 / 截图浏览。
- 自动更新、版本回滚、增量下载、远端撤销列表。
- 扩展 SQLite 数据库或持久化运行状态。
- 运行时预览窗口 / mock 数据预览。
- 允许第三方创建 Slot、切换其他 Slot、停止其他扩展、修改宿主选择。
- 一个扩展同时声明多个 Provider（固定 `widget-<id>` label 只能承载一个窗口）。
- 改变现有 iframe 沙箱、能力授权、签名与完整性策略。

## 2. 概念

| 概念 | 含义 | 事实源 |
| --- | --- | --- |
| **Extension** | 一个可安装的 Widget 包 | `widgets/<id>/` + `.grants.json` |
| **Slot** | 宿主提供的功能槽位，如音乐播放器、白噪音 | 宿主 Rust 常量表 |
| **Provider** | 声明了 `provides` 的扩展，是某个 Slot 的候选实现 | 扩展清单，实时派生 |
| **Selected** | 用户为该 Slot 选择的 Provider | `widgets/.slots.json` |
| **Active** | 当前真正有 WebView 窗口的 Provider | 运行时窗口表，不持久化 |
| **Category** | Slot 的展示分类，如 `audio` | Slot 定义中的元数据 |

### 2.1 三个层面

1. **管理**：安装、卸载、启用、逐能力授权、完整性校验。沿用扩展中心。
2. **选择**：每个 Slot 当前用哪个 Provider。新增 `.slots.json`。
3. **运行**：当前哪个 Provider 有窗口。新增 Slot Manager，只做调度，不创建窗口。

### 2.2 官方模块如何拓展

| 需求 | 机制 | 是否占 Slot | 示例 |
| --- | --- | --- | --- |
| 替换官方播放器 / 白噪音 | 声明 `provides`，用户在扩展中心「使用」 | 是 | Vinyl Player 替代 `player` |
| 伴随官方模块 | 普通 Widget，声明只读/媒体控制能力，不声明 `provides` | 否 | 歌词、可视化、遥控器 |
| 改造官方包 | 开发模式 shadow 同名 id；正式分发必须 fork 新 id | 是（fork 版） | 本机改 `extensions/official/player` |
| 新工具 | 新 Widget 包；属于已有 Slot 就声明 `provides` | 视声明 | 番茄钟（当前无 Slot） |
| 新功能槽位 | 宿主发布 Slot 定义 + Host Service / 能力 | 宿主决定 | 未来「睡眠定时器」Slot |

> Slot 互斥只约束声明了 `provides` 的扩展。一个声明了 `media.player.control` 但未声明
> `provides` 的普通 Widget 按「遥控器 / 伴侣」处理，不占 Slot。宿主无法也不应该从能力
> 反推作者的 UI 意图。

## 3. 包格式：`provides`

继续使用 `widget.json`，`schemaVersion: 2`，不升版本。新增可选数组：

```json
{
  "schemaVersion": 2,
  "type": "widget",
  "id": "music-vinyl",
  "name": "Vinyl Music Player",
  "version": "1.0.0",
  "license": "MIT",
  "hostApi": 1,
  "entry": "index.html",
  "provides": [{ "slot": "music-player", "version": 1 }],
  "capabilities": [
    "widget.ui",
    "widget.theme",
    "widget.state",
    "widget.media",
    "widget.chrome",
    "media.player.read",
    "media.player.control",
    "media.player.volume.write",
    "media.queue.read",
    "media.queue.write",
    "media.library.read",
    "media.library.directory.read",
    "media.library.favorites.write"
  ],
  "window": {
    "width": 880,
    "height": 552,
    "minWidth": 500,
    "minHeight": 520,
    "resizable": false,
    "transparent": true,
    "chrome": "custom"
  }
}
```

规则：

| 字段 | 规则 |
| --- | --- |
| `provides` | 可选；v1 最多 1 条；缺省即普通 Widget |
| `provides[].slot` | `^[a-z][a-z0-9-]{1,31}$`，必须命中宿主已知 Slot 才能成为 Provider |
| `provides[].version` | 正整数；v1 只支持 `1` |
| `provides[].activation` | 不再属于契约；出现时忽略，Skill 校验器提示 |
| 未知 Slot | 安装允许，记录 warning；不注册为 Provider；按普通 Widget 运行 |
| >1 条 | 安装 / 预览拒绝 `manifest.provides-multiple` |
| 已知 Slot 但缺必需能力 | 安装 / 预览拒绝 `manifest.provider-capability-missing` |

`provides` 不参与能力授权，不新增 `widget.provider` 能力。插件仍只能通过
`@lull/widget-sdk` 与 `@lull/media-sdk` 访问宿主；不能切换 Slot、停止其他扩展、修改
`.slots.json`。

## 4. Slot 注册表

v1 只开放两个 Slot。定义在宿主 Rust 中，第三方不能创建 Slot。

| Slot | 默认 Provider | 必需能力 | 推荐能力 |
| --- | --- | --- | --- |
| `music-player` | `player` | `widget.media`、`media.player.read`、`media.player.control` | `media.player.volume.write`、`media.queue.read`、`media.queue.write`、`media.library.read`、`media.library.directory.read`、`media.library.favorites.write` |
| `noise-controller` | `noise` | `widget.media`、`media.noise.session.read`、`media.noise.session.control` | `media.noise.tracks.read`、`media.noise.tracks.write`、`media.noise.volume.write`、`media.noise.presets.read`、`media.noise.presets.write`、`media.noise.library.read` |

- 必需能力缺失：安装拒绝；已安装但用户撤销时，Slot `unavailable`。
- 推荐能力缺失：仅警告，不阻断。
- Slot 名称/描述走宿主 i18n（`slot_*` 键），托盘与设置共用。
- 新增 Slot 必须随宿主版本发布，并补齐对应 Host Service / 能力；这是宿主边界，不是社区可配项。

### 4.1 资格

一个 Provider 可被选择/启动，必须同时满足：

1. 包存在，Listing 有效，`provides` 命中已知 Slot，版本受支持。
2. 包状态不是 `invalid` / `tampered` / `needs-review`（`unverified` 允许）。
3. `enabled = true`。
4. 声明能力 ∩ 实际 granted 能力 ⊇ Slot 必需能力。
5. 没有其他切换占用该 Slot。

不合格原因稳定为：`disabled`、`incompatible`、`missing-capabilities`、`package-invalid`、
`not-ready`。

## 5. 持久化

### 5.1 文件

路径：`%APPDATA%\app.lull.desktop\widgets\.slots.json`，跟随 `LULL_WIDGETS_DIR`
（开发/测试）。不新增数据库。

```json
{
  "version": 1,
  "slots": {
    "music-player": "player",
    "noise-controller": "noise"
  }
}
```

- 原子写：临时文件 + rename；写失败返回错误，不留下半文件。
- 损坏：日志 + 默认值，不阻塞启动。
- 未知 Slot key 原样保留，不参与运行。
- **Selected 持久化；Active 不持久化。**

### 5.2 初始与回退规则

| 场景 | 行为 |
| --- | --- |
| 文件不存在 / 该 Slot 无记录 | 若默认 Provider 已安装且已启用，写入默认选择；不激活 |
| Selected 被禁用 / 能力不足 / 包损坏 | 保留 Selected，Slot `unavailable`；不自动切换 |
| 显式卸载当前 Selected | 回退默认 Provider（若可用），否则清空；不自动启动 |
| 扫描目录暂时不可读 / 列表为空 | 不清空 Selected，避免误伤 |
| 应用重启 | 恢复 Selected；不自动开窗 |

## 6. 运行模型

### 6.1 状态

```text
empty ──use──► starting ──ready──► active
                  │                  │
                  │ fail             ├─ close（隐藏）→ active(visible=false)
                  ▼                  ├─ stop / deactivate → stopped
                failed               └─ window destroyed → stopped
stopped ──activate──► starting ──ready──► active
unavailable（Selected 存在但资格不足）──启用/补授权──► stopped
```

- `active` 由 `widget-<selected>` 窗口是否存在推导。
- `starting` / `switching` / `failed` / `error` 只在内存，不落盘。
- 窗口存在但隐藏仍算 `active`；`visible` 单独返回给 UI。
- 应用重启后状态为 `stopped` / `unavailable`。

### 6.2 `extensions_slot_use` 事务

1. 获取 Slot 忙锁；已占用返回 `slot.busy`。
2. 校验目标 Provider（Slot、版本、包状态、enabled、必需能力）。
3. 读取旧 Selected；防御性停止同 Slot 其他残留 Provider 窗口。
4. 若旧 Provider 在运行：标记 `switching`，停止旧窗口，等待消失（≤2s）。
5. 打开新窗口，等待宿主壳页调用 `widget_package_ready`（≤12s）。
6. 再次确认新 Provider 仍可用（未被禁用/卸载/撤销能力）。
7. 原子写 `.slots.json` 提交新 Selected。
8. 标记 `active`，清错误，广播 `slots-changed`，刷新托盘。
9. 失败：销毁新窗口；若旧 Provider 原来在运行，重启旧 Provider 并等待 ready；
   Selected 保持旧值；回滚成功则旧 `active`，回滚失败则 `failed` 并返回双错误详情。

**提交顺序**：Selected 只在启动成功后提交。不能出现「数据库已指向新实现，但新实现没起来」。

### 6.3 关闭 / 结束 / 停用 / 卸载

| 动作 | Runtime | Selected | Slot 状态 | 其他 Provider 能否占用 |
| --- | --- | --- | --- | --- |
| 关闭窗口（X / `extensions_close`） | 隐藏 | 不变 | `active`（visible=false） | 不能 |
| 结束运行（`extensions_stop`） | 销毁 | 不变 | `stopped` | 不能自动占用；可显式 use |
| 停用（`set_enabled=false`） | 销毁 | 保留 | `unavailable` | 不能；需先启用或重新选择 |
| 卸载当前 Provider | 销毁 | 回退默认/清空 | `stopped` 或 `empty` | 可重新选择；不自动启动 |
| 卸载非当前 Provider | 不变 | 不变 | 不变 | — |
| 关闭开发模式 | 销毁 dev 窗口 | shadow 官方 id 恢复官方；第三方 dev 保留但 unavailable | 不自动启动 | 需重新选择 |

### 6.4 媒体状态连续性

- 播放/白噪音状态由 Rust Media Service 持有，Provider 只是 UI。
- 切换时旧窗口销毁会断开其订阅；新 Provider `media_connect` 拿快照并订阅 `media:event`。
- 因此切换播放器 UI 不打断播放；切换白噪音 UI 不停止 Session。
- Provider 不得自行创建第二套音频服务；继续由 `media.*` 能力与 bridge token 强制。

## 7. 宿主 API

### 7.1 命令

| 命令 | 参数 | 行为 |
| --- | --- | --- |
| `extensions_slots` | — | 返回 `SlotInfo[]` |
| `extensions_slot_use` | `slot,id` | 选择并运行；停旧 → 开新 → 等 ready → 提交；失败回滚 |
| `extensions_slot_activate` | `slot` | 启动/显示当前 Selected，不清空选择 |
| `extensions_slot_deactivate` | `slot` | 停止当前 active，保留 Selected |

现有命令调整：

- `extensions_open(kind=widget,id)`：普通 Widget 不变；Provider 未选中返回 `slot.not-selected`，
  已选中等价于 `extensions_slot_activate`。
- `extensions_close(id)`：Provider 只隐藏，不清空 Slot。
- `extensions_stop(id)`：Provider 销毁窗口，Slot `stopped`，Selected 保留。
- `extensions_set_enabled` / `extensions_set_capability` / `extensions_remove` / `extensions_dev_*`：
  操作后重新计算 Slot；卸载当前 Selected 时执行回退。
- `extensions_dev_reload`：Provider 必须已选中，重载走 Slot 激活路径；未选中报错。

内部命令：

- `widget_package_ready`：宿主壳页在 iframe load / SDK ready 后调用，通知 Rust；
  加入 `window-widgets` capability，插件 iframe 不能直接调用。
- Provider 包必须通过 `@lull/widget-sdk` 连接；SDK 收到宿主 `init` 后会**补发一次** `ready`，
  避免首次 ready 先于宿主监听器而丢失。宿主壳对 Provider 只认 SDK ready，不把 iframe
  load 当作可用。

### 7.2 事件

| 事件 | 触发 | 消费方 |
| --- | --- | --- |
| `slots-changed` | 选择、激活、停用、窗口销毁、失败、回退 | 扩展中心、设置页工具列表 |
| `extensions-changed` | 安装、卸载、启用、改权限、开发包增删 | 现有消费者 + Slot 刷新 |

### 7.3 DTO

```ts
type SlotStatus =
  | "empty"
  | "stopped"
  | "starting"
  | "active"
  | "switching"
  | "unavailable"
  | "failed";

type SlotProviderInfo = {
  id: string;
  name: string;
  version: string;
  origin: "bundled" | "user" | "dev";
  enabled: boolean;
  eligible: boolean;
  selected: boolean;
  active: boolean;
  reasonCode?: "disabled" | "incompatible" | "missing-capabilities" | "package-invalid" | "not-ready";
  reason?: string;
};

type SlotInfo = {
  id: string;
  name: string;
  description: string;
  category: string;
  status: SlotStatus;
  selected?: string;
  active?: string;
  visible?: boolean;
  error?: { code: string; message: string; detail?: string };
  defaultProvider?: string;
  providers: SlotProviderInfo[];
};
```

`ExtensionInfo` / `ExtensionPreview` 增加 `provides?: { slot: string; version: number }[]`。

### 7.4 错误码

| code | 场景 |
| --- | --- |
| `slot.unknown` | 宿主不支持的 Slot |
| `slot.not-selected` | 直接打开未选中的 Provider / 未选择时 activate |
| `slot.provider-not-found` | 没有该 id |
| `slot.provider-invalid` | 该扩展没有声明这个 Slot |
| `slot.provider-disabled` | Provider 未启用 |
| `slot.provider-unavailable` | 包损坏 / 不兼容 / 缺能力 |
| `slot.capabilities-missing` | 缺少 Slot 必需能力或用户已撤销 |
| `slot.busy` | 同一 Slot 正在切换 |
| `slot.start-failed` | 窗口创建或 ready 失败 |
| `slot.rollback-failed` | 新实现失败且旧实现无法恢复 |
| `manifest.provides-multiple` | `provides` 多于 1 条 |
| `manifest.provider-capability-missing` | 已知 Slot 缺必需能力 |

## 8. UI 契约

### 8.1 扩展中心

- 扩展页签顶部增加「功能槽位」区域：Slot 名称、当前实现、状态、`切换实现`、
  `打开` / `关闭窗口` / `结束运行`。
- 「切换实现」打开 Provider 选择抽屉：列出全部候选，显示官方/开发徽章、启用状态、
  资格、缺失能力、不可用原因；只有 eligible 的项可选。
- 已安装列表保留全部扩展；Provider 卡片显示 Slot 徽章与当前实现状态。
- Provider 未选中时只显示「使用」，不提供直接「打开」，避免绕过 Slot。
- 普通 Widget 保持现有动作。

### 8.2 托盘

- 每个 Slot 一项，label 用 Slot 名称；点击 `extensions_slot_activate`。
- 不再把官方 `player` / `noise` 当普通扩展直接列。
- 「扩展」子菜单只列非 Provider 的已启用 Widget。
- 安装/启用/停用/卸载导致 Slot 可用性变化时重建；`active`/`visible` 变化不重建。

### 8.3 设置 → 偏好 → 工具窗口

- 官方工具行替换为 Slot 行：名称、当前实现、状态、开关。
- 开关 = `slot_activate` / `slot_deactivate`。
- 未选择/不可用显示原因与「去扩展中心」。

## 9. 失败模式

| 场景 | 处理 |
| --- | --- |
| 未知 Slot | 安装允许 + warning；按普通 Widget 运行；不注册 Provider |
| `provides` > 1 | 拒绝 `manifest.provides-multiple` |
| 已知 Slot 缺必需能力 | 拒绝 `manifest.provider-capability-missing`，列出缺失项 |
| 用户撤销必需能力 | Selected 保留，Slot `unavailable`；不自动切换 |
| Provider 被禁用 | 销毁窗口，Selected 保留，`unavailable`；启用可恢复 |
| Provider 被卸载 | 销毁窗口；当前 Selected 回退默认/清空；不自动启动 |
| 旧窗口未关闭 | 等待 ≤2s，仍存在则再次销毁/报错，避免两个 active |
| 新窗口创建失败 | 销毁残留；重启旧 Provider；Selected 不变 |
| 新 Provider 未 ready | 12s 超时视为失败；同上回滚；记录 id/label |
| 提交 Selected 写盘失败 | 销毁新窗口；重启旧 Provider；Selected 不变 |
| 旧 Provider 回滚失败 | Slot `failed`，错误含新旧原因；等待用户重试/选择 |
| 关闭窗口 | 只隐藏，Slot 仍归当前 Provider |
| 应用重启 | 恢复 Selected；不自动开窗/播放 |
| `.slots.json` 损坏 | 日志 + 默认；不阻塞启动 |
| 扫描目录暂时不可读 | 不清空 Selected；显示不可用 |
| 开发模式关闭 | 销毁 dev 窗口；shadow 恢复官方；第三方 dev 保留但不可用 |
| 托盘重建失败 | 保留旧菜单；不阻塞退出 |
| 官方包缺失/篡改 | Slot 无可用默认；显示诊断；不 panic |
| 普通 Widget | 走旧路径；可多开；不进入 Slot 代码 |

## 10. 验收

1. 安装 10 个音乐 Provider / 10 个白噪音 Provider，全部正确识别。
2. Music A 被选择后 Music B 不自动启动。
3. A→B 切换不产生两个活动窗口；旧窗口销毁；音乐继续播放。
4. Music 与 Noise 可同时运行。
5. 关闭音乐窗口后其他 Provider 不自动获得 Slot；托盘可重开。
6. 结束运行后 Selected 保留；重新打开正常。
7. 停用当前 Provider：销毁、unavailable、不自动切换；启用恢复。
8. 卸载当前/活动 Provider：Runtime、Selected、托盘、Slot 引用清理正确；不自动播放。
9. 新 Provider 启动失败：无重复窗口、无假 Active；旧 Provider 恢复。
10. 重启恢复 Selected，但不自动开窗/播放。
11. 普通 Widget 与伴侣 Widget 不受 Slot 独占影响。
12. 托盘每个 Slot 一项；Provider 不出现在「扩展」子菜单。
13. 官方包升级后 Selected/授权/状态 KV 保留，不触发 `needs-review`。
14. 开发模式 shadow 官方 `player`/`noise`，reload 走 Slot；关闭开发模式恢复官方。
15. `.slots.json` / 官方包 / 第三方包损坏时的降级与诊断。
16. `pnpm check`、`cargo test`、`cargo clippy` 全绿。

## 11. 实施阶段

| 阶段 | 内容 | 出口条件 |
| --- | --- | --- |
| P0 | 本文 + RFC 收敛说明 + 文档索引 | ✅ 完成 |
| P1 | `provides`、官方包声明、Skill 校验、DTO | ✅ 完成 |
| P2 | Slot defs/selection/runtime、readiness、命令、托盘 | ✅ 完成 |
| P3 | 扩展中心 Slot 面板、Provider 选择、设置页、i18n | ✅ 完成 |
| P4 | 加固、开发模式、官方升级、文档、手工验收 | 🟡 进行中 |

## 12. 最终决策表

| 设计项 | 决策 |
| --- | --- |
| 扩展组织 | Extension + Slot（Category 为 Slot 元数据） |
| 同类声明 | `widget.json.provides`，可选，最多 1 条 |
| 同类互斥 | Slot 自有策略，v1 全部 exclusive |
| 官方模块 | 默认 Provider，保留 id、只读、不可卸载 |
| 第三方安装 | 与普通 Widget 相同；安装不运行 |
| 用户选择 | 每 Slot 一个 Selected，存 `.slots.json` |
| 运行状态 | 内存 + 窗口表，不持久化 |
| 切换 | 停旧 → 开新 → 等 ready → 提交；失败回滚 |
| 关闭窗口 | 隐藏，不让出 Slot |
| 结束/停用/卸载 | 停止 Runtime；停用保留选择；卸载按规则回退 |
| 应用重启 | 恢复选择，不自动开窗/播放 |
| 数据 | 不新增数据库 |
| 预览 | 不做运行时假预览 |
| SDK | 不新增 Slot 控制 API |
