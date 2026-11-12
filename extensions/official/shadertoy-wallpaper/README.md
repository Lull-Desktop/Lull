# 着色器壁纸（`lull.shadertoy-wallpaper`）

把用户自己提供的 GLSL 源码当作桌面壁纸运行。产物 id 固定为
`lull.shadertoy-wallpaper`，是官方随包 **scene** 扩展（`catalog.json` + Vite 入口）。

- 渲染：扩展内部原生 WebGL；有 WebGL2 时优先使用（GLSL ES 1.00 / 3.00），
  否则回退 WebGL1（仅 GLSL ES 1.00），无第三方渲染库；
- Profile：支持 Shadertoy Image（`mainImage`）、Volume（`mainVolume`，3D 纹理）与
  普通 fragment（自定义 `main()`），单 Pass 或多 Pass
  （Common + Volume A-D + Buffer A-D + Image A-D + Image）；外部输入使用占位值；
- 宿主边界：不新增 Rust 服务 / Tauri 命令 / Widget Bridge 路由 / Package，
  源码以普通字符串参数下发。

## 用户怎么用

1. 壁纸设置 → 壁纸类型选「着色器」；
2. 参数面板「着色器源码」里粘贴 GLSL，或点「从文件载入」选择 `.glsl` / `.frag` 文件；
3. 源码会立即编译：成功即开始渲染，失败则在壁纸上显示原始编译日志。

**没有填源码时**壁纸运行内置示例（`fixtures/default.frag`，Shadertoy 的
「The Drive Home」），所以选了这个壁纸就能看到画面，不用先去别处找 shader。
填了源码就立即换成自己的。

源码随壁纸配置（`display.json` 的 `sceneParams`）保存，重启后自动恢复；
参数面板「恢复默认」会把源码清空，等于回到内置示例。

## 参数

| key | 类型 | 说明 |
| --- | --- | --- |
| `source` | `text` | GLSL 源码，上限 128 KiB；留空时运行内置示例 |
| `render-scale` | `number` | 0.25–1，绘制分辨率比例；超过 4K 像素上限自动下调 |
| `animation` | `boolean` | 关闭后冻结 `iTime`，画面停在当前帧 |

## 内置示例

`fixtures/default.frag`（Shadertoy「The Drive Home」，Martijn Steinrucken / BigWings）
既是手工验证样例，也是**默认加载**的 shader：宿主下发的 `source` 为空（从未填写、
「恢复默认」）时，场景直接编译它，并在 `scene.log` 写一行「未填写源码，运行内置示例
着色器」。它在 WebGL1 / WebGL2 上都走单 Pass 的 Shadertoy Image 路径，不采样任何
外部输入，所以不会出现占位通道提示。

文件不进构建产物目录，构建时以 Vite `?raw` 内联成字符串（`src/scene/default-source.ts`）；
改默认画面只需要改这一个 `.frag` 文件。第三方素材授权见仓库根目录
`THIRD_PARTY_NOTICES.md`。

## 多 Pass（Common / Volume A-D / Buffer A-D / Image A-D / Image）

前端只有一个 `source` 输入框；把多个 tab 的代码合并粘贴，用**注释行分节**即可，Shader
代码本体不用改。推荐用最醒目的等号分隔：

```glsl
//==== Common ====
// [粘贴 Common 代码]

//==== Volume A ====
// [粘贴 Volume A 代码：mainVolume(out vec4 O, vec3 V)，3D 纹理]

//==== Buffer A ====
// [粘贴 Buffer A 代码]

//==== Image A ====
// [粘贴 Image A 代码：额外图像 Pass]

//==== Image ====
// [粘贴 Image 代码：最终显示]

//==== Bindings ====
BufferA.iChannel0 = VolumeA
Image.iChannel0 = ImageA
VolumeA.size = 128
```

Pass 类型：

- **Buffer A-D**：2D 反馈缓冲，入口 `mainImage`；
- **Volume A-D**：3D 体积纹理，入口 `mainVolume(out vec4 O, vec3 V)`，`V` 是体素坐标；
  仅 WebGL2 / ES 3.00，渲染到 RGBA16F 3D 纹理，可被其他 Pass 用 `sampler3D` 采样；
