# Scene SDK

> 目标：让创作者**不修改 Lull 核心代码**就能开发、测试并分发壁纸场景。
> 首版范围：内置 React 场景 + 外部**静态 Web** 场景包。动态插件加载器不在首版。

## 1. 场景分类

| 类型 | 注册方式 | 运行位置 | 首版 |
| --- | --- | --- | --- |
| 内置场景（built-in） | `src/scenes/registry.ts` | Next.js 客户端组件 | ✅ |
| 外部静态场景（content） | `public/content/catalog.json` | `sandbox=""` iframe（仅 HTML/CSS） | ✅ |
| 动态 JS 插件 | 未定义 | — | ❌ |

外部场景不进入 `src/`，不参与 Rust 编译，也不能调用 Tauri IPC。壁纸窗口本身没有 Tauri capability。

## 2. Scene Manifest

```json
{
  "schemaVersion": 1,
  "type": "scene",
  "id": "community.mist",
  "name": "雾岚",
  "version": "1.0.0",
  "description": "薄雾与远山。",
  "author": "Lull Community",
  "license": "MIT",
  "capabilities": [
    "wallpaper.viewport",
    "wallpaper.canvas",
    "wallpaper.sync"
  ],
  "entry": "scenes/mist/index.html",
  "theme": {
    "background": "#0a1416",
    "accent": "#9fc7c2"
  }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `schemaVersion` | ✅ | 当前固定 `1`；不支持的版本拒绝加载 |
| `type` | ✅ | 固定 `"scene"` |
| `id` | ✅ | 小写、全局唯一，建议 `作者.场景`；`^[a-z0-9][a-z0-9._-]{2,63}$` |
| `name` | ✅ | 设置页显示名 |
| `version` | ✅ | 语义化版本 |
| `license` | ✅ | SPDX 标识或许可证名；内容包必填 |
| `capabilities` | ✅ | 非空、去重；见下表 |
| `entry` | 外部场景必填 | 相对 `public/content/` 的 `.html` 路径；禁止 `..` / 绝对路径 / 反斜杠 |
| `description` | — | 设置页场景说明 |
| `author` | — | 创作者署名 |
| `theme.background` | — | 首帧防闪背景色（`#RRGGBB`） |
| `theme.accent` | — | 目录/设置页强调色 |

JSON Schema：[`content/schema/scene.schema.json`](../content/schema/scene.schema.json)。

### 2.1 capabilities

| 能力 | 含义 |
| --- | --- |
| `wallpaper.viewport` | 场景可铺满单屏视口 |
| `wallpaper.canvas` | 场景支持跨屏共享画布坐标 |
| `wallpaper.sync` | 场景支持按绝对时间对齐动画相位 |

首版宿主不会因缺少某个 capability 而拒绝运行；这些字段用于目录展示与未来兼容性判断。

## 3. 内置场景接口

```ts
export type SceneProps = {
  layout: "viewport" | "canvas";
  sync: boolean;
  canvas: Rect | null; // 共享画布（物理像素）
  view: Rect | null;   // 当前窗口矩形
  dpr: number;
};

export type SceneComponent = (props: SceneProps) => ReactNode;
```

- `layout === "viewport"`：组件铺满当前窗口，用 `vw/vh` 或百分比布局。
- `layout === "canvas"`：组件位于「画布尺寸」的容器内，容器已按 `view` 偏移；组件应按 `canvas.w/h` 的比例布局，不要假设窗口大小。
- `sync`：用 `syncedDelayMs(periodMs, Date.now())` 生成负 `animation-delay`，让所有窗口相位一致。
- `dpr`：需要把物理像素换算成 CSS 像素时使用；画布容器已经做过一次换算。

参考实现：

- [`src/scenes/bamboo`](../src/scenes/bamboo/index.tsx)
- [`src/scenes/aurora`](../src/scenes/aurora/index.tsx)
- [`src/scenes/dusk`](../src/scenes/dusk/index.tsx)

新增内置场景：

```ts
// src/scenes/registry.ts
const MY_MANIFEST = parseSceneManifest({
  schemaVersion: 1,
  type: "scene",
  id: "lull.my-scene",
  name: "我的场景",
  version: "1.0.0",
  license: "MIT",
  capabilities: ["wallpaper.viewport", "wallpaper.canvas", "wallpaper.sync"],
});
```

