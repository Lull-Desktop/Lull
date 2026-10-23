# Lull 内容目录

这里放**随安装包分发**的官方内容与示例。运行时的实际文件位于 `public/content/`，构建时原样复制到 `dist/content/`。

## 目录

```text
content/
  schema/
    scene.schema.json       # Scene Manifest JSON Schema
    catalog.schema.json     # 目录文件 JSON Schema
public/content/
  catalog.json              # 运行时发现入口
  scenes/mist/index.html    # 外部静态场景示例
```

## 新增外部场景

1. 在 `public/content/scenes/<name>/` 放一个自包含的 `index.html`；
2. 在 `public/content/catalog.json` 的 `scenes` 数组登记 manifest；
3. 运行：

```powershell
pnpm content:hash     # 计算整个包目录的 integrity 摘要
pnpm content:sign     # 给 catalog.json 原始字节签名（首次先 pnpm content:keygen）
pnpm content:check    # 清单 + 摘要 + 签名
pnpm test
```

4. 重启应用或重新加载壁纸，设置页会出现新场景。

> 改了包内任何文件（包括图片、CSS）都要重跑 `content:hash`，否则 `content:check` 会报摘要不匹配；
> 每次改完 `catalog.json` 都要重新 `content:sign`，否则运行时会拒绝该目录。

## 规则

- `id` 全局唯一，建议 `作者.场景`；
- 必须声明 `version` 与 `license`；
- `entry` 只能指向内容根目录内的 `.html`，禁止 `..` / 绝对路径；
- 只允许 HTML / CSS；iframe 空 `sandbox`，JavaScript 不执行；
- 不加载远程脚本、字体或音频；
- 不访问 Tauri API / `window.parent` / 宿主存储；
- 素材授权自行确认，并随包附许可证。

## 许可

- 官方内容目录、Schema 与示例：**CC BY 4.0**（见 [CONTENT-LICENSE.md](../CONTENT-LICENSE.md)）；
- 内置场景实现（`src/scenes/**`）属于应用代码：**GPL-3.0-or-later**；
- 第三方内容包：作者自选许可，但必须在 manifest 中声明，并自行确认素材授权；
- 不要在内容包中使用与 GPL 应用分发冲突的非商业/禁止演绎条款。

## 分发给用户

这里的内容随安装包发布。要让别人**安装后**再加场景，把自己的内容包做成同样结构：

```text
my-scene/
  catalog.json              # 恰好一条 scene
  scenes/my-scene/index.html
```

```powershell
pnpm content:hash --bundle ./my-scene   # 写回 integrity（算法与安装器一致）
pnpm content:pack ./my-scene --out artifacts
# 把 artifacts/my-scene-<version>.zip 从设置 → 扩展安装
```

> 不要用 `Compress-Archive` 等会写反斜杠路径的工具；安装器会拒绝
> `zip 内含反斜杠路径`。`content:pack` 统一使用正斜杠。

安装器只接受声明了整包摘要的单场景包；详细校验顺序与限制见
[内容包格式 §7](../docs/content-format.md)。

完整字段与安全边界见 [Scene SDK](../docs/scene-sdk.md) 与 [内容包格式](../docs/content-format.md)。
