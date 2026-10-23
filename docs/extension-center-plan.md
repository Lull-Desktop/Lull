# 扩展中心 v1 实施计划

> 依据：[扩展中心设计](./extension-center.md)。本文件只排期与拆任务，契约以设计文档为准。
>
> 估算口径：**1 名熟悉本仓库的开发者、全职、含自测与文档**。不含在线目录、签名、
> 自动更新。人日数是粗略量级，用于排序与取舍，不是承诺。

---

## 当前进度（2026-10-23）

| 里程碑 | 状态 | 说明 |
| --- | --- | --- |
| M0 契约与骨架 | ✅ | `extension::*` 类型、错误码、命令接线、capability 生成 |
| M1 共享管线 + widget 后端 | ✅ | `package_hash`、`extension::install`、scene 迁移、widget 摘要/安装/卸载/扫描/门面命令 |
| M2 扩展中心 UI | ✅ 基础竖切 | 设置页双页签、列表/过滤、导入预览与确认、启用确认、详情、逐能力开关、卸载 |
| M3 权限与诊断 | 🟡 部分 | CSP 按授权收紧、chrome 回退、运行中锁定已做；清单漂移 `needs-review` 未做 |
| M4 开发模式 | ⬜ | 未开始 |
| M5 托盘 / 打包 / 文档 | 🟡 部分 | 文档已同步；托盘与 `widget:pack` 未做 |
| M6 验收与清理 | ⬜ | 旧卡片/旧命令仍在，待 M6 清理 |

> 与设计稿的偏差：scene 卸载在“正被壁纸引用”时**拒绝并提示先切换**，
> 自动回退到默认场景留到后续；其余行为按设计执行。

---

## 0. 范围与完成定义

### 0.1 v1 交付

1. 设置窗「偏好 / 扩展」两个页签。
2. 扩展中心：已安装列表、过滤、详情、卸载、诊断。
3. 本地 ZIP 导入：选择文件 / 拖拽 → 预览确认 → 安装；scene 与 widget 共用一条安装管线。
4. Widget 启用、权限确认、逐能力撤销、打开 / 关闭 / 结束运行 / 停用。
5. Widget 包完整性（旁路摘要 + TOFU）与运行时复核。
6. 开发模式：挂载本地目录、打开、重载、关闭即销毁。
7. 托盘「扩展」子菜单；设置页工具列表接入已启用扩展。
8. 文档同步：`widget-package.md`、`content-format.md`、`architecture.md`、`README.md`。

### 0.2 完成定义（DoD）

- [ ] `pnpm check` 全绿（lint / typecheck / vitest / content:check / widgets:check / sdk:check）。
- [ ] `cargo test` 全绿；`cargo clippy` 无新增告警（仓库把 warning 当 error）。
- [ ] 新增命令同时出现在 `src-tauri/src/lib.rs` 与 `src-tauri/build.rs` 的 `APP_COMMANDS`。
- [ ] `pnpm widgets:gen` 生成的 capability 与代码一致，`pnpm widgets:check` 通过。
- [ ] 手工验收清单（设计文档 §14）逐项通过，至少覆盖：安装、启用、打开、撤销 network、
      篡改、卸载、开发模式重载。
- [ ] 文档不再出现“工具没有安装器”“手动复制目录是唯一方式”这类过期表述。
- [ ] 旧版本安装的包不卸载也能在新版本继续加载。

---

## 1. 里程碑总览

| 里程碑 | 内容 | 估时 | 依赖 | 出口条件 |
| --- | --- | --- | --- | --- |
| **M0** | 冻结契约：类型、错误码、命令表、D1–D5 | 1d | — | 命令壳能编译，`widgets:check` 通过 |
| **M1** | 共享安装管线 + widget 后端竖切 | 3d | M0 | IPC 可安装/列出/卸载 widget 与 scene，单测覆盖 |
| **M2** | 扩展中心最小 UI 竖切 | 3d | M1 | 从文件安装 → 列表 → 启用 → 打开 全链路可点 |
| **M3** | 权限、诊断、摘要复核 | 2d | M2 | 逐能力撤销生效；篡改包被拦截并可见原因 |
| **M4** | 开发模式 | 1.5d | M3 | 挂目录 → 打开 → 改文件 → 重载 生效 |
| **M5** | 托盘、场景整合、创作者打包脚本 | 1.5d | M3/M4 | 托盘可开扩展；scene 卡可用；`widget:pack` 产出 zip |
| **M6** | 验收、文档、清理 | 1d | 全部 | DoD 全绿，旧命令与旧卡片移除 |
| **合计** | | **13d** | | |