- **Image A-D**：额外 2D 图像 Pass，入口 `mainImage`，可被其他 Pass 采样；
- **Image**：最终显示 Pass。**缺少 Image 时，用最后一个 Image A-D 作为显示 Pass**
  （会给出警告）。

### 分隔符写法

| 写法 | 说明 |
| --- | --- |
| `//==== Buffer A ====` | 推荐；`=` 可换成 `-`、`*`、`#`、`+`、`~` |
| `//---- Buffer A ----` | 旧写法，继续支持 |
| `//== Buffer A` / `//== Buffer A ==` | 少写几个符号 |
| `// @pass Buffer A` | 指令式，最省符号 |
| `// @bindings` | Bindings 的简写 |

规则：

- 标记必须单独占一行；大小写不敏感；`BufferA` 与 `Buffer A` 等价（Volume / Image A-D 同理）。
- 只有带装饰符号或 `@pass/@bindings` 才识别；普通注释 `// Buffer A is used here`
  不会被误判。
- 顺序任意：解析时统一按 Volume A→B→C→D → Buffer A→B→C→D → Image A→B→C→D → Image
  排序（显示 Pass 最后），Common 自动拼到每个 Pass 前。
- 必须有显示 Pass（Image，或至少一个 Image A-D）；第一个标记之前只能有空行/注释
  （标题、版权头），不能有代码；重复分节/空分节会报错。
- 标记只是注释，不会进入 GLSL。

### 合并步骤

1. 先写 `//==== Common ====`（没有 Common 可省略）；
2. 粘贴 Common 代码；
3. 按需写 `//==== Volume A ====` / `//==== Buffer A ====` / `//==== Image A ====`，
   粘贴对应代码；
4. 写最终显示 Pass（`//==== Image ====`，或省略 Image 时用最后一个 Image A-D）；
5. 需要非默认通道时，最后加 `//==== Bindings ====` 和绑定行；
6. 点「应用」，不需要改 Shadertoy 代码。

### 默认通道与 Bindings

- 每个 Buffer / Volume 有独立 FBO 双缓冲；`iChannelN` 指向自己时读上一帧，形成 feedback。
- 默认绑定：Buffer A 的 `iChannel0` = 自身上一帧；Buffer B 的 `iChannel0` = 自身、
  `iChannel1` = BufferA；Buffer C/D 依此类推；Volume A-D 与 Buffer 同构（自反馈 +
  前序 Volume）；Image / Image A-D 的 `iChannel0-3` = BufferA-D；缺失目标绑定为黑色。
- Bindings 可覆盖任意通道：目标为 `BufferA-D`、`VolumeA-D`、`ImageA-D`、`Noise`、
  `Black`；`Image`（最终显示）不能作为目标。绑定到 Volume 的通道会自动声明为
  `sampler3D`（用 `texture(iChannelN, vec3)` / `texelFetch(iChannelN, ivec3, 0)` 采样）。
- `VolumeA.size = N`（8–256，默认 128）可设置体积纹理边长；注意多数体积 shader 的
  数学按 128³ 写死，改小会改变形状，仅用于性能调优或本身按分辨率归一化的 shader。
- 所有 Pass 共享 `iResolution / iTime / iFrame / iMouse`，每个 Pass 独立编译；任一
  Pass 失败时整条新管线都不替换，旧画面继续渲染。Volume Pass 的 `iResolution` 为
  `(size, size, size)`。
- 多 Pass 时按单 Pass 1080p 像素预算自动降采样；2D FBO 优先 half-float，失败回退
  RGBA8；Volume 必须 half-float（存负距离值），需要 `EXT_color_buffer_float`，不回退。
- Volume Pass 每帧渲染全部 slice（逐层绘制到 3D 纹理），开销随 `size³` 增长；
  `size=128` 时约 200 万体素/帧，弱 GPU 上可能触发性能保护。

## GLSL ES 3.00 / WebGL2

运行时优先创建 WebGL2。以下源码会走 ES3 路径：

- 显式声明 `#version 300 es`；
- 使用 `texelFetch`、`textureSize`、`int[]`、数组构造器（`vec4[N](…)`）、`round`、
  位运算、`switch`、`uint`、全局 `in/out`、`layout` 等 ES3 语法；
