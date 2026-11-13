# 隐藏 WebView2 / WebGL 稳定性报告（P3）

> 状态：**工具链已就绪，真机 2 小时长跑与目视验收尚未执行；`self-loop` 保持 experimental，不转正。**
>
> 关联：[Game Runtime §19·P3](./game-runtime.md)｜[Game SDK](./game-sdk.md)｜[RFC Phase 3](./rfc/RFC-Game-Runtime.md)

## 1. 结论

| 问题 | 结论 | 依据 |
| --- | --- | --- |
| `host-tick` 能否作为默认权威模式 | 可以（P1–P3 已落地） | Rust 驱动 tick、独立于隐藏 WebView 的生命周期；338+ 单测与既有验收 |
| `self-loop` 能否转正 | **暂不转正，保持 experimental** | 尚缺 2h 真机长跑、WebGL context 丢失与多屏目视数据 |
| 隐藏 WebView2 是否适合承载 Authority | 未定 | 需要完成 §3 的 T1/T2/T6/T7 |
| 多屏 mirror/span 是否通过 | 未定 | 本机有 2 块显示器，但当前 Lull 配置每屏使用不同场景，尚未组织同一游戏的 mirror/span 验收 |

**转正门槛**：§4 的「P0 必过项」全部通过，且 T1/T2 的 2 小时数据达到阈值；否则 `self-loop` 继续标记 experimental，默认仍推荐 `host-tick`。

## 2. 环境基线

本次自动采集（`node scripts/game-stability-report.mjs`）：

| 项 | 值 |
| --- | --- |
| OS | Windows 11 企业版 10.0.26300 |
| CPU | AMD Ryzen 7 5800X（8C/16T） |
| RAM | 63.9 GB |
| GPU | NVIDIA GeForce RTX 3060，驱动 32.0.16.1088 |
| WebView2 Runtime | 156.0.4314.58 |
| 显示器 | `\\.\DISPLAY1` 1920×1080 @(0,0) 主屏；`\\.\DISPLAY2` 2048×1152 @(-2560,0) |
| Lull display.json | 两屏均启用；当前 DISPLAY1=`lull.video`、DISPLAY2=`lull.bamboo`。验收前在设置页「游戏 → 设为壁纸」把两屏切到同一个游戏；`display.game` 优先于每屏场景 |

> 更换机器、WebView2 版本、GPU 驱动或显示器拓扑后，需要重新采集基线。

## 3. 测试矩阵

| ID | 场景 | 步骤 | 指标 | 通过标准 |
| --- | --- | --- | --- | --- |
| T1 | host-tick 2h | 启动一个 host-tick 游戏，隐藏 Authority 窗，保持 2h | `game_runtime_diagnostics` 的 ticks/commits、uptime、lease 剩余；SDK probe 的帧率/长帧/heap | 无 stall >5s；tick 均值在 `tickMs ±10%`；长帧比例 <2%；heap 增长 <30MB 或 <25% |
| T2 | self-loop 2h | 安装 `examples/games/stability-probe` 并启动，保持 2h | 同上 + `contextLost/contextRestored` | 无 stall >5s；平均 FPS ≥25；contextLost=0（未主动注入时）；heap 同上 |