排序原则：先打通一条**端到端竖切**（安装 → 列表 → 启用 → 打开），再补权限、开发模式、
托盘。任何阶段都不先做“在线市场”。

---

## 2. 任务分解

### M0 · 冻结契约（1d）

| ID | 任务 | 产出 / 文件 | 验收 |
| --- | --- | --- | --- |
| EC-001 | 设计稿与计划评审 | `docs/extension-center.md`、本文件 | D1–D5 有结论 |
| EC-002 | 冻结命名与后缀 | 设计文档 §3；README 术语 | 不再出现 Serene |
| EC-003 | 定义 `ExtensionInfo` / `ExtensionError` / `DevState` | `src-tauri/src/extension/types.rs`、`src/lib/extensions.ts` | Rust 序列化字段与 TS 类型一一对应 |
| EC-004 | 建模块骨架与命令壳 | `src-tauri/src/extension/{mod,types,error}.rs`；`lib.rs`；`build.rs` | `cargo check` + `pnpm widgets:check` 通过 |

> M0 的命令壳返回 `unimplemented` 错误码也可以，但必须已经过 ACL 接线，
> 否则 M1 会在“命令能编译但运行时被 ACL 拒绝”上浪费一天。

### M1 · 共享安装管线 + widget 后端（3d）

| ID | 任务 | 产出 / 文件 | 验收 |
| --- | --- | --- | --- |
| EC-101 | 抽出通用管线：zip 解压、路径安全、预算、staging、定位包根、原子 rename | `src-tauri/src/extension/install.rs` | 单测：穿越、绝对路径、符号链接、超限、套一层目录 |
| EC-102 | scene 适配器迁移到管线，行为不变 | `content_package/store.rs` 瘦身；`content_package/manifest.rs` 保留 | 现有 `content_package` 测试全过 |
| EC-103 | widget 校验器：清单、id、entry、窗口、能力、网络、许可、lifecycle | `widget_package/manifest.rs` 复用 + `extension/widget.rs` | 每个错误码至少一条用例 |
| EC-104 | widget 摘要：算法、旁路文件、TOFU、运行时复算 | `widget_package/digest.rs` | 摘要稳定、排除锁文件、改清单/资源即 mismatch |
| EC-105 | widget 安装 / 扫描 / 卸载 / 状态 | `widget_package/store.rs` | 安装后 `list` 可见；卸载删目录、授权、状态 |
| EC-106 | 包目录解析器：正式目录 + 开发注册表 | `widget_package/store.rs::resolve_dir` | 协议、打开、扫描走同一入口 |
| EC-107 | 门面命令 `extensions_*` 与旧命令下线 | `extension/mod.rs`、`lib.rs`、`build.rs`、`capabilities/window-settings.json`（生成） | 前端字面 `invoke` 全部有注册；`widgets:gen` 后 capability 无 diff |
| EC-108 | 事件 `extensions-changed` | `extension/mod.rs`、`content_package`、`widget_package` | 安装/卸载后设置页与壁纸窗都能刷新 |
| EC-109 | 启动清理 `.staging-*` | `install.rs` | 残留目录不阻塞启动 |
| EC-110 | 安装预览 `extensions_inspect` + 源指纹比对 | `extension/inspect.rs`、`extension/mod.rs` | 预览不落盘；包变化返回 `package.changed` |

**风险点**：EC-102 会碰已经稳定的 scene 安装。策略是先写管线单测、再让 scene 走新函数，
保持 `content_package` 的公开命令与返回结构不变，最后才切换。

### M2 · 扩展中心 UI（3d）