- Volume Pass（`mainVolume`）或任何绑定到 Volume 的 `sampler3D` 通道；
- 使用 `dFdx/dFdy/fwidth`：WebGL2 的 ES1 shader 拿不到 OES 导数扩展，必须走 ES3；
- 使用 `textureLod` / `textureGrad` / `texture2DLod` / `textureCubeLod`：ES3 保留
  显式 LOD/Grad 语义，ES1 只能退化为普通采样。

ES3 适配会注入 `#version 300 es`、ES3 顶点模板和 `out vec4 lullFragColor;`，并保留旧写法兼容：

- `texture2D` / `textureCube` / `texture2DProj` 映射到 ES3 的 `texture*`；
- `varying` 映射到 `in`；
- 自定义 `main()` 里的 `gl_FragColor` 映射到注入的 `out`，或用户已声明的 `out vec4`；
- `gl_FragData[0]` 映射到单输出数组。

ES1 源码在 WebGL2 上仍按 ES1 编译（导数 / 显式 LOD 除外，它们会自动走 ES3），
避免行为漂移。只有 WebGL1 时，ES3 源码会在编译前得到“需要 WebGL2”的明确诊断，
而不是 `texelFetch` 找不到之类的日志。

注意：这里支持的是 **GLSL 语言特性 + 程序化多 Pass / 体积纹理**，不是完整 Shadertoy
运行时。真实纹理/音频/键盘通道、cubemap、外部 3D 纹理资源和 Shadertoy 资源仍不可用
（Volume Pass 的 3D 纹理由 shader 自己生成，不加载外部资源）。

## 支持范围

支持三种入口：

- **Shadertoy Image**：`void mainImage(out vec4 fragColor, in vec2 fragCoord)`，由扩展
  包装成 WebGL 的 `main()`；
- **Shadertoy Volume**：`void mainVolume(out vec4 O, vec3 V)`，仅用于 Volume A-D 分节，
  包装成逐 slice 渲染到 3D 纹理的 `main()`（仅 WebGL2 / ES 3.00）；
- **Raw Fragment**：源码自带 `void main()`，直接编译；用 `gl_FragCoord` 取像素坐标、
  ES1 用 `gl_FragColor` 输出，ES3 也可以自己声明 `out vec4`。提供 `vUv` / `uv` /
  `vTexCoord` 三个常用 UV varying；自定义 attribute 不支持，其他 varying 名需要与
  ES3 顶点模板的输出名一致。

三种入口共享同一套 uniform、占位通道与兼容宏；ES3 / Volume 入口额外使用 ES3 模板。

支持的 uniform：`iResolution`、`iTime`、`iTimeDelta`、`iFrame`、`iFrameRate`、
`iMouse`、`iDate`、`iChannel0-3`、`iChannelResolution`、`iChannelTime`、`iSampleRate`。

`iMouse` 采用 Shadertoy 的位置语义：`xy` 是绘制缓冲像素、原点左下（与
`gl_FragCoord` 一致）；指针离开绘制面/桌面或切到其他窗口时保留最后一次位置，
不会跳回负坐标；宿主只提供 30Hz 光标位置，没有按键通道，`zw` 恒为 `0`（未点击）。

外部输入没有真实来源，由运行时绑定占位值：

- `iChannel0`：256×256 RGBA 程序化白噪声（种子固定，跨启动一致）；
- `iChannel1-3`：1×1 黑色；
- `iChannelResolution[0] = 256×256×1`，其余 `1×1×1`；`iChannelTime[*] = 0`；
  `iSampleRate = 44100`。

使用占位通道时，壁纸底部会提示 6 秒并转发 `scene.log` 警告。依赖真实纹理、音乐、
键盘或摄像头的 shader 能运行，但画面与 Shadertoy 不等价；cubemap / 外部 3D 纹理资源
不支持（Volume Pass 生成的 3D 纹理除外）。

明确不支持（会在识别阶段报错，不会静默替换）：

- 仅有 WebGL1 时运行 ES3 源码或 Volume Pass（会提示需要 WebGL2，不会进入 ES1 编译）；
- 缺少 `EXT_color_buffer_float` 时运行 Volume Pass（无法渲染到 3D 浮点纹理）；
- `#include`；
- 整页 HTML/JS 示例（会提示只粘贴单个 GLSL）；
- cubemap / 外部 3D 纹理资源 / 真实音频、视频、摄像头输入与远程资源；
- 点击、拖拽、滚轮、键盘（宿主指针通道没有按键字段；`iChannel1` 的键盘纹理也不会
  产生真实按键）。