> T2 的 `commits` 与 `frames` 要分开看：探针用 `setInterval` 推进/提交、用 rAF
> 只做帧统计。隐藏窗口里若 `commits` 正常但 `frames=0`，说明 JS 定时器仍在跑、
> rAF 被挂起，`self-loop` 仍不能转正；若两者都为 0，则是整个隐藏 WebView 被暂停。
>
> P3 对照环境变量：
> - 默认：`self-loop` 权威窗 **1×1、visible、屏幕左上角**（避免跨源 iframe 被当成隐藏页）；
> - `LULL_GAME_AUTHORITY_HIDDEN=1`：强制隐藏，复现旧行为；
> - `LULL_GAME_AUTHORITY_VISIBLE=1`：320×240 可见窗口，方便看 Console。
| T3 | mirror 双屏 | 只安装 `community.stability-probe` 一个游戏包，设置页「设为壁纸」，两块显示器都渲染包内 `entry.replica` | 两屏画面、revision、replica 数 | 两屏都在 1s 内到同一 revision；构图一致；掉帧不导致世界分歧 |
| T4 | span 跨屏 | 游戏壁纸切 span（虚拟画布 1920+2048 宽） | 画面连续性、`canvas/view` 几何 | 跨屏无撕裂/错位；replica 几何随显示器变化刷新 |
| T5 | 单屏重建 | 关闭/重建一块显示器壁纸（或取消再设为游戏壁纸） | 实例状态、剩余 replica | 实例不停机；重建屏重新 attach 后 revision 连续；另一屏不受影响 |
| T6 | Authority 崩溃 | 任务管理器结束隐藏 authority 的 WebView2 进程，或 `taskkill` 对应进程 | failover 次数、epoch、恢复耗时、旧窗口提交 | ≤15s 恢复；epoch+1；恢复到最后一次成功提交；旧 epoch 提交被拒 |
| T7 | WebGL context loss | DevTools：`gl.getExtension('WEBGL_lose_context').loseContext(); restoreContext()` | contextLost/Restored、恢复后帧率 | 计数正确；`restoreContext()` 后 2s 内恢复绘制；无实例失败 |
| T8 | 休眠/锁屏 | 运行 30min 后休眠 30min 再唤醒 | tick 补齐、offlineMs、lease | 不重复结算离线；lease 重建；无永久 hidden |
| T9 | DPI/拓扑变化 | 修改缩放、热插拔显示器、切换 mirror/span | replica render context、重连 | `useGameReplica` 重新 attach；场景几何更新；无重复 replica 计数 |

### 3.1 手工目视部分（必须真机）

- [ ] T3/T4 每屏截图（可用 `Win+Shift+S`）并附在报告里；
- [ ] T5 重建时观察另一屏是否持续渲染；
- [ ] T6 崩溃恢复后观察画面是否停在最后提交状态；
- [ ] T7 主动注入 context loss 后画面是否恢复；
- [ ] T8 休眠唤醒后画面是否继续推进。

## 4. 判定门槛

### P0 必过（任一失败则 self-loop 不转正）

1. T1 与 T2 各连续 2h 无 Authority 崩溃/停转；
2. T2 无主动注入时 `contextLost = 0`；主动注入后必须能恢复；
3. T6 崩溃恢复 ≤15s，epoch 单调 +1，旧 authority 无法继续提交；
4. T3/T4 目视无跨屏错位、两屏世界一致；
5. T5 单屏重建不导致实例停止或存档回退；
6. 2h heap 增长 <30MB 或 <25%（若 `performance.memory` 可用）。

### P1 观察项

- 平均 FPS、p99 帧间隔、长帧比例；
- 系统休眠/锁屏后的 tick 漂移；
- GPU 驱动/WebView2 版本变化后的 context loss 率；
- 双屏不同 DPI 下的 span 几何。

## 5. 工具与操作

### 5.1 宿主运行时计数

设置页「游戏」→ 右上角「复制诊断」，得到 `game_runtime_diagnostics`：

```json
{
  "uptimeMs": 7200000,
  "instanceCount": 1,
  "replicaCount": 2,
  "controllerCount": 0,
  "pendingCommands": 0,
  "instances": [
    {
      "gameId": "community.stability-probe",
      "status": "running",
      "authorityMode": "self-loop",
      "revision": 7200,
      "ticksTotal": 0,
      "commitsTotal": 7200,
      "eventsTotal": 240,
      "renderPublishesTotal": 0,
      "lastCommitAtMs": 1760000000000,
      "lastTickAgeMs": 0,
      "leaseRemainingMs": 8000,
      "replicas": 2,
      "controllers": 0
    }
  ]
}
```

### 5.2 页面级探针

`@lull/game-sdk/diagnostics`：

```ts
import { createStabilityProbe } from "@lull/game-sdk/diagnostics";

const probe = createStabilityProbe({ canvas: webglCanvas });
probe.start();
// ... 运行 2h ...
console.log(JSON.stringify(probe.summary(), null, 2));
probe.stop();
```

输出包含 `frames / avgFrameMs / worstFrameMs / longFrames / contextLost / contextRestored / visibilityChanges / hiddenMs / memoryGrowthBytes / samples`。

### 5.3 本地事实采集

```bash
node scripts/game-stability-report.mjs --out report.md
```