| ID | 任务 | 产出 / 文件 | 验收 |
| --- | --- | --- | --- |
| EC-201 | 设置页拆「偏好 / 扩展」页签 | `src/app/(control)/setting/page.tsx`、`components/settings/preferences-panel.tsx` | 现有设置测试通过；滚动位置/锚点不丢 |
| EC-202 | 前端客户端与 hook | `src/lib/extensions.ts`、`src/hooks/use-extensions.ts` | 安装/卸载/启用后自动刷新；错误类型化 |
| EC-203 | 已安装列表、过滤、徽章 | `components/extensions/extensions-panel.tsx`、`extension-card.tsx` | 空态、加载态、坏包态都有 |
| EC-204 | 从文件安装：选择 zip + 拖拽 + 预览确认 | `install-dropzone.tsx`、`install-preview-dialog.tsx` | 拖拽不可用时有降级路径；确认前不落盘 |
| EC-205 | 启用 / 打开 / 关闭 / 结束 / 停用 / 卸载（关闭按 lifecycle 分流） | `extension-card.tsx`、详情对话框 | 二次确认；运行中状态实时更新 |
| EC-206 | 详情与权限确认对话框 | `extension-detail.tsx`、`permission-list.tsx` | 展示 declared/granted/effective；强制/提示标注 |
| EC-207 | 错误码到中文文案的映射 | `src/lib/extension-errors.ts` | 未知 code 有兜底，不显示裸英文 |
| EC-208 | 组件测试 | `components/extensions/*.test.tsx` | 覆盖安装失败、启用取消、卸载确认、运行中禁用 |

**UI 取舍**：页签切换用局部 state，不引入路由；「偏好」内容整体搬到子组件，
业务逻辑不改。现有 `page.test.tsx` 若按文本查询，理论上无需改动；若失败，优先修测试
选择器，不改交互语义。

### M3 · 权限与诊断（2d）

| ID | 任务 | 产出 / 文件 | 验收 |
| --- | --- | --- | --- |
| EC-301 | 授权账本扩展：`manifestHash`、`granted`、`enabled`（新增字段带默认值，文件版本不升） | `widget_package/store.rs` | 旧账本无 hash 时自动补齐，不打扰用户 |
| EC-302 | `extensions_set_capability` | `extension/mod.rs` | 运行中返回 `extension.running`；未知能力拒绝 |
| EC-303 | effective 能力与强制点 | `widget_package/protocol.rs`、`widget-plugin-shell.tsx` | 撤销 network → CSP 无外源；撤销 chrome → 宿主顶栏 |
| EC-304 | 权限 UI：逐项开关、级别、网络源 | `permission-list.tsx` | 运行中禁用；撤销前有确认 |
| EC-305 | 清单漂移 `needs-review` | `store.rs`、`extension-card.tsx` | 改清单后不建窗，提示重新确认 |
| EC-306 | 测试 | Rust + 前端 | CSP、chrome 回退、漂移各一条 |

**注意**：`widget.network` 的 CSP 目前直接读清单（`plugin_csp(manifest)`），要改成读
“实际授予”，否则撤销只是 UI 假动作。这是 M3 最关键的一处真实修改。

### M4 · 开发模式（1.5d）

| ID | 任务 | 产出 / 文件 | 验收 |
| --- | --- | --- | --- |
| EC-401 | `extensions.json` 读写与原子落盘 | `extension/dev.rs` | 损坏文件回退空配置；不阻塞启动 |
| EC-402 | 开发包解析接入协议与打开路径 | `widget_package/{store,protocol}.rs` | 协议只服务已挂载目录；路径仍 `safe_join` |
| EC-403 | UI：开关、挂载、列表、重载、徽章 | `dev-mode-card.tsx` | 关闭开发模式窗口销毁、条目隐藏 |
| EC-404 | 隔离：id 冲突拒绝、路径校验、无额外权限 | `dev.rs` | 冲突有明确错误码 |
| EC-405 | 测试 | Rust + 前端 | 挂载/重载/关闭三态 |

### M5 · 托盘、场景与打包（1.5d）

