# The Hill —— 随包第三方组件

本场景随包分发以下第三方组件，许可证原文一并保留在包内。

## 字体

| 字体 | 文件 | 用法 | 许可 | 许可原文 |
| --- | --- | --- | --- | --- |
| Cinzel | `scenes/the-hill/css/fonts/Cinzel/Cinzel-Regular.otf` | 时钟与日期主字体 | SIL Open Font License 1.1 | [`css/fonts/Cinzel/License.txt`](scenes/the-hill/css/fonts/Cinzel/License.txt) |
| Dancing Script | `scenes/the-hill/css/fonts/Dancing/DancingScript-Regular.otf` | 星期名 | SIL Open Font License 1.1 | [`css/fonts/Dancing/SIL Open Font License.txt`](scenes/the-hill/css/fonts/Dancing/SIL%20Open%20Font%20License.txt) |
| Roboto | `scenes/the-hill/css/fonts/Roboto/Roboto-Regular.ttf` | 声明为 `Roboto Mono` 400（原作命名） | Apache License 2.0 | [`css/fonts/Roboto/Apache License.txt`](scenes/the-hill/css/fonts/Roboto/Apache%20License.txt) |

字体均以 OFL / Apache-2.0 允许的方式原样再分发，未做修改。

## JavaScript 库

| 库 | 文件 | 许可 | 说明 |
| --- | --- | --- | --- |
| Three.js | `scenes/the-hill/js/three.min.js` | MIT | WebGL 渲染 |
| jQuery | `scenes/the-hill/js/jquery.min.js` | MIT | 原作仅用于 window resize（保留原样） |

## 着色器代码

顶点着色器内的 `cnoise` / `pnoise` 来自
[Ashima Arts webgl-noise](https://github.com/ashima/webgl-noise)
（Stefan Gustavson，MIT），以 GLSL 源码形式内联在原作 `script.js` 中，
原注释与版权声明已保留。

## 场景本体

The Hill 场景本身由 Yoichi Kobayashi 以 MIT 许可发布，见包根 [`LICENSE`](LICENSE)。
