# The Hill / 山丘时钟

GLSL 噪声堆出的山丘剪影，外加一枚居中的时间与日期。安静、几乎不耗电。

- 清单 id：`community.the-hill`
- 来源：Lively Wallpaper 社区壁纸 **The Hill**，原作
  [Yoichi Kobayashi 的 CodePen "GLSL Hills"](https://codepen.io/ykob/pen/aBrjaR)
  （其 LICENSE 记录了相对原作的全部改动）
- 许可证：MIT（见 [`LICENSE`](LICENSE)）；随包字体许可见
  [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)

## 这是什么

一个 256×256 的平面网格，顶点着色器里用 Ashima 的 Perlin 噪声（`cnoise`）推出山形，
片元着色器按到中心的距离算透明度，于是山体从中路向两侧淡出。上层叠时间、星期、日期。

## 如何使用

在「设置 → 壁纸」里选中本场景，右侧参数面板可实时调整：

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| 山体透明度 `hill-opacity` | 0–100 | 50 | 0 不可见，100 完全不透明 |
| 背景色 `background` | 颜色 | `#0e0e0e` | 场景清屏色 |
| 山体颜色 `hill-color` | 颜色 | `#ffffff` | 山体着色器的颜色 |
| 文字颜色 `font-color` | 颜色 | `#ffffff` | 时间、星期、日期的颜色 |
| 显示时间 `show-time` | 开关 | 开 | 隐藏后只留日期 |
| 显示日期 `show-date` | 开关 | 开 | 同时隐藏星期与日期 |
| 12 小时制 `hour-12` | 开关 | 开 | 关闭为 24 小时制 |
| 月日格式 `date-us` | 开关 | 关 | 开为月/日/年，关为日/月/年 |

注意：修改背景色会让原作重建一次渲染器与渲染循环，因此适配层对参数做了值去重，
只在你真正改动时触发。

原生支持 `prefers-reduced-motion`（由宿主的布局与动效设置驱动 CSS 过渡）。

## 注意与限制

- **没有鼠标交互**：原作只有 resize 监听，没有任何指针检测，所以本包不声明
  `wallpaper.pointer`，也不接收指针样本。
- 山体动画的速度是原作写死的常量，未暴露为参数（改它会牵动着色器 uniform 的语义）。
- 字体只打包实际被 `@font-face` 引用的三个文件：`Roboto-Regular`（Roboto Mono 400）、
  `Cinzel-Regular`、`DancingScript-Regular`。原目录里另外 25 个字重（Roboto 18 个
  含 Condensed 系列、Cinzel 7 个含 Decorative 系列）从未被任何 `@font-face` 引用，
  合计约 4.1 MB，已按「只迁移被依赖资源」原则舍弃。
- 原作 `css/style.css` 里注释掉的 Google Fonts `@import` 已删除：离线包不允许任何
  远程资源引用，带注释的 URL 也会被产物扫描判为违规。
- 原作依赖 jQuery 只为了 `$(window).on('resize')` 一行；保留原样以降低改动风险
  （86 KB），后续可替换为原生监听后删除。

## 文件结构

```text
the-hill/
├── catalog.json                  # community.the-hill 1.0.0
├── LICENSE                       # 原 license.txt（MIT + 改动说明）
├── THIRD_PARTY_NOTICES.md        # 随包字体与库的授权
└── scenes/the-hill/
    ├── index.html
    ├── main.js                   # Lull 适配层（参数映射，带值去重）
    ├── css/style.css
    ├── css/normalize.min.css
    ├── css/fonts/{Roboto,Cinzel,Dancing}/…   # 仅 3 个字体 + 3 份许可原文
    ├── js/script.js
    ├── js/three.min.js
    ├── js/jquery.min.js
    └── vendor/scene-sdk/         # @lull/scene-sdk 运行时副本
```

## 维护提示

```powershell
node scripts/hash-content.mjs --bundle extensions/bundled/the-hill
node Skill/lull-extension/bin/lull-ext.mjs validate extensions/bundled/the-hill --strict
```
