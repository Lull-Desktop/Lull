# Triangles & Light / 三角与光

程序化生成的三角网格，加一束跟随鼠标的光。画面完全由代码绘制，包内没有任何图片素材。

- 清单 id：`community.triangles-light`
- 来源：Lively Wallpaper 社区壁纸 **Triangles & Light**，原作
  [Maksim Surguy 的 CodePen "Triangle pattern generator"](https://codepen.io/msurguy/pen/sbIio)
- 许可证：MIT（见 [`LICENSE`](LICENSE)）
- 宿主要求：`hostApi >= 3`（使用 `wallpaper.pointer`）

## 这是什么

层层叠叠的三角网格（Delaunay 三角剖分 + Flat Surface Shader）由代码实时算出，
一束点光源跟着光标在网格上滑动，网格的环境光/漫反射色与光源的色温、距离都能调。
渲染走 Canvas 2D，不依赖 WebGL。

## 如何使用

在「设置 → 壁纸」里选中本场景，右侧参数面板可实时调整：

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| 网格环境光 `mesh-ambient` | 颜色 | `#000000` | 三角网格的环境光颜色 |
| 网格漫反射 `mesh-diffuse` | 颜色 | `#c0c0c0` | 三角网格的漫反射颜色 |
| 切片数 `mesh-slices` | 1–800 | 350 | 网格细分数量，越大三角形越密、CPU 越高 |
| 光源环境光 `light-ambient` | 颜色 | `#c0c0c0` | 跟随鼠标的光源环境色 |
| 光源漫反射 `light-diffuse` | 颜色 | `#808080` | 跟随鼠标的光源漫反射色 |
| 光源距离 `light-distance` | 0–1000 | 135 | 光源到网格的距离，越大光斑越散 |
| 鼠标跟随 `mouse-follow` | 开关 | 开 | 关闭后光斑停止跟随光标 |

参数热更不需要重启壁纸：切片数变化会重建一次网格，颜色变化只重设光色。

鼠标行为：光标在桌面层上移动时，光斑跟着滑动；光标离开桌面或壁纸不可见时，
光斑停在原地。点击、双击、滚轮仍然直接落到桌面，壁纸不拦截任何输入。

## 注意与限制

- 切片数 800 时单帧三角数量很大，低端机器可能出现掉帧；默认 350 是原作的推荐值。
- 指针通道只提供坐标与「是否在移动」，没有点击/按键事件，所以原作里
  「空格切换光源拾取/放下」「回车增加光源」这些键盘玩法在本包里不可用。
- 原作内嵌的 dat.GUI 调试面板从未被启用（`addControls()` 被作者注释），
  且它的 `localStorage` 用法与场景沙箱（opaque origin）冲突，已整块移除，
  只留一个同名的空桩。Flat Surface Shader 的 WebGL / SVG 渲染器不可达，原样保留。
- 壁纸状态里没有 `#links` / `#controls` 之类的页面元素：页脚署名靠 `LICENSE`
  与 `README.md` 保留，`#controls` 只留一个空占位节点供历史代码引用。

## 文件结构

```text
triangles-light/
├── catalog.json                 # community.triangles-light 1.0.0
├── LICENSE                      # 原 license.txt（MIT）
└── scenes/triangles-light/
    ├── index.html               # 场景页面
    ├── main.js                  # Lull 适配层（参数映射 + 指针注入）
    ├── css/style.css
    ├── js/script.js             # 原作逻辑（已移除 dat.GUI）
    └── vendor/scene-sdk/        # @lull/scene-sdk 运行时副本
```

## 维护提示

内容改动后必须重算摘要，否则安装器拒绝加载：

```powershell
node scripts/hash-content.mjs --bundle extensions/bundled/triangles-light
node Skill/lull-extension/bin/lull-ext.mjs validate extensions/bundled/triangles-light --strict
```
