# 声之潮汐（音频响应示例）

演示 `wallpaper.audio`：宿主把音乐、音境与最终输出分析成标准化的 `AudioFrame`，
场景只做视觉映射，不接触 PCM、不控制播放或音量。

## 视觉与呼吸灯

1.0.1 按 Voice Tides 设计稿调整为深黑蓝背景、蓝紫青玻璃频谱柱、居中标题、
五段名称和数值，并保留右侧阈值说明。潮汐纹理与微光粒子由本地 `tides.svg` 绘制，
无需远程图片、字体或网络权限。窄屏下阈值说明保留在底部，避免遮挡频谱。

每根柱子的 `.breath` 装饰层使用 CSS `breathe` 动画：**5.6 秒、ease-in-out、
透明度 0.22 → 0.88 → 0.22**，各柱错开 1.1 秒。渐变边缘与柔和光晕随之明暗，
不会改动音频控制的柱高、实际数值、灵敏度与 0.76 低频闪光阈值。
潮汐和余烬两种配色均适用。无声音时保留微弱的装饰呼吸，频谱本身回落。

系统或宿主启用减少动态效果时，呼吸灯固定为柔和亮度，并隐藏瞬态闪光；
宿主隐藏场景时暂停呼吸动画。布局和动画见 `scenes/audio-demo/styles.css`，
音频订阅与平滑逻辑仍在 `src/main.ts`。

## 声明

```json
{
  "capabilities": [
    "wallpaper.viewport",
    "wallpaper.canvas",
    "wallpaper.params",
    "wallpaper.script",
    "wallpaper.audio"
  ],
  "audio": {
    "sources": ["music", "noise", "mix"],
    "features": ["level", "bands"]
  },
  "compatibility": { "hostApi": 5, "platforms": ["windows"] }
}
```

- `wallpaper.audio` 必须与 `wallpaper.script` 同时声明，并要求 `hostApi >= 5`。
- `audio.sources` 可收窄到场景真正需要的来源；省略 = 四来源全开。
- 来源语义：`music`（音乐总线）、`noise`（音境总线）、`mix`（两者汇合、master 音量之前）、
  `master`（主音量之后、limiter 之前）。`mix` 与 `master` 不是同一来源。

## 映射

| 视觉参数 | 信号 | 代码 |
| --- | --- | --- |
| 整体呼吸 / 亮度 | `level.normalized` | `smoothAudioValue` 按 rAF 插值 |
| 瞬时光效 | `bass` 显示值 | 阈值 0.76，快速释放 |
| 五段频谱柱 | `bands.*` | 对数刻度 + 逐段 AGC → 0.06 门限 + gamma 0.85 |
| 雾 / 背景 | `noise` 来源的 `level.normalized` | `--noise` |
| 灵敏度 | Manifest 参数 `sensitivity` | 只缩放视觉，不改音量 |

频段刻度（对数 + 逐段 AGC）：Media Engine 用 `getFloatFrequencyData` 的 dB 值做能量
平均，映射到 −70…−6 dBFS → 0–1；Rust 侧每个频段再围绕自己约 4s 的近期平均做 ±9 dB
归一化，并混入绝对分量。持续段落因此停在 0.4–0.7，快节奏的鼓点能推到 0.8–1.0，
安静段回落到接近 0。阈值建议 0.7–0.85（强调瞬态）；整体响度请用
`level.normalized`，不要用 `bands` 比较音量。场景侧只做门限与 gamma，**不要**再叠加
第二层自动增益。

频段的平滑也更快：AnalyserNode 约 0.5（≈70ms）、Rust 约 41/130ms、场景约 25/90ms。
不要把任一层的 release 调回几百毫秒，否则快速鼓点会被再次抹平。

连续量必须插值：数据以 20Hz 更新，渲染仍按 `requestAnimationFrame`。`active=false`
时目标归零，由 release 包络自然淡出。

每根柱子下方会显示 **0.00–1.00 的实际显示值**（含 `sensitivity`、0.06 门限与
gamma），方便对照 0.76 阈值线和排查“为什么这根柱子这么高”。

## 构建与安装

```bash
pnpm scenes:sdk                 # 先构建 @lull/scene-sdk（含 dist）
pnpm scenes:samples:build       # 本目录 src/main.ts → scenes/audio-demo/main.js
pnpm content:hash --bundle examples/scenes/audio-demo
pnpm content:pack examples/scenes/audio-demo --out artifacts
```

然后从设置页「扩展」的「从文件安装」选择生成的 zip 并启用；已安装 1.0.0 时可更新到 1.0.1。需要宿主 API 5 及以上；旧宿主会在
Manifest 层拒绝 `wallpaper.audio`，不会加载半可用的场景。

## 预期表现

- 播放音乐：五根对数频谱柱随 `bass/lowMid/mid/highMid/treble` 起伏，低频越过
  虚线阈值（0.76）时触发短时光效；柱高应随段落明显升降，而不是五根一起满格。
- 只播音境：频谱变化较小，雾与背景随音境能量缓慢明暗。
- 同时播放：`mix` 驱动整体呼吸，音乐频段仍然可见。
- 暂停 / 静音 / 停止：`active=false`，音频响应在约 300–800ms 内回落，装饰呼吸灯继续柔和明暗。
- 关闭壁纸总开关或多屏中某块屏：音频分发停止/按窗口裁剪，不影响其他屏。
