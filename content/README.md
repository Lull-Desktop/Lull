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
pnpm content:check
pnpm test
```

4. 重启应用或重新加载壁纸，设置页会出现新场景。

## 规则

- `id` 全局唯一，建议 `作者.场景`；
- 必须声明 `version` 与 `license`；
- `entry` 只能指向内容根目录内的 `.html`，禁止 `..` / 绝对路径；
- 只允许 HTML / CSS；iframe 空 `sandbox`，JavaScript 不执行；
- 不加载远程脚本、字体或音频；
- 不访问 Tauri API / `window.parent` / 宿主存储；
- 素材授权自行确认，并随包附许可证。

完整字段与安全边界见 [Scene SDK](../docs/scene-sdk.md) 与 [内容包格式](../docs/content-format.md)。
