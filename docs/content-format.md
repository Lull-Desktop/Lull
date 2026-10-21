# 内容包格式

> 状态：v1 只落地**静态场景包**。主题、声景预设、桌面布局的类型已在 SDK 中预留，但宿主尚未加载。
> 目标：官方内容与社区内容使用同一种格式；内容包不修改 Lull 核心代码。

## 1. 内容根目录

随安装包分发的内容位于 `public/content/`，构建时原样复制到 `dist/content/`：

```text
public/content/
  catalog.json          # 内容索引
  scenes/
    mist/
      index.html
      assets/…
```

`catalog.json` 是运行时唯一发现入口；没有登记的目录不会被加载。

## 2. 目录文件

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
      "description": "薄雾与远山。",
      "author": "Lull Community",
      "license": "MIT",
      "capabilities": ["wallpaper.viewport", "wallpaper.canvas", "wallpaper.sync"],
      "entry": "scenes/mist/index.html",
      "theme": { "background": "#0a1416", "accent": "#9fc7c2" }
    }
  ]
}
```

JSON Schema：[`content/schema/catalog.schema.json`](../content/schema/catalog.schema.json)、[`scene.schema.json`](../content/schema/scene.schema.json)。

## 3. 包结构

### 3.1 场景包（当前支持）

```text
scenes/<name>/
  index.html        # 必需，entry 指向它
  assets/           # 可选；只能相对引用
  LICENSE           # 建议随包附带
  README.md         # 可选，说明玩法与素材来源
```

约束：

- `entry` 必须是 `.html`，相对 `public/content/`，禁止 `..` / 绝对路径 / 反斜杠；
- 只允许 HTML / CSS；iframe 空 `sandbox`，JavaScript 不执行；
- 所有资源使用相对路径；不加载远程脚本、字体或音频；
- 不访问 `window.parent`、Tauri API 或宿主存储；
- 不依赖构建期工具；一个静态服务器能跑即可。

### 3.2 主题 / 声景 / 布局（预留）

`src/sdk/content/manifest.ts` 定义了通用清单：

```ts
type ContentManifest = {
  schemaVersion: 1;
  type: "scene" | "theme" | "sound-preset" | "layout";
  id: string;
  name: string;
  version: string;
  license: string;
  entry?: string;
  capabilities?: string[];
  dependencies?: { id: string; version: string }[];
  hostApi?: string;
};
```

这些类型的加载器尚未实现；不要在文档或发行物中宣称已支持。

## 4. 版本与兼容

| 字段 | 规则 |
| --- | --- |
| `schemaVersion` | 破坏性格式变更才升；当前 `1`，不支持则拒绝 |
| 内容 `version` | 独立语义化版本；同一 id 新版本覆盖旧版本 |
| `hostApi` | 预留：声明兼容的宿主 API 范围 |
| `dependencies` | 预留：内容包之间依赖，首版不解析 |
| `id` | 一经发布不要改名；改名视为新内容 |

宿主读取目录时：

- 目录缺失 / 损坏 → 只保留内置场景，不崩溃；
- 单条 manifest 非法 → 整个目录拒绝（当前实现），并在设置页显示错误；
- 重复 id → 整个目录拒绝，避免设置页出现歧义选项。

## 5. 许可证与素材

- 每个内容包必须填写 `license`；
- 代码、字体、图标、声音、场景素材的授权分别确认；
- 随包附 `LICENSE` 或 `THIRD_PARTY_NOTICES.md`；
- 不允许把无授权素材打包进官方内容目录；
- 官方内置场景以 MIT 发布。

## 6. 校验

```powershell
pnpm content:check
```

实现：[`scripts/validate-content.mjs`](../scripts/validate-content.mjs)。它会检查：

1. `catalog.json` 可解析、schemaVersion 正确；
2. 每个 manifest 的必填字段与格式；
3. capability 白名单与唯一 id；
4. `entry` 路径安全且文件存在。

CI 在 `frontend-test.yml` 中执行同一命令；Vitest 还会解析随包目录，防止示例与实现漂移。

## 7. 分发（C 阶段）

首版不提供在线市场或安装器。建议路径：

1. 内容包放在独立 Git 仓库 / Release；
2. 用户手动解压到 `public/content/`（开发）或未来的用户内容目录（规划）；
3. 通过目录文件登记；
4. 校验通过后重启应用即可看到场景。

未来若做在线索引，只索引 manifest 与下载地址，不把在线服务变成运行前置依赖。

## 8. 安全边界

- 内容包运行在 `sandbox=""` 的 iframe：不执行 JavaScript，不能调用 Tauri；
- 宿主不执行内容包里的任意 Node/Rust 代码；
- 不把「能加载 HTML」当成「安全插件系统」；
- 安装/更新/签名/权限模型落地前，不开放第三方工具窗口与原生能力。

## 9. 示例

- [`public/content/catalog.json`](../public/content/catalog.json)
- [`public/content/scenes/mist/index.html`](../public/content/scenes/mist/index.html)
- [`src/sdk/scene/manifest.test.ts`](../src/sdk/scene/manifest.test.ts)
