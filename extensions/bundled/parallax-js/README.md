# Parallax.js / 视差灯塔

十层手绘 PNG 叠成的海岸灯塔：远山、系着云帆的绳索、三层海浪、灯柱与光晕，
按光标位置做多层视差位移。

- 清单 id：`community.parallax-js`
- 来源：Lively Wallpaper 社区壁纸 **Parallax.js**，即
  [wagerfield/parallax](https://github.com/wagerfield/parallax) 的项目主页
  （Matthew Wagerfield 与 Claudio Guglieri）
- 许可证：MIT（见 [`LICENSE`](LICENSE)）
- 宿主要求：`hostApi >= 3`（使用 `wallpaper.pointer`）

## 这是什么

每层 `<li>` 用 `data-depth` 声明自己的深度（0.00 到 1.00），parallax.js 把光标
相对窗口中心的归一化位移按 `data-scalar-x/y`（25 / 15）缩放、按
`data-friction-x/y`（0.1）做惯性平滑，再逐层位移。海浪与云帆的晃动是 CSS 动画，
与视差互不干扰。

## 如何使用

在「设置 → 壁纸」里选中本场景即可，**本包没有可配置参数**（原作把视差强度写死
在 HTML 的 `data-*` 属性里）。

鼠标行为：光标在桌面层上移动时，各层按自身深度缓缓漂移；光标停在原地时，
惯性会让位移继续收敛几个像素后静止。多屏（复制/独立）下只有光标所在的屏幕
响应：`inside=false` 的样本（光标在另一屏或别的应用窗口上）被丢弃，本屏视差
停在最后位置，与 Triangles & Light 的光斑行为一致。壁纸窗口是鼠标穿透的，
所以这里把 Lull 的指针样本重新派发成同页面的合成 `mousemove`——事件只在本
iframe 内部流转，不会影响桌面上的任何操作。

## 注意与限制

- **移除了不可达的页面元素**：原作的 About 弹层、`#toggle` 按钮、`#prompt`
  「请用手机陀螺仪」提示层、footer 与 awwwards 徽章在 Lively 版本里都已被注释或
  无法触发，且含有站外链接（离线包禁止远程引用），已整段删除。原作者署名保留在
  本 README、`LICENSE` 与 `UPSTREAM-README.md`。
- **音效/交互按钮不可用**：桌面壁纸不接收点击，原作没有任何可点的交互控件。
- 未打包的文件（合计约 1.95 MB）都确认零引用：`thumbnail.png`、`lively_p.gif`、
  `deploy/` 下的其它构建变体、`assets/scripts/js/` 里已被合并进 `libraries.min.js`
  的单文件副本、`assets/styles/sass/**` 编译源、`assets/fonts/icons/**`
  （只被已删除的 About 面板使用）、`assets/images/tilt.png`（只被 `#prompt` 使用）、
  `humans.txt` 以及构建配置（`package.json` / `bower.json` / `gulpfile.js`）。
- 随之清理了 `styles.css` 里两处已无宿主的死引用：`icons` 图标的 `@font-face`
  与 `#awwwards` 徽章（其背景图 `assets/graphics/` 在原目录里就不存在）。
  现在包内没有任何指向缺失文件的引用。

## 文件结构

```text
parallax-js/
├── catalog.json                   # community.parallax-js 1.0.0
├── LICENSE                        # MIT
├── README.md                      # 本文件
├── UPSTREAM-README.md             # 原作 parallax.js 库文档（含 API 与行为表）
└── scenes/parallax-js/
    ├── index.html
    ├── main.js                    # Lull 适配层（指针 → 合成 mousemove）
    ├── assets/styles/css/styles.css
    ├── assets/images/             # 16 张实际被引用的图片
    └── vendor/
        ├── libraries.min.js       # jQuery + Underscore + Hammer + FastClick
        ├── jquery.parallax.js     # parallax.js 插件（未压缩版）
        └── scene-sdk/             # @lull/scene-sdk 运行时副本
```

`vendor/` 用来放**未改动的第三方运行时**，这样校验器对第三方库的
`eval` / `localStorage` / `window.parent` 扫描豁免，而自写的适配层保持干净。

## 维护提示

```powershell
node scripts/hash-content.mjs --bundle extensions/bundled/parallax-js
node Skill/lull-extension/bin/lull-ext.mjs validate extensions/bundled/parallax-js --strict
```
