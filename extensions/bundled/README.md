# 预构建随包扩展（drop-in）

把**已经构建好的标准扩展包**直接放进本目录，`pnpm extensions:build` 会自动扫描、
校验、复制到 `extensions/dist/<清单 id>/`，随后由 Tauri `bundle.resources` 与
`pnpm release:package` 的便携版 zip 自动带进发布产物。

这与 `extensions/official/` 的分工：

- `official/`：第一方源码，构建期用 Vite 编译；
- `bundled/`：预构建包（可来自 Lull Community 等），构建期只做复制、摘要重算与校验。

运行时会把 `extensions/dist/<id>/` 统一识别为 `origin=bundled`（随包来源），
与包放在哪个输入目录无关。

## 目录结构

```text
extensions/bundled/
  README.md                 # 本文件；不是包目录，会被扫描跳过
  webgl-fluid/              # 目录名只是标签；产物目录用清单 id
    catalog.json            # scene 包根
    LICENSE                 # 第三方许可（随包分发）
    README.md               # 来源说明（可选）
    scenes/webgl-fluid/
      index.html
      js/script.js
      LDR_LLL1_0.png
```

支持两种标准包：

```text
# Widget 包
<label>/
  widget.json               # builtin=false，id 与运行时目录一致
  index.html
  assets/                   # 可选

# Scene（内容）包
<label>/
  catalog.json              # schemaVersion=1，scenes 恰好一条
  scenes/<name>/index.html  # entry 必须指向这里
  ...                       # 包内资源
```

## 规则

- 每个直接子目录是一个**解压后的**标准包根；不支持直接放 `.zip`。
- 目录名不要求和清单 id 相同；产物目录、运行时目录一律用清单 id。
  例如 `webgl-fluid/` 的 `catalog.json` id 是 `community.webgl-fluid`，
  最终落在 `extensions/dist/community.webgl-fluid/`。
- 同时有 `widget.json` 和 `catalog.json`、或者两者都没有，构建会失败。
  从 Lull Community 复制时，要复制条目里的 **`package/` 内容**，不是整个条目目录。
- 包根的 `.lull-integrity.json` / `.lull-signature.json` 不会复制：
  Widget 的锁由构建重写，Scene 的摘要写进产物 `catalog.json`；
  随包来源不参与社区发布者签名链。
- 包根出现 `dev.json` / `.lull-dev.json` 会失败；包内不允许符号链接。
  包必须通过 strict validator（无远程资源、无开发地址、清单/能力合法）。
- 源包里的 `integrity` / `.lull-integrity.json` 可以缺失或过期；构建以**源字节**
  为准重算到 `extensions/dist`。`extensions:check` 会比较源字节与产物摘要。
- 以 `.` / `_` 开头的子目录会被跳过（可放共享文件或临时目录）。

## 加入 webgl-fluid

当前仓库已放入该包。若要从 Lull Community 重新同步：

```powershell
$src = "F:\TK\GameProjects\Lull-Community\content\scenes\webgl-fluid"
$dst = "extensions\bundled\webgl-fluid"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item "$src\package\catalog.json" $dst -Force
Copy-Item "$src\package\scenes" $dst -Recurse -Force
Copy-Item "$src\LICENSE" $dst -Force
Copy-Item "$src\README.md" $dst -Force
```

`item.json`、`preview.webp` 是社区目录元数据，不随安装包分发。

## 命令

```powershell
pnpm extensions:build          # 全量：构建官方源码 + 刷新全部 bundled 包
pnpm extensions:build bamboo   # 只重建指定官方扩展；bundled 仍会刷新
pnpm extensions:check          # 校验产物/摘要/index（CI 与发布前）
```

全量构建会清理 `extensions/dist` 中不再声明的目录，所以删除
`extensions/bundled/<label>/` 后跑一次全量构建即可从发布产物移除。
单包构建只用于开发，不负责清理旧产物。

## 注意

- **Widget 会被默认启用并授予清单声明的能力**（宿主对 bundled 来源的既有策略）。
  加入前必须审查代码、能力与许可证；Scene 不进入 Widget 授权账本。
- 第三方内容保留自己的许可证：随包附带 `LICENSE`，并在仓库根
  [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) 登记。
- 同 id 的用户安装包会被随包版本遮蔽（宿主优先加载 bundled）；扩展中心会把
  bundled 来源标为随应用分发。