ES1 路径下 `texture()` 映射到 `texture2D()`，`textureLod` / `textureGrad` 退化为
普通采样；需要 `dFdx/dFdy/fwidth` 时，WebGL1 会尝试启用
`OES_standard_derivatives`，WebGL2 会自动改走 ES3 核心导数。

## 时间语义（已知偏差）

`iTime` 是 float32 uniform。若直接传「自固定日期起的墙钟秒」，到 1e7 秒量级时
ulp 已是秒级，动画会变成台阶。因此：

- **同步模式**（mirror 开启动画同步 / span）：`iTime` = 本地当日 00:00 起的秒数，
  所有窗口共享相位，精度约 8 ms；跨本地午夜会回卷一次（单帧跳变），DST 切换跳 1 小时。
- **独立模式**：`iTime` 从 0 单调累计，暂停冻结。

暂停时长会从同步相位里扣除，恢复不跳变。

## 状态与错误

宿主参数面板没有「场景 → 设置页」回传通道，所以运行状态显示在壁纸画面底部：
未加载、编译中、编译失败（原始日志 + 行号偏移提示）、Context Lost、性能不足。
关键事件同时通过 `scene.log` 转发到宿主控制台。

失败时不会替换当前可用的旧着色器：新源码编译失败，旧画面继续渲染并覆盖错误卡片。

## 开发

```powershell
pnpm extensions:build shadertoy-wallpaper  # 构建到 extensions/dist/lull.shadertoy-wallpaper
pnpm extensions:check                      # strict validator + 摘要校验
pnpm extensions:watch shadertoy-wallpaper  # Tier 1，改完在宿主里重选/重载壁纸
```

`fixtures/` 里是手工验证用的示例源码（目录不进入构建产物；仅 `default.frag`
以 `?raw` 内联进场景包）：

- `default.frag`：**默认加载**的示例（Shadertoy「The Drive Home」），单 Pass、无外部输入；
- `default.frag`：Shadertoy「Perspex Web Lattice」Voronoi 场景，采样 `iChannel0`；
- `gradient.frag`：最小 `iTime` 渐变；
- `flow.frag`：噪声流动；
- `mouse.frag`：十字/圆环跟随 `iMouse.xy`，用于验收坐标与“离开保留”；
- `channel.frag`：采样 `iChannel0` 噪声与 `iChannel1` 黑色，用于验收占位通道；
- `raw.frag`：自定义 `main()` 的普通 fragment shader；
- `multipass.frag`：Buffer A + Image 的多 Pass / Feedback 示例；
- `es3.frag`：`#version 300 es` + `texelFetch` / `textureSize` / 整数数组 / 位运算；
- `es3-multipass.frag`：ES3 多 Pass 自反馈；
- `volume.frag`：Volume A（球体 SDF 自反馈）+ Buffer A 采样 + Image，体积渲染冒烟示例；
- `volume-lotus.frag`：用户提供的球体↔莲花 morph 体积 shader（Volume A + Buffer A +
  Image A，无 Image，128³），需 WebGL2，用于验收 Volume / Image A-D / 显示回退；
- `invalid.frag`：故意编译失败（未知函数），用于验证错误日志。

## 与 RFC 的差异

1. 文件读取与「从文件载入」按钮在宿主设置面板（通用 `text` 参数），不在扩展内：
   壁纸窗口点击穿透，扩展无法打开文件对话框；
2. 面板侧「Runtime Status / 当前文件名 / Reload」未实现，状态显示在壁纸内，
   Reload 等价于重新选择文件；
3. 多 Pass 已实现，但通道绑定是运行配置（Bindings 或默认约定），无法从 shader
   源码推断；iChannel 没有真实纹理/音频/键盘，未绑定到 buffer 时用噪声/黑色占位；
4. 同步模式的时间锚定见上（RFC 要求「遵循 Lull 同步策略」，这里用墙钟相位实现）；
5. `iMouse` 只有位置：宿主不读按键，`zw = 0`；指针离开绘制面后保留最后位置
   （Shadertoy 的 `xy` 语义），点击/拖拽类 shader 不会响应。