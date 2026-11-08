# WebGL 流体模拟

五彩颜料在纯黑底上翻涌、扩散、发光的 GPU 流体模拟——PavelDoGreat 的经典之作，
也是 Lively Wallpaper 上最流行的壁纸之一。流体由 Navier-Stokes 数值解驱动，
配合 Bloom 辉光与 Sunrays 光线效果，暗部流动也通透。

在 Lull 中，鼠标在桌面上的移动会持续注入颜料与速度，形成跟手的光带；
点击、双击、右键与滚轮仍然直接作用于桌面。

## 来源与许可

- 原作：[WebGL-Fluid-Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation)
  （MIT，Copyright (c) 2017 Pavel Dobryakov）
- 本包基于 rocksdanister 的
  [Lively 适配版](https://github.com/rocksdanister/WebGL-Fluid-Simulation)
  做最小转换，许可沿袭 MIT，详见 `LICENSE`。

## 转换说明

按「行为零改动、只删死代码」的原则：

- 移除 `dat.gui.min.js`、`logo.png`、`iconfont.ttf` 及 index.html 里对应的
  加载标签与配套 CSS（dat.GUI 在 Lively 版中从未被调用，这些是死代码/死资源）；
- 移除两张 Lively 专属背景图与 Lively 清单文件（背景图只能被 Lively 属性
  系统切换，本包默认纯黑底）；
- `script.js` 的模拟主体逐字节未改，只在文件末尾追加了一段自包含的 Lull
  场景桥（`lullPointerBridge`），负责 `wallpaper.pointer` 的握手与坐标换算；
  `livelyPropertyListener` / `livelyAudioListener` 等 Lively 桥接函数原样保留
  （Lull 下不会被调用，无害）；
- 浏览器预览用的 `mousemove` / `touch*` 监听保留，直接用浏览器打开仍可交互。

## 运行行为

- 启动时随机注入 5–24 个涡旋，随后流体在耗散中逐渐扩散、淡出——这是上游的
  默认行为：自动补溅（原 3.5 秒定时器）由 Lively 属性开关控制，在本包中保持
  关闭。
- 鼠标移动会经 `wallpaper.pointer` 注入流体：位置跟手，快速划动时按约
  32px 间隔补间（最多 2 段），30Hz 采样也能连成连续拖尾。
- 鼠标静止约 120ms、移出桌面层（任务栏 / 其他应用 / 开始菜单）、壁纸窗口
  隐藏时停止写入；恢复时只重新锚定，不会从旧位置拉出一条长线。采样中断
  （窗口隐藏 / 系统休眠）或位置瞬间跳变（跨屏瞬移）也按重新锚定处理。
- 点击、双击、右键、滚轮与键盘都不进入场景桥：壁纸窗口保持输入穿透，桌面
  图标与窗口照常响应。
- 音频可视化依赖 Lively 音频桥，Lull 下不可用。

## 可调参数（`wallpaper.params`）

清单声明 `wallpaper.params` 后，设置页会按下列参数生成控件；修改会经
`frame.params` 热更到场景，不需要重启壁纸。

| 参数 | 类型 / 范围 | 默认 | 说明 |
| --- | --- | --- | --- |
| `mouse-follow` | boolean | `true` | 关闭后鼠标移动不再注入颜料 |
| `random-splats` | boolean | `false` | 每 3.5 秒自动补溅 |
| `quality` | enum：`high` / `medium` / `low` / `very-low` | `high` | 液体分辨率 1024 / 512 / 256 / 128 |
| `sim-resolution` | enum：`32` / `64` / `128` / `256` | `128` | 模拟网格分辨率 |
| `density` | number 0–40 | `10` | 颜料淡出速度 |
| `velocity` | number 0–100 | `20` | 速度衰减 |
| `pressure` | number 0–100 | `80` | 压力保持 |
| `vorticity` | number 0–50 | `30` | 涡旋强度 |
| `brush-size` | number 1–100 | `25` | 鼠标溅射半径 |
| `shading` | boolean | `true` | 立体明暗 |
| `colorful` | boolean | `true` | 鼠标颜色持续变化 |
| `bloom` | boolean | `true` | Bloom 辉光 |
| `bloom-intensity` | number 10–200 | `80` | 辉光强度 |
| `bloom-threshold` | number 0–100 | `60` | 辉光阈值 |
| `sunrays` | boolean | `true` | 阳光射线 |
| `sunrays-weight` | number 30–100 | `100` | 射线权重 |
| `background` | color | `#000000` | 画布背景颜色 |

说明：

- 默认值以本包当前的 `config` 为准，保证加参数后画面不变；与 Lively 原面板的
  默认值不同（例如 Lively 的 velocity / pressure / bloom intensity）。
- `quality` / `sim-resolution` 变化会重建 framebuffer，可能有短暂重置；
  `shading` / `bloom` / `sunrays` 切换会重编译 shader，可能有一帧左右卡顿。
- `colorful` 只控制鼠标颜色的循环；自动补溅仍然每次随机取色，不是单色模式。
- `background` 改变的是画布填充色；首帧主题色仍是清单里的 `#000000`。
- 不支持线性过滤的设备会在启动时自动降级：画质最高 512，立体阴影 / 辉光 /
  射线保持关闭，参数不会把它们重新打开。
- Lively 面板里的 **Audio Visualiser**、**Image / Background Fit**、
  **Overlay** 和自定义颜色依赖 Lively 的音频、文件与叠加层桥，Lull 未提供
  对应 API，因此没有暴露；`BG Color` 已映射为 `background`。

## 鼠标位置 API

清单声明：

```json
{
  "capabilities": [
    "wallpaper.viewport",
    "wallpaper.canvas",
    "wallpaper.params",
    "wallpaper.script",
    "wallpaper.pointer"
  ],
  "compatibility": { "hostApi": 3, "platforms": ["windows"] }
}
```

宿主 → 场景的链路：

```text
Win32 位置采样（约 30Hz，仅桌面层）
  → Tauri 定向事件 wallpaper-pointer
  → 壁纸顶层页面换算成本地 CSS 像素
  → postMessage { v:1, type:"pointer", pointer:{ x, y, inside, moving } }
  → 场景桥 → WebGL splat
```

- 协议只有位置与移动状态，没有 `click` / `mousedown` / `wheel` 等消息类型；
  场景桥也只校验 `pointer`，未知类型直接忽略。
- `ready` 在 iframe `load` 之后发送：宿主会在 `onLoad` 里重置握手状态，
  脚本执行期同步发送的 `ready` 会被这次重置覆盖。
- `x` / `y` 是场景绘制坐标系内的 CSS 像素：`viewport` 布局以本屏 iframe
  左上角为原点，`canvas` / span 布局以共享画布左上角为原点。
- 桥按 `canvas.width / canvas.clientWidth` 换算成画布物理像素，兼容非整数
  dpr 与跨屏共享画布。
- `moving` 由宿主的 120ms 空闲阈值置为 `false` 并补发一条；`inside` 为
  `false` 时同样停止。`visibility` 隐藏时场景也会主动停止。
- 每条移动样本按约 32px 间隔补间、最多 2 段；既避免快速划动出现断点，
  也限制 30Hz 采样放大后的 WebGL 绘制次数。

## 兼容性

- `wallpaper.pointer` 要求 `compatibility.hostApi >= 3`，且必须同时声明
  `wallpaper.script`；本包已按此配置。
- 低于 host API 3 的旧宿主会在目录层跳过该场景（fail-closed），不会出现
  「能加载但收不到指针」的半可用状态。
- 即使指针采样暂时不可用（例如系统 API 失败），场景也不会报错，仍按启动
  涡旋自动演化。

## 性能

多 pass framebuffer（速度/密度/压强迭代 + bloom + sunrays），GPU 消耗较高，
清单声明 `performance.tier = high`、目标 60fps。指针移动会增加 splat pass
（每条样本最多 2 段），持续快速划动时负载高于纯待机；低端核显设备可预期帧率下降。

## 安装

随应用分发，无需单独安装。源码运行时先执行 `pnpm extensions:build`，然后在
**设置 → 壁纸 → 场景** 选「WebGL 流体模拟」。

## 维护

本目录是预构建包。若按 [`extensions/bundled/README.md`](../README.md) 的步骤
从 Lull Community 重新同步，需要同时把 `js/script.js` 末尾的场景桥、参数字段
以及 `catalog.json` 的能力/兼容性改动带回上游，否则复制步骤会覆盖本次修改。

---

`"WebGL 流体模拟" scene package from Lull Community, licensed MIT.
https://github.com/Lull-Desktop/Lull-Community/tree/main/content/scenes/webgl-fluid`
