# Medusae / 水母

深海里的发光水母群：软体物理驱动的触须、漂浮颗粒、镜头光晕与后期辉光。

- 清单 id：`community.medusae`
- 来源：Lively Wallpaper 社区壁纸 **Medusae**，原作
  [jpweeks/particulate-medusae](https://github.com/jpweeks/particulate-medusae)
  （Jay Weeks，2014–2016）
- 许可证：**The Artistic License 2.0**（见 [`LICENSE`](LICENSE)）
- 宿主要求：`hostApi >= 3`（使用 `wallpaper.pointer`）

## 这是什么

一群半透明水母由 Particulate.js 的粒子-约束-力系统驱动，Three.js 负责渲染，
并叠了一层自定义的脏镜头 / 眩光后期。画面上还有三个性能面板，分别显示
粒子数、约束数与力数量。

## 如何使用

在「设置 → 壁纸」里选中本场景即可，**本包没有可配置参数**（原作本来也没有
Lively 参数面板，场景只提供页内按钮）。

- 鼠标：光标在壁纸范围内移动时，会以约每 0.7 秒一次的频率在光标位置"点一下"，
  扰动附近的水母群。原作的行为是单击扰动、拖动不扰动，这里把"指针移动"
  映射成位置准确的合成单击，所以不需要真的点击桌面图标。
- 原作的控制条（About / Particles / Colors / Post FX / Run Sim）节点仍保留在
  页面里，但**不会显示**：原作的 `<div id="container-controls" style="visibility: hidden">`
  从未被清除，启动时只把 `className` 改成了 `active`（只影响 `opacity`），
  因此这排按钮在壁纸上看不到也点不到——Lively 版本即如此，属于原作遗留行为。

## 注意与限制

- **音频已移除**：原目录缺少 `build/static/audio/` 下的 4 个音频文件
  （`bg-loop`、`buzz-wave-4`、`bubbles-1`、`bubbles-2`），加载必然失败。
  包内保留音频组件与按钮节点（`ToggleComponent` 构造时会读它的 `className`，
  删元素会抛错），但按钮 `display: none`，且 `app.min.js` 里 4 处
  `loadBuffer` 已补空 `catch`，不会产生未捕获拒绝。
- **指针只有移动**：Lull 的场景指针协议不含点击/滚轮/按键，所以原作里
  「拖动旋转镜头」（OrbitControls）不可用，镜头由场景自身的动画驱动。
- **本包属于 Artistic 2.0 的「Modified Version」**：相对原作做了以下修改，
  按许可要求在此声明——
  1. 内联了 `three.min.js` 以便离线运行（与原作 Lively 适配版一致）；
  2. 移除 `#about` 弹层里指向站外的超链接，改为纯文本署名；
  3. 隐藏 Audio 按钮并为音频加载补空 `catch`（音频资源缺失）；
  4. 删除未使用的 Lively 平台元数据与预览图。
- 渲染负载较高（软体物理 + 后期处理，逻辑步进 30fps），低端 GPU 上建议不要
  同时开启多个壁纸窗口。

## 文件结构

```text
medusae/
├── catalog.json                   # community.medusae 1.0.0
├── LICENSE                        # 原 license.txt（Artistic 2.0 全文）
└── scenes/medusae/
    ├── index.html
    ├── main.js                    # Lull 适配层（指针 → 合成单击）
    ├── build/static/css/style.css
    ├── build/static/img/favicon.ico
    ├── build/static/js/three.min.js
    ├── build/static/js/app.min.js
    └── vendor/scene-sdk/          # @lull/scene-sdk 运行时副本
```

## 维护提示

```powershell
node scripts/hash-content.mjs --bundle extensions/bundled/medusae
node Skill/lull-extension/bin/lull-ext.mjs validate extensions/bundled/medusae --strict
```
