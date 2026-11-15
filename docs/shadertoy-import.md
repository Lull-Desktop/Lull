# 着色器壁纸：载入 GLSL 源码

## 这是什么

Lull 的官方着色器场景 `lull.shadertoy-wallpaper` 将用户提供的 GLSL 源码作为桌面壁纸运行。你可以粘贴源码或载入本地文件，不需要 Shadertoy API Key。

当前实现是随包 Scene 扩展，使用 WebGL 渲染。它不提供 Shadertoy 在线搜索、资源下载、Shader Content Item 库或独立导入器。此前文档中的这些流程不适用于当前版本。

## 使用步骤

1. 打开“设置 → 壁纸”，将壁纸类型选为“着色器”。
2. 在“着色器源码”参数中粘贴 GLSL 并点击“应用”，或通过“从文件载入”选择 `.glsl` / `.frag` 文件。
3. 编译成功后显示画面；失败时壁纸显示编译诊断。不要粘贴整个网页、HTML 或 JavaScript。
4. 按需调整渲染比例或动画开关。源码作为场景参数保存到 `display.json`，重启后恢复。
5. “恢复默认”会清空源码并回到随包示例。没有提供源码时也会运行该示例。

多 Pass 源码需要用注释分节，将 Common、Buffer / Volume / Image 等部分合并到同一输入框；不能假设网页上的多个标签会被自动下载或合并。

## 支持范围

| 能力 | 当前行为 |
| --- | --- |
| Shadertoy Image | 支持 `mainImage(out vec4 fragColor, in vec2 fragCoord)` |
| 普通片元着色器 | 支持自带 `main()` 的 GLSL 源码 |
| 多 Pass | 支持 Common、Buffer A–D、Volume A–D、Image A–D 和最终 Image 的分节与受支持绑定 |
| WebGL 版本 | 优先 WebGL2；只有 WebGL1 时仅运行兼容的 GLSL ES 1.00 路径 |
| Volume Pass | 需要 WebGL2 和 `EXT_color_buffer_float`，纹理由 shader 在本地生成 |
| 参数 | 源码长度受限；渲染比例为 0.25–1，动画开关可冻结时间 |

## 输入与兼容限制

- 它实现的是部分 Shadertoy 风格的 GLSL 运行能力，不等于完整的 Shadertoy 环境。
- 真实纹理、音频、视频、摄像头、键盘通道和远程资源不由此场景加载；部分通道使用占位数据，依赖这些输入的画面可能与原作不同。
- cubemap、外部 3D 纹理资源及 `#include` 不受支持；本地生成的 Volume 纹理有独立支持条件。
- 鼠标通道只提供位置，不提供点击、拖拽、滚轮或键盘交互。
- Scene SDK 的 `wallpaper.audio` 是另一条用于扩展开发的只读音频响应接口，不意味着任意 Shadertoy 音频输入都可直接运行。
- 同步模式的 shader 时间在本地午夜回卷；对连续时间有依赖的作品可能出现跳变。

## 排错

| 现象 | 检查方式 |
| --- | --- |
| 源码无法编译 | 阅读壁纸上的编译日志，确认只提供 GLSL、入口正确、多 Pass 分节完整 |
| 提示需要 WebGL2 | 当前图形环境无法提供该源码所需能力，改用 WebGL1 兼容源码或兼容环境 |
| 画面与原作不同 | 检查是否依赖真实纹理、声音、键盘或其他外部输入；这些通道可能是占位数据 |
| 多 Pass 输出异常 | 检查分节名称、最终显示 Pass 和通道绑定 |
| 渲染开销较高 | 降低渲染比例；Volume 作品还需检查体积纹理尺寸与图形环境能力 |

## 源码与素材归属

随包默认示例与用户载入的源码保留各自的许可。能在本地运行不表示可以重新分发；发布自己的作品或扩展时应确认相应素材声明。

完整多 Pass 语法、Bindings、uniform 与兼容细节见[场景实现说明](../extensions/official/shadertoy-wallpaper/README.md)。默认示例归属见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