| ID | 任务 | 产出 / 文件 | 验收 |
| --- | --- | --- | --- |
| EC-501 | 托盘「扩展」子菜单 + 重建 | `src-tauri/src/tray.rs` | 启用/停用后菜单即时变化；重建失败不崩 |
| EC-502 | 设置页工具列表接入已启用扩展 | 偏好页「窗口」卡片 | 开关 = 打开/关闭（按 lifecycle）；未启用不出现 |
| EC-503 | scene 卡片动作：去壁纸设置 / 卸载 | `extension-card.tsx`、壁纸卡片锚点 | 卸载后壁纸回退默认场景 |
| EC-504 | 创作者打包脚本 `pnpm widget:pack` | `scripts/pack-widget.mjs`、`package.json` | 生成 `.lull-integrity.json` + zip；示例可安装 |
| EC-505 | 文档同步 | 四份文档 | 无过期表述 |

### M6 · 验收与清理（1d）

| ID | 任务 | 验收 |
| --- | --- | --- |
| EC-601 | 跑 `pnpm check` + `cargo test` + `cargo clippy` | 全绿 |
| EC-602 | 手工验收设计文档 §14 | 逐项打勾 |
| EC-603 | 清理旧卡片、旧命令、旧测试 | 无死代码、无双重入口 |
| EC-604 | 补截图与 README | 文档索引可达 |
| EC-605 | 版本说明 / 已知限制 | 明确“无签名、无在线更新” |

---

## 3. PR 切片建议

| PR | 内容 | 体量 | 风险 | 回滚 |
| --- | --- | --- | --- | --- |
| PR1 | 设计与计划文档 | S | 无 | 直接回滚 |
| PR2 | 抽共享管线，scene 迁移，行为不变 | M | **中**（碰稳定链路） | 保留旧函数一个版本 |
| PR3 | widget 校验 + 摘要 + 安装/卸载 + 门面命令 | L | 中 | 新命令未接 UI，可隐藏 |
| PR4 | 扩展中心 UI 最小竖切 | L | 中（设置页重构） | 页签可回退为单页 |
| PR5 | 权限、诊断、漂移 | M | 中（安全语义） | UI 隐藏开关，后端保留 |
| PR6 | 开发模式 | M | 低 | 默认关闭 |
| PR7 | 托盘、打包脚本、文档 | M | 低 | 独立 |

每个 PR 的合并门槛：`pnpm lint`、`pnpm typecheck`、相关测试、`pnpm widgets:check`。
PR2/PR3 额外要求 `cargo test` 全量。

---

## 4. 测试矩阵

| 区域 | 单元测试 | 集成 / 手工 | 关键用例 |
| --- | --- | --- | --- |
| ZIP 安全 | Rust | — | `..`、绝对路径、反斜杠、符号链接、超限、套目录 |
| 摘要 | Rust | 手工改文件 | 稳定复算、锁文件排除、清单变更、资源变更 |
| 清单校验 | Rust + 前端 | 安装坏包 | 每个错误码至少一条 |
| 安装管线 | Rust | 安装官方示例 zip | 失败不落盘、成功原子可见 |
| 权限 | Rust | 撤销 network/chrome/state | CSP、宿主顶栏、denied |
| 漂移 | Rust | 手改 widget.json | `needs-review`，不建窗 |
| 开发模式 | Rust | 改文件重载 | 关闭后窗口消失、id 冲突拒绝 |
| UI | Vitest | 手动点 | 安装失败、取消启用、卸载确认、运行中锁定 |
| 托盘 | — | 手动 | 启用/停用后菜单变化 |
| 回归 | 全量 | 官方 scene 包安装 | scene 行为不变 |

