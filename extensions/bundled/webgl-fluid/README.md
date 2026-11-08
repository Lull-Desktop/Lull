# WebGL 流体模拟

五彩颜料在纯黑底上翻涌、扩散、发光的 GPU 流体模拟——PavelDoGreat 的经典之作，
也是 Lively Wallpaper 上最流行的壁纸之一。流体由 Navier-Stokes 数值解驱动，
配合 Bloom 辉光与 Sunrays 光线效果，暗部流动也通透。

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
- `script.js` 逐字节未改，`livelyPropertyListener` / `livelyAudioListener`
  等桥接函数原样保留（Lull 下不会被调用，无害）。

## 运行行为

- 启动时随机注入 5–24 个涡旋，随后流体在耗散中逐渐扩散、淡出——这是上游的
  默认行为：自动补溅（原 3.5 秒定时器）由 Lively 属性开关控制，在本包中保持
  关闭。
- 桌面版沿用的鼠标交互与音频可视化依赖宿主桥接，壁纸形态下不可用。

## 性能

多 pass framebuffer（速度/密度/压强迭代 + bloom + sunrays），GPU 消耗较高，
清单声明 `performance.tier = high`、目标 60fps。低端核显设备可预期帧率下降。

## 安装

下载 `.zip` → Lull **设置 → 扩展 → 从文件安装** → **壁纸 → 场景**
选「WebGL 流体模拟」。

---

`"WebGL 流体模拟" scene package from Lull Community, licensed MIT.
https://github.com/Lull-Desktop/Lull-Community/tree/main/content/scenes/webgl-fluid`
