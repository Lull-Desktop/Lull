# Skill

> 把「拉 SDK → 生成骨架 → 校验 → 打包」封装成一个可被 AI 代理加载的技能。
> 不装技能也能用：命令与标准是同一套。

## 这是什么

扩展开发有一整套硬性标准——清单字段、能力白名单、iframe 沙箱约束、内容包摘要算法。
从空目录手写清单、装进宿主才发现被拒绝，是最常见的返工来源。

「Skill」把这条链路固化成可执行的东西，放在仓库的 [`Skill/lull-extension`](../Skill/lull-extension)：

| 组成 | 内容 |
| --- | --- |
| 技能正文 | `SKILL.md`：判定 widget / scene、工作流、硬约束、排错 |
| 命令 | `lull-ext`：编译 SDK、生成骨架、同步 vendor、重算摘要、校验、打包 |
| 标准 | `references/`：清单字段全表、能力矩阵、摘要规则、设计手册、坑清单 |
| 模板 | `templates/`：工具插件、脚本场景、静态场景 |

它遵循 [Agent Skills 规范](https://agentskills.io/specification)（一个含 `SKILL.md` 的目录），
所以任何支持该规范的代理都能加载；同一份目录也是 npm 包 `lull-extension-skill`（命令 `lull-ext`）。

## 使用前提

`lull-ext doctor` 会把下面这份清单打出来，并区分「必需」与「可选」：

| 类别 | 项 | 说明 |
| --- | --- | --- |
| 必需 | Node.js ≥ 20 | 编译 SDK（tsc）与运行 CLI |
| 必需 | 已编译的 SDK | `sdk build` 产出，默认在 `~/.lull-skill/sdk`；`vendor` / `new` 从这里复制 |
| 必需 | 可写的项目目录 + shell | CLI 要生成文件、复制 `vendor/`、写 zip |
| 条件 | 本地 Lull 仓库 **或** 能访问 github.com | `--from .` 离线编译；不带 `--from` 时用 git 稀疏克隆 |
| 可选 | git / npm | git 用于克隆与读 HEAD；npm 只在首次编译时装 `typescript` |
| 可选 | Lull 桌面应用（Windows） | 只在真机安装与验收时需要 |
| 可选 | Vite / esbuild | 想用 TypeScript / React / Vue 时；模板本身零构建 |
| 不需要 | Rust、Tauri CLI、pnpm、Next.js 工具链 | 扩展是静态 Web 包，不构建宿主 |

## 如何使用

### 1. 安装技能

用通用 skills CLI，一次写进一个或多个代理的技能目录：

```bash
npx skills add Lull-Desktop/Lull --list                              # 先看仓库里有什么
npx skills add Lull-Desktop/Lull --skill lull-extension -y           # 项目级（默认）
npx skills add Lull-Desktop/Lull --skill lull-extension --all -g -y  # 全部代理 + 用户级
npx skills add Lull-Desktop/Lull --skill lull-extension --copy -y \
  -a claude-code -a cursor -a codex
npx skills add ./ --skill lull-extension --copy -y                  # 从本地克隆安装
```

落点：

| 代理 | 项目级 | 用户级（`-g`） |
| --- | --- | --- |
| Claude Code | `.claude/skills/lull-extension/` | `~/.claude/skills/lull-extension/` |
| Cursor / Codex / OpenCode / Copilot / Cline / Roo / Gemini CLI | `.agents/skills/lull-extension/` | 各自 home 下的 `skills/` |

Windows 上 CLI 会自动从符号链接退化为复制；想确定行为就显式加 `--copy`。
没有 `skills` CLI（离线、受限环境）时，手工把 `Skill/lull-extension` 复制到
`.agents/skills/lull-extension` 即可，规范只要求目录里有一份 `SKILL.md`。

### 2. 准备 SDK

扩展只能用**当前代码对应**的 SDK，所以先编译一次：

```bash
lull-ext sdk build --from .            # 在仓库里：编译当前工作树（离线可用）
lull-ext sdk build                     # 仓库外：稀疏克隆 main 后编译
lull-ext sdk build --ref v0.1.0        # 指定 tag / 分支
```

产物落在 `~/.lull-skill/sdk/`（`LULL_SKILL_CACHE` 可改），`sdk-manifest.json` 记录来源
commit、两个包的版本与 dist 摘要。`--from .` 不会改动仓库里的 `dist/`。

### 3. 三条命令走完一轮

```bash
lull-ext new widget ./my-tool --id my-tool --name "我的工具"   # 生成骨架 + vendor
lull-ext validate ./my-tool --strict                          # 按标准校验
lull-ext pack ./my-tool --out ./artifacts                     # 产出可安装 zip
```

壁纸场景同理，把 `new widget` 换成 `new scene`（默认脚本场景，加 `--static` 生成静态包）。

| 命令 | 作用 |
| --- | --- |
| `doctor` | 体检：node / git / npm / 缓存 / SDK 产物 / 技能安装位置 |
| `sdk build` / `sdk info` | 编译 SDK / 打印上次构建清单 |
| `new widget` / `new scene` | 生成工具插件 / 壁纸场景骨架 |
| `vendor` | 把 SDK dist 复制进扩展包（场景会放到 entry 同目录并重算摘要） |
| `hash` | 重算内容包 `integrity` 并写回 `catalog.json` |
| `validate` | 离线校验清单、产物与沙箱约束 |
| `pack` | 打包成可安装 zip |

### 4. 不装技能也能用

技能只是把命令和标准放在代理能看到的地方；命令本身可以直接跑：

```bash
node ./Skill/lull-extension/bin/lull-ext.mjs --help
node ./Skill/lull-extension/bin/lull-ext.mjs validate ./my-tool --json
```

`--json` 输出机器可读报告（`ok / errors / warnings / infos / stats`），便于脚本或 CI 接入。

## 需要注意

- **需要 Node ≥ 20**；git 只在远端拉取 SDK 时需要，npm 只在首次编译需要。
- **技能不含安装器**：安装交给通用 skills CLI，`lull-ext` 只负责编译、生成、校验、打包。
- **校验是静态检查**：它能拦住宿主一定会拒绝的情况（清单非法、entry 越界、能力越权、
  相对导入缺失、远程资源、内联事件处理器），但不能替代真机验收——透明窗口观感、
  多屏表现、长期占用仍需自己看。
- **SDK 会随包分发**：`vendor/` 里是 SDK 的 ESM 副本（约 100 KB），计入单包 5 MB 建议上限。
- **没有签名与在线目录**：本地摘要锁只证明「包没被改过」，不证明来源；同 id 覆盖安装，没有回滚。
- **宿主 API 不匹配会被过滤**：`hostApi` 超出范围时，场景不出现在设置页，插件拒绝加载。

## 相关

- 写工具窗口：[Widget SDK](../widget-sdk/) · [`Skill/lull-extension/SKILL.md`](../Skill/lull-extension/SKILL.md)
- 写壁纸场景：[Scene SDK](../scene-sdk/)
- 扩展如何装进宿主：[扩展中心](../extension-center/)
