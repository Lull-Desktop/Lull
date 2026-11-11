# 着色器壁纸（`lull.shadertoy-wallpaper`）

把用户自己提供的 GLSL 源码当作桌面壁纸运行。产物 id 固定为
`lull.shadertoy-wallpaper`，是官方随包 **scene** 扩展（`catalog.json` + Vite 入口）。

- 渲染：扩展内部原生 WebGL 1（GLSL ES 1.00），无第三方渲染库；
- Profile：支持 Shadertoy Image（`mainImage`）与普通 fragment（自定义 `main()`），
  单 Pass；外部输入使用占位值；
- 宿主边界：不新增 Rust 服务 / Tauri 命令 / Widget Bridge 路由 / Package，
  源码以普通字符串参数下发。

## 用户怎么用

1. 壁纸设置 → 壁纸类型选「着色器」；
2. 参数面板「着色器源码」里粘贴 GLSL，或点「从文件载入」选择 `.glsl` / `.frag` 文件；
3. 源码会立即编译：成功即开始渲染，失败则在壁纸上显示原始编译日志。

源码随壁纸配置（`display.json` 的 `sceneParams`）保存，重启后自动恢复；
参数面板「恢复默认」会把源码清空。

## 参数

| key | 类型 | 说明 |
| --- | --- | --- |
| `source` | `text` | GLSL 源码，上限 128 KiB |
| `render-scale` | `number` | 0.25–1，绘制分辨率比例；超过 4K 像素上限自动下调 |
| `animation` | `boolean` | 关闭后冻结 `iTime`，画面停在当前帧 |

## 支持范围

支持两种入口：

- **Shadertoy Image**：`void mainImage(out vec4 fragColor, in vec2 fragCoord)`，由扩展
  包装成 WebGL 的 `main()`；
- **Raw Fragment**：源码自带 `void main()`，直接编译；用 `gl_FragCoord` 取像素坐标、
  `gl_FragColor` 输出。提供 `vUv` / `uv` / `vTexCoord` 三个常用 UV varying；
  自定义 attribute 或其他 varying 名不支持。

两种入口共享同一套 uniform、占位通道与兼容宏。

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
键盘或摄像头的 shader 能运行，但画面与 Shadertoy 不等价；cubemap / 3D 纹理不支持。

明确不支持（会在识别阶段报错，不会静默替换）：

- `#version` 非 100、`#include`；
- 整页 HTML/JS 示例、含多个 shader 块的多 Pass 页面（会提示只粘贴单个 GLSL）；
- Common / Buffer A-D / Multipass / Feedback；
- cubemap / 3D 纹理 / 真实音频、视频、摄像头输入与远程资源；
- 点击、拖拽、滚轮、键盘（宿主指针通道没有按键字段）。

`texture()` 会映射到 GLSL ES 1.00 的 `texture2D()`；`textureLod` / `textureGrad`
退化为普通采样；需要 `dFdx/dFdy/fwidth` 时会尝试启用
`OES_standard_derivatives`，上下文不支持则报错。

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

`fixtures/` 里是手工验证用的示例源码（不进入构建产物）：

- `gradient.frag`：最小 `iTime` 渐变；
- `flow.frag`：噪声流动；
- `mouse.frag`：十字/圆环跟随 `iMouse.xy`，用于验收坐标与“离开保留”；
- `channel.frag`：采样 `iChannel0` 噪声与 `iChannel1` 黑色，用于验收占位通道；
- `raw.frag`：自定义 `main()` 的普通 fragment shader；
- `invalid.frag`：故意编译失败（未知函数），用于验证错误日志。

## 与 RFC 的差异

1. 文件读取与「从文件载入」按钮在宿主设置面板（通用 `text` 参数），不在扩展内：
   壁纸窗口点击穿透，扩展无法打开文件对话框；
2. 面板侧「Runtime Status / 当前文件名 / Reload」未实现，状态显示在壁纸内，
   Reload 等价于重新选择文件；
3. 多 Pass 未实现；iChannel 只有占位纹理（iChannel0 噪声、其余黑色），
   不是真实纹理/音频/键盘输入；
4. 同步模式的时间锚定见上（RFC 要求「遵循 Lull 同步策略」，这里用墙钟相位实现）；
5. `iMouse` 只有位置：宿主不读按键，`zw = 0`；指针离开绘制面后保留最后位置
   （Shadertoy 的 `xy` 语义），点击/拖拽类 shader 不会响应。