常用命令：

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm content:check
pnpm widgets:check
pnpm widgets:sdk:check
cd src-tauri; cargo test; cargo clippy
```

---

## 5. 风险登记

| # | 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- | --- |
| R1 | 设置页拆页签破坏现有测试/布局 | 中 | 中 | 先搬组件不改逻辑；测试选择器优先修 |
| R2 | 托盘动态菜单在 Windows 上重建异常 | 中 | 中 | 第一天做原型；失败则退化为“打开设置时刷新” |
| R3 | 摘要扫描拖慢列表 | 低 | 低 | 单包 < 5 MiB；必要时按 mtime 缓存 |
| R4 | 撤销 chrome 让插件无法关闭 | 中 | 高 | 运行中锁定 + 宿主顶栏回退 |
| R5 | 范围蔓延到在线市场/更新/签名 | 高 | 高 | 设计文档 §2.2 非目标；PR 评审卡口 |
| R6 | 文档与实现再次漂移 | 中 | 中 | DoD 包含文档；PR7 专门校对 |
| R7 | 旧命令下线导致遗漏调用 | 中 | 中 | `gen-widgets.mjs` 会校验前端 `invoke` 字面量 |
| R8 | 开发者误开开发模式 | 低 | 低 | 默认关闭 + 常驻提示条 + 徽章 |
| R9 | 降级后新装包不可用 | 低 | 中 | 不改 widget.json 必填字段；锁文件可忽略 |

---

## 6. 排期建议

### 6.1 单人（13 个工作日，约 3 周）

| 周 | 周一 | 周二 | 周三 | 周四 | 周五 |
| --- | --- | --- | --- | --- | --- |
| 第 1 周 | M0 | M1 管线 | M1 管线 | M1 widget 后端 | M2 页签/列表 |
| 第 2 周 | M2 安装/动作 | M2 详情/测试 | M3 权限后端 | M3 权限 UI | M4 开发模式 |
| 第 3 周 | M4 收尾 | M5 托盘/场景 | M5 打包/文档 | M6 验收 | 缓冲 / 修复 |

### 6.2 双人（约 8 个工作日）

- 后端：M1 → M3 后端 → M4 后端。
- 前端：M2（先用 mock 数据）→ M3 UI → M5 UI。
- M0 必须两人一起过一遍契约，避免字段对不上。
- 合并顺序：PR2 → PR3 → PR4；前端可在 PR3 合并前用 mock 推进。

### 6.3 第一周的具体日计划

| 日 | 上午 | 下午 | 当日产出 |
| --- | --- | --- | --- |
| D1 | 冻结 D1–D5；写类型/错误码 | 模块骨架 + 命令接线 + `widgets:gen` | 可编译的空壳 |
| D2 | 抽 zip/staging/budget | 管线单测（穿越/炸弹/套目录） | `install.rs` 单测绿 |
| D3 | scene 迁移 + 回归 | widget 校验器 | scene 测试全过 |
| D4 | widget 摘要 + TOFU | widget 安装/卸载/扫描 | IPC 可装可卸 |
| D5 | 门面命令 + 事件 | 设置页页签 + 列表骨架 | 列表能显示真实数据 |

> D5 结束时的演示目标：**一条命令装进一个 widget，设置页能看到它**。这是第一个
> 可信的进度锚点；如果 D5 达不到，优先砍 M3 的逐能力开关，保竖切。

---

## 7. 发布与回滚

- 预发布阶段不引入 feature flag：功能随版本整体出现，减少分支。
- 回滚 = revert PR；已安装的 widget 目录与旧版本兼容（清单未改必填字段、
  锁文件被忽略），scene 完全不变。
- 若托盘重建在个别环境崩溃：保留“设置页工具列表”作为兜底入口，托盘功能可单独回滚。
- 数据兼容：`extensions.json` 与授权账本新增字段都带默认值；旧版本读新文件时
  忽略未知字段（serde 默认行为）。

---

## 8. 文档同步清单

| 文档 | 需要改什么 |
| --- | --- |
| `docs/widget-package.md` | §1 安装方式（zip/目录/开发模式）、§2 `icon` 可选、§3 授权粒度、§6 点号路径、§10 已知边界（去掉“没有安装器”） |
| `docs/content-format.md` | §7 统一安装入口、scene 卸载行为、与 widget 的分工 |
| `docs/architecture.md` | 模块表加 `extension/**`、命令表、事件表、状态表 |
| `README.md` | 功能列表加“扩展中心”；文档索引加两篇新文档 |
| `docs/extension-center.md` | 实现后把“未实现”改成“v1 已落地”，并回填最终错误码 |

---

## 9. 下一步

1. 确认设计文档 §15 的 D1–D5（默认按“建议”列执行）。
2. 开 PR1：只提交 `docs/extension-center.md` 与本计划，便于团队评审契约。
3. 评审通过后开 PR2：共享安装管线重构，**不改变任何外部行为**。
4. PR2 合并后再动 UI；避免后端契约与页面同时漂移。