采集显示器拓扑、`display.json`、`games.json`、实例 metadata 与 journal 摘要；运行时计数从设置页「复制诊断」补入。

### 5.4 测试游戏包

[`examples/games/stability-probe`](../examples/games/stability-probe)：

- **单包双入口**：`entry.authority` 负责 self-loop，`entry.replica` 是指标墙；
- WebGL 自循环 + context lost/restored 监听；
- 每秒提交统计，30s 发 `probe.stats`；
- 适合 T2/T3/T4/T6/T7/T8。

安装并启用后，在设置页「游戏」点「设为壁纸」，两块显示器会直接渲染包内
`entry.replica`，显示每个 replica 的 `displayId/mode/revision` 与最新
`frames/longFrames/contextLost/heap`。不再需要单独安装场景包。

host-tick 对照可使用 `examples/games/living-world`。

## 6. 当前执行记录

| 日期 | 项目 | 结果 |
| --- | --- | --- |
| 2026-11-05 | 工具链：诊断命令、SDK probe、报告脚本、stability-probe 示例 | ✅ 完成 |
| 2026-11-05 | 环境基线：2 显示器 / WebView2 156 / RTX 3060 | ✅ 采集 |
| 2026-11-05 | 发现并修复：`tauri.conf.json` 的 `frame-src` 漏掉 `lullgame`，导致 Authority iframe 被 CSP 拦截、所有游戏 10s 后 `authority.not_ready` | ✅ 已加回归测试（`game::authority::tests::host_csp_allows_game_authority_iframe`） |
| 2026-11-05 | 发现并修复：`GameAuthorityContext` 前端校验只接受 `mode="host-tick"`，`self-loop` 实例被拒绝，宿主壳不创建 iframe | ✅ 已接受两种模式并补 `context.test.ts` |
| 2026-11-05 | T2 预检：实例 running 144s、replica=1、revision=0、commits=0；场景停在“等待首份快照” | 修复场景 init 的 load/ready 竞态；探针改为 timer 推进 + rAF 统计；待重装 1.0.1 复测 |
| 2026-11-05 | T2 预检（1×1 visible authority）：`probe booted / init epoch=6` 正常，但提交报 `invalid type: null, expected u64` | 根因：首份快照 `{}` 覆盖了探针 `simulationMs`，`NaN` 序列化为 `null`；探针 1.0.2 合并默认字段并做数值兜底 |
| 2026-11-05 | T2 短跑 107s：revision=107、simulation=107s、frames=17437（164Hz 的 99.4%）、avg 6.08ms、worst 12.3ms、longFrames=0、contextLost=0、heap≈1.03MiB | ✅ smoke 通过；**不构成 2h 结论**，继续长跑 |
| 2026-11-05 | P4 单包双入口：指标墙迁入游戏包 `replica/`，`display.game` + `wallpaper_set_game` + `GameReplicaHost`；一个 zip 同时含逻辑与渲染 | ✅ 代码/单测完成；T3/T4 真机目视仍待执行 |
| 2026-11-05 | P4 引擎示例真机冒烟：两屏 mirror，`phaser/pixi/three-demo` 各 2 个 replica、同一 revision | ✅ 通过；**不替代** T3/T4（T3 仍要求用 `stability-probe` 跑正式矩阵） |
| 2026-11-05 | T1/T2 2h 长跑 | ⏳ 未执行 |
| 2026-11-05 | T3/T4 mirror/span 目视 | ⏳ 未执行（先「设为壁纸」把两屏切到同一游戏） |
| 2026-11-05 | T5/T6/T7/T8 | ⏳ 未执行 |

> 自动化环境只能采集静态事实与埋点数据，无法代替真机目视与 2 小时长跑；在补齐上表前，本报告不支持 `self-loop` 转正。

## 7. 决策

**保持 `self-loop` 为 experimental，默认仍推荐 `host-tick`。**

转正需要：

1. 完成 §6 的 T1–T8，并把结果填入 §6；
2. P0 必过项全部通过；
3. 在 [Game Runtime §19](./game-runtime.md) 与 [Game SDK §7](./game-sdk.md) 移除 experimental 标记，并把本报告状态改为「通过」；
4. 更新 `docs/game-runtime.md` §21 风险表与 README 成熟度说明。