然后在 `BUILTIN_SCENES` 追加 `{ source: "builtin", manifest: MY_MANIFEST, component: MyScene }`。设置页与宿主会自动读取。

## 4. 外部静态场景

### 4.1 目录布局

```text
public/content/
  catalog.json
  scenes/
    mist/
      index.html
      assets/…      # 可选，必须使用相对路径
```

`catalog.json`：

```json
{
  "schemaVersion": 1,
  "scenes": [
    {
      "schemaVersion": 1,
      "type": "scene",
      "id": "community.mist",
      "name": "雾岚",
      "version": "1.0.0",
      "license": "MIT",
      "capabilities": ["wallpaper.viewport", "wallpaper.canvas"],
      "entry": "scenes/mist/index.html"
    }
  ]
}
```

### 4.2 外部场景的能力边界

首版外部场景包**只允许 HTML / CSS**，iframe 使用空 `sandbox`（不执行 JavaScript）：

- 不能读取 URL 哈希或宿主参数；
- 不能调用 Tauri IPC；
- 不能访问同源存储、Cookie 或 `window.parent`；
- 动画只能使用 CSS（`@keyframes`、`prefers-reduced-motion`）；
- 需要感知屏幕几何时，用 `100%` / `100vw` / `100vh` 等纯 CSS 布局。

需要宿主参数、跨屏同步或 JavaScript 的场景，应作为内置场景实现；等权限模型落地后再开放外部脚本。

### 4.3 画布与 iframe

宿主把 iframe 放在与内置场景相同的容器中：

- viewport：iframe 铺满窗口；
- span：iframe 先铺满画布，再由宿主容器按当前屏幕偏移裁切。

因此外部页面直接用 `100%` 布局即可，不需要自己重复做跨屏偏移。
示例见 [`public/content/scenes/mist/index.html`](../public/content/scenes/mist/index.html)。

### 4.4 安全边界

- iframe 使用 `sandbox=""`，脚本完全不执行，也没有同源存储权限；
- 壁纸窗口不在 Tauri capability 列表内；
- 场景资源必须随包本地分发，不加载远程脚本、字体或音频；
- 不允许 `entry` 逃逸内容根目录（校验器与运行时双重检查）；
- 首版没有安装器、签名或在线更新；内容包由用户/发行版手动放入 `public/content/`。

> 能加载一个 HTML 包，不等于建立了安全插件系统。未来若开放宿主 API，必须新增权限模型、来源校验、IPC 白名单与故障隔离；在此之前不开放外部 JavaScript。

## 5. 场景目录与设置页

`src/hooks/use-scene-catalog.ts` 合并：

1. 内置场景（同步可用）；
2. `public/content/catalog.json` 中的外部场景（异步加载，失败只降级为空列表）。

设置页显示场景名、版本、许可证与来源（内置 / 内容包）。目录加载失败不会影响壁纸运行。

## 6. 校验

```powershell
pnpm content:check
```

校验内容：

- catalog schemaVersion / scenes 数组；
- manifest 必填字段、id/版本格式、capability 白名单；
- entry 相对路径安全性与文件存在性；
- 场景 id 不重复。

Vitest 还会解析随包目录与示例场景，防止文档与实现漂移。

## 7. 版本与兼容

- `schemaVersion` 是破坏性变更开关；新增可选字段不升版本。
- 宿主读到不支持的版本会拒绝该目录并保留内置场景，不崩溃。
- 内容包 `version` 独立于 Lull 版本；未来会加入 `hostApi` 兼容范围。
- 场景 id 一经发布不要修改；改名视为新场景。

## 8. 非目标

- 不允许外部内容包执行 JavaScript（首版 iframe 空 sandbox）；
- 不允许场景执行任意 Rust 命令；
- 不允许场景创建/管理窗口；
- 不允许场景修改全局配置；
- 不允许场景在首版访问麦克风、文件系统或网络；
- 不把 React 组件直接分发给第三方（首版只支持静态 HTML 包）。
