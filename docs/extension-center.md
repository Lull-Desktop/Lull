# 扩展中心（Extension Center）设计

> 状态：**v1 基本落地**。共享安装管线、widget 摘要锁、扩展中心 UI、逐能力授权、
> 清单漂移复核、开发模式与托盘入口均已实现；旧卡片与旧管理命令已清理。
> 尚未完成：在线目录与签名、scene 卸载自动回退、最终真机验收。
> 落地顺序与进度见 [实施计划](./extension-center-plan.md)。
>
> 关联文档：[Widget SDK](./widget-sdk.md)（插件包格式与能力声明）、[内容包格式](./content-format.md)、
> [架构与模块边界](./architecture.md)。

---

## 0. 一句话

在设置窗里增加一个统一的**扩展中心**：普通用户从文件安装、启用、授权、卸载；
开发者可以把本地目录挂进来热调试。后端**共享一条安装管线**，但 scene 与 widget
继续各用各的清单、摘要算法、能力白名单和运行时。

---

## 1. 现状与问题

今天仓库里有两套已经能跑、但互不相干的包系统：

| 维度 | Scene（Community） | Widget（Extensions） |
| --- | --- | --- |
| 清单 | `catalog.json` + 单条 scene | `widget.json`（schemaVersion 2） |
| 安装 | zip / 文件夹 + 整包摘要 + 目录签名 | **无安装器**，手动复制目录 |
| 发现 | `catalog.json` 索引 + 用户目录扫描 | 用户目录扫描 |
| 运行时 | `sandbox=""` iframe，不执行 JS | `sandbox="allow-scripts"` iframe + postMessage 桥 |
| 设置入口 | 「内容包」卡片 | 「自定义插件」卡片 |
| 完整性 | 有摘要，运行时复核 | **无摘要**，磁盘改动不会被发现 |
| 生命周期 | 安装 / 卸载 | 启用 / 撤销（没有卸载） |

由此产生四个直接问题：

1. **普通用户拿不到工具扩展**：没有“从文件安装”，只能手动找目录、拷文件。
2. **工具扩展比场景更弱**：可执行 JS、可联网的那一类反而没有完整性校验、没有卸载、
   没有逐能力授权。
3. **两个卡片概念重复**：用户看到“内容包”和“插件”两个入口，不知道该用哪个。
4. **打开路径缺失**：托盘菜单只列内置工具，第三方扩展装好了也没有稳定的全局入口。

---

## 2. 目标与非目标

### 2.1 目标（v1）

- 一个**扩展中心**页面，统一列出 scene 与 widget 两类扩展。
- 三个入口：应用内列表、本地 ZIP 导入、开发者本地目录。
- 后端抽出**共享安装管线**：ZIP 安全检查、staging、原子安装、卸载清理、变更事件。
- Widget 增加：包完整性、安装/卸载、逐能力授权、运行状态、错误诊断。
- 安装、启用、运行三个状态解耦；安装不执行 JS、不自动开窗。
- 保留两套格式与两套运行时，**不做统一 manifest**。

### 2.2 非目标（明确不做）

- 在线目录 / 市场 / 评分 / 截图浏览。
- 自动更新、版本回滚、增量下载。
- 第三方签名与发布者信任链（v1 只有本地摘要锁）。
- 把内置工具（播放器 / 番茄钟 / 白噪音 / 设置）包化或允许外置替换。
- 允许扩展创建窗口、调用任意 Rust 命令、访问 Win32。
- 文件关联 / 双击 ZIP 安装（v1 走应用内选择与拖拽）。
- 跨平台（仍只支持 Windows）。
- 对 `allow-scripts` 扩展做“强沙箱”承诺。

---

## 3. 术语与命名

| 术语 | 含义 |
| --- | --- |
| **扩展（extension）** | 用户可安装的内容或工具的总称，`kind = scene \| widget` |
| **包（package）** | 一个目录 + 一份根清单（`catalog.json` 或 `widget.json`） |
| **适配器（adapter）** | 某一 kind 的校验、摘要、安装落点、运行时入口 |
| **安装管线（pipeline）** | 与 kind 无关的解压、限流、staging、原子落地、事件 |
| **已安装** | 文件通过校验并写入安装目录 |
| **已启用** | 用户确认权限后，允许该 widget 参与运行 |
| **运行中** | 宿主已经为该 widget 创建了 WebView 窗口（可见或隐藏） |
| **开发包** | 通过开发模式挂载的本地目录，不复制、不锁摘要 |

### 3.1 命名

仓库与发行物使用 **Lull / 云栖**。讨论稿里出现的 “Serene”“`.serene-widget.zip`”
是历史名，不应进入实现：

- 包后缀建议 `.lull-widget.zip` / `.lull-scene.zip`；安装器实际接受任意 `.zip`，
  后缀只是分享时的约定。
- 如果确实要保留 Serene 作为产品别名，必须先改 `README.md`、`TRADEMARK.md` 与
  版本说明，再统一包后缀；否则会出现“品牌叫 Lull、包叫 Serene”的割裂。

### 3.2 三个入口

| 入口 | 面向 | v1 状态 |
| --- | --- | --- |
| 扩展中心 | 普通用户：浏览已安装、安装、启用、授权、卸载 | 做 |
| 从文件安装 | 内容分享：下载 `.zip` 后导入 | 做（首期优先） |
| 开发模式 | 创作者：挂本地目录、预览、重载 | 做（主链路稳定后） |

---

## 4. 信息架构

### 4.1 设置窗

设置窗顶部增加三个页签：

```text
┌──────────────────────────────────────────────┐
│  Lull                               −  ×     │
├──────────────────────────────────────────────┤
│  [ 偏好 ]  [ 壁纸 ]  [ 扩展 ]                │
├──────────────────────────────────────────────┤
│                                              │
│   偏好：主题流光 / 窗口 / 关于（现有卡片）   │
│   壁纸：壁纸层（显示模式、场景、每屏配置）   │
│   扩展：扩展中心（本文）                     │
│                                              │
└──────────────────────────────────────────────┘
```

- v1 用**页内状态**切换，不新增路由、不新建窗口；避免动 `window_host` 的窗口清单。
- 「壁纸层」卡片单独搬进「壁纸」页签，显示模式、场景参数与每屏开关仍复用原逻辑。
- 「工具窗口」列表保留在偏好里：内置工具 + 已启用的扩展，只控制显示/关闭；
  启用与授权仍在扩展中心。

### 4.2 扩展中心布局

```text
扩展
管理壁纸内容与工具扩展。安装不会自动运行；启用时才授予权限。

已安装 3 个（工具 2 / 壁纸 1）        [从文件安装] [打开目录] [刷新]

[ 全部 ] [ 工具 ] [ 壁纸 ]            ← 过滤 chip

┌──────────────────────────────────────────────┐
│ 🧩 雾岚番茄钟          1.2.0  工具  已启用 ● │
│    专注计时 · Lull Community · MIT           │
│    [打开] [详情]                    [卸载]   │
└──────────────────────────────────────────────┘
┌──────────────────────────────────────────────┐
│ 🖼 雾岚                1.0.0  壁纸  已校验   │
│    薄雾与远山 · CC-BY-4.0                    │
│    [查看壁纸设置]                  [卸载]    │
└──────────────────────────────────────────────┘

把 .zip 或解压后的文件夹拖到这里；拖不动就点「从文件安装」。

开发模式                                          [关]
仅在本机调试时开启。开发包不复制文件、不校验摘要，
仍受同一套权限与沙箱约束。
```

### 4.3 卡片字段

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `icon` | 清单可选字段 | 缺失时用 kind 默认图标 |
| `name` / `version` | 清单 | 直接展示 |
| `kind` | 适配器 | 工具 / 壁纸 |
| `status` | 扫描结果 | `ready` / `unverified` / `tampered` / `invalid` / `needs-review` |
| `enabled` / `running` | 授权账本 / 窗口表 | 仅 widget |
| `verified` | 摘要复核 | `declared` / `computed` / `none` |
| `dev` | 开发注册表 | 开发包徽章，禁止与正式包混排误导 |
| 作者 / 许可 | 清单 | 缺失时显示“未声明” |

### 4.4 状态徽章

| 徽章 | 条件 | 颜色 |
| --- | --- | --- |
| 已校验 | 摘要匹配（声明或本地锁定） | 次级 |
| 未校验 | 无摘要且未锁定 | 描边 + 警告文案 |
| 摘要不符 | 摘要不匹配 | 危险色，禁止加载 |
| 清单无效 | 清单/结构校验失败 | 危险色，展示错误码 |
| 开发包 | `dev = true` | 描边 + 「开发」 |
| 待复核 | 清单哈希与启用快照不一致 | 警告色，禁止加载 |
| 已启用 / 运行中 | 授权 / 窗口存在 | 次级 / 强调 |

### 4.5 详情面板

详情用对话框（不新增路由），内容包括：

- 名称、版本、作者、许可、kind、安装路径（可复制）。
- 能力列表：声明 / 已授予 / 实际生效，逐项开关（运行时禁用，见 §9.4）。
- 诊断：错误码 + 可复制的原因；`hostApi`、`schemaVersion`、包大小、文件数。
- 危险区：卸载（二次确认，明确会删除状态数据）。

### 4.6 空状态与错误

- 无扩展：给“从文件安装”按钮 + 一句包结构说明。
- 拖拽不可用：提示用「从文件安装」（现有 `content-packages-card` 的降级文案可复用）。
- 安装失败：不弹系统级错误，卡片内展示 `code` + `message`，详情里给完整原因。
- 目录不可读 / APPDATA 不可写：顶部横幅，不影响已加载的扩展运行。

---

## 5. 状态模型

### 5.1 Widget 三态

```text
             install                enable                 open
  (未安装) ──────────► 已安装 ──────────────► 已启用 ──────────────► 运行中
                        │                      │                    │
                        │                      │  close（隐藏）      │
                        │                      │◄───────────────────┤
                        │                      │  stop（销毁窗口）    │
                        │                      │◄───────────────────┘
                        │                      │
                        │  uninstall           │  disable
                        ▼                      ▼
                     (未安装) ◄────────────────┘
```

| 状态 | 判定 | 允许的动作 |
| --- | --- | --- |
| 已安装 | 目录存在，清单有效；摘要通过或未声明 | 查看详情、启用、卸载 |
| 已启用 | 授权账本 `enabled = true` 且清单快照未漂移 | 打开、关闭、停用、改权限（需先停止） |
| 运行中 | `widget-<id>` 窗口存在 | 关闭（隐藏）、结束运行、停用、卸载 |

补充规则：

- **安装不执行扩展代码**：只做文件校验与落盘，不创建 WebView。
- **启用才授权**：启用时展示权限说明，用户确认后写入授权账本与清单快照。
- **打开才建窗**：窗口创建仍走 `widget_package::open_window` 的受控路径。
- **关闭的行为由清单 `lifecycle` 决定**（默认 `background`）：
  - `background`：关闭 = 隐藏，JS 继续运行（番茄钟、播放器需要后台）；
  - `suspend`：关闭 = 销毁窗口，下次打开冷启动（重动画、重资源类工具）。
  两种情况下“运行中”都以窗口是否存在判定；UI 要能区分“前台 / 后台”。
- **结束运行 = 销毁窗口**：`extensions_stop` 销毁 WebView，状态 KV 保留，下次冷启动。
- **停用 = 销毁窗口 + 撤销运行资格**：不是卸载；文件与状态保留。
- **卸载 = 销毁窗口 + 删授权 + 删状态 + 删文件**：二次确认，文案写明数据会丢。

### 5.2 Scene 的差异

Scene 没有“启用/运行”概念，只有：

| 状态 | 判定 | 动作 |
| --- | --- | --- |
| 已安装 | 目录存在，清单有效 | 查看详情、去壁纸设置、卸载 |
| 已校验 / 未校验 / 摘要不符 | 同 widget | 摘要不符禁止被壁纸引用 |

扩展中心对 scene 只提供“去壁纸设置”和“卸载”，不复制壁纸选择器。
后续如果要在中心里直接应用壁纸，再加 `extensions_apply_scene`，v1 不做。

---

## 6. 包格式

### 6.1 Scene：保持现状

```text
my-scene/
  catalog.json                 # { schemaVersion: 1, scenes: [ 单条 scene ] }
  scenes/my-scene/index.html
  LICENSE / README.md
```

规则、摘要、签名全部沿用 [内容包格式](./content-format.md)，本文不改。
安装器仍然要求 `integrity`，摘要仍只覆盖 entry 所在目录。

### 6.2 Widget：增量，不换格式

```text
my-widget/
  widget.json                # schemaVersion 2，保持现有字段
  .lull-integrity.json       # 可选：本地摘要锁（见 6.3）
  index.html                 # entry，允许位于包根
  main.js / style.css
  assets/
  LICENSE / README.md
```

- `widget.json` **不升版本**。新增字段一律可选、向后兼容：
  - `icon?`：包内相对路径，`.png` / `.webp` / `.jpg`，≤ 256 KiB；v1 不收 SVG
    （避免内联脚本与外部引用，宿主侧只当 `<img>` 用）；
  - `lifecycle?`：`"background"`（默认，关闭只隐藏）或 `"suspend"`（关闭即销毁）；
  - 未来再加 `screenshots?`、`homepage?` 时同样不升 `schemaVersion`；
  - 破坏性变更才升 3，并拒绝旧宿主。
- `entry` 仍允许包根（`index.html`），不强制 `app/` 子目录。
- 包里**不允许**符号链接；**不允许**除 `.lull-integrity.json` 外的点号开头路径
  （协议层也会拒绝，避免摘要范围与可服务范围不一致）。
- 单包预算沿用安装管线：512 个文件、单文件 8 MiB、整包 64 MiB。

### 6.3 摘要：旁路锁文件

**问题**：widget 的 `entry` 在包根，`widget.json` 也在包根。若把摘要写进
`widget.json` 并覆盖全包，写入摘要会改变自身字节，永远算不出来；若把清单排除在
摘要外，攻击者改清单就能提权。

**方案**：摘要放在包内旁路文件 `.lull-integrity.json`，**摘要覆盖除它以外的所有文件
（含 `widget.json`）**。

```json
{
  "schemaVersion": 1,
  "algorithm": "sha256",
  "scope": "package",
  "digest": "64 位小写十六进制",
  "source": "declared" | "computed"
}
```

算法：

```text
sha256(
  "lull-widget-package\0" +
  id + "\0" + version + "\0" +
  Σ(相对路径 + "\0" + 字节数 + "\0" + 文件字节 + "\0")   # 路径按 UTF-8 字节序排序
)
```

与 scene 摘要的区别（**故意不共用**）：

| | scene | widget |
| --- | --- | --- |
| 域分隔符 | `lull-content-package` | `lull-widget-package` |
| 覆盖范围 | entry 所在目录 | 包根，排除 `.lull-integrity.json` |
| 清单是否在内 | 否（在目录外） | 是（在包内） |
| 谁来写 | `pnpm content:hash` | 创作者脚本或安装器 |

域分隔符不同，A 类型的摘要不可能被当成 B 类型复用。

**TOFU（trust on first use）**：

- 从 ZIP 安装：
  - 包内带 `.lull-integrity.json` → 复算并比对，不一致直接拒绝；
  - 不带 → 安装器计算并写入，`source = "computed"`。
- 手动拷贝的包：扫描时无锁 → `unverified`；用户在中心点“启用”时计算并写锁
  （目录不可写则保持未校验并提示）。
- 运行时扫描：有锁就复算；不一致 → `tampered`，**不加载、不建窗**。
- 锁文件本身不参与摘要；它只是本机完整性锚点，**不是签名**，不证明发布者身份。

> 这样做的取舍：没有第三方签名时，摘要无法证明“这个包来自谁”，但能证明
> “安装之后没有被改过”。后者才是本地扩展最现实的威胁。

### 6.4 版本、兼容与冲突

| 字段 | 规则 |
| --- | --- |
| `schemaVersion` | widget 固定 2；scene 固定 1；不支持直接拒绝 |
| `hostApi` | widget `1..=HOST_API`；scene `compatibility.hostApi` 沿用现有过滤 |
| `version` | 语义化版本；v1 不比较大小；scene 可覆盖安装，widget 仍拒绝 |
| `id` | widget `^[a-z][a-z0-9-]{1,31}$`；scene `^[a-z0-9][a-z0-9._-]{2,63}$`；两套命名空间独立 |
| `lifecycle` | `background` / `suspend`；缺省 `background`，未知值拒绝 |
| 同 id 已安装 | **scene**：备份旧目录后覆盖（本地手动更新）；**widget**：拒绝，提示先卸载 |
| license | 从 ZIP 安装时必填；手动放置缺失只警告（不阻断） |

scene 的覆盖安装只解决“本地把新 zip 装到同 id 上”：不做版本大小比较、不做回滚、
不做状态迁移；壁纸按 manifest version 重建 iframe。完整更新/回滚仍在第二阶段。
widget 覆盖需要授权账本、运行中窗口与状态 KV 的迁移设计，继续保持拒绝。

### 6.5 为什么不再造一个统一 manifest

统一清单看起来诱人，但会把三类差异硬塞进一个 schema：

- **能力词汇不同**：`wallpaper.*` vs `widget.*`，白名单必须按 kind 分派。
- **运行时不同**：scene 是空 sandbox 的静态页；widget 是可执行 JS + 桥 + KV。
- **摘要范围不同**：scene 在 entry 目录；widget 在包根且含清单。
- **失败语义不同**：scene 坏包只影响壁纸下拉；widget 坏包涉及授权与已开窗口。

结论：**共享安装管线，不共享格式**。等第三种类型（theme / sound preset）真的落地，
再评估是否抽公共信封；现在抽只会多一层翻译。

---

## 7. 共享安装管线

### 7.1 流程

```text
source (.zip / 目录)
  │
  ├─ 1. 解压/复制到 <root>/.staging-<随机>
  │      · 拒绝 .. / 绝对路径 / 反斜杠 / NUL / 符号链接
  │      · 文件数 ≤ 512，单文件 ≤ 8 MiB，整包 ≤ 64 MiB
  │
  ├─ 2. 定位包根（允许 ZIP 外层套一层目录）
  │      · catalog.json → scene
  │      · widget.json  → widget
  │      · 两者都有 → 歧义错误；都没有 → 缺清单错误
  │
  ├─ 3. 交给对应适配器校验
  │      · 清单字段 / id / entry / 能力 / 兼容性 / 许可
  │      · 摘要：scene 必填并比对；widget 有则比对，无则计算
  │
  ├─ 4. 冲突检查：scene 目标已存在 → 备份旧目录后覆盖；widget 已存在 → 拒绝
  │
  ├─ 5. 原子落地：rename(bundle, <root>/<id>)
  │
  └─ 6. 广播 extensions-changed；清理 staging
```

失败路径：任何一步失败只删 staging，不碰已安装内容；启动时清理超过 24h 的
`.staging-*` 残留。

**两步确认**：UI 先调用 `extensions_inspect(path)` 做一次无副作用校验，弹出确认框
（名称、版本、作者、许可、kind、能力、网络源、文件数/体积），用户确认后再调用
`extensions_install(path, sourceDigest)`。安装器重新校验并与传入指纹比对；两次之间包被
替换或修改 → `package.changed`，不落盘。安装确认只回答“装什么”，权限仍在启用时授予。

> v1 不建额外的“安装记录”文件：版本与来源以清单为准，目录 mtime 只用于诊断。
> 更新/回滚阶段再引入安装注册表（安装时间、来源、上一版本），避免现在多一份会漂移的状态。

### 7.2 适配器契约（Rust 草图）

```rust
pub enum Kind { Scene, Widget }

pub struct Validated {
  kind: Kind,
  id: String,
  version: String,
  manifest: serde_json::Value,
  verified: Verified,       // Declared | Computed | None
  payload_dir: PathBuf,     // rename 的源目录
}

pub trait Adapter {
  fn kind(&self) -> Kind;
  fn detect(&self, bundle: &Path) -> bool;
  fn validate(&self, bundle: &Path) -> Result<Validated, ExtensionError>;
  fn target_root(&self, app: &AppHandle) -> Result<PathBuf, String>;
}
```

v1 不追求 trait 对象注册表；两个适配器用 `match kind` 分派即可，保持可读。

### 7.3 卸载

```text
extensions_remove(kind, id)
  ├─ widget: 销毁窗口 → 删授权记录 → 删 .state/<id>.json → 删目录
  ├─ scene : 若正被壁纸引用 → 拒绝（extension.in-use）；否则删目录
  └─ 广播 extensions-changed
```

v1 在 scene 被引用时**拒绝卸载并提示先切换场景**，不做自动回退：回退要同时改全局
`scene` 与各显示器覆盖，并重建/热更壁纸窗，属于独立改动，留到后续版本。
这样不会留下指向不存在目录的配置。

### 7.4 事件

| 事件 | 触发 | 消费者 |
| --- | --- | --- |
| `extensions-changed` | 安装 / 卸载 / 启用 / 改权限 / 开发包增删 | 扩展中心、托盘、设置页工具列表 |
| `content-changed` | 兼容期别名，和上面同时发 | 壁纸窗、`useSceneCatalog` |
| `widgets-changed` | 窗口显示/隐藏（现有） | 设置页开关 |

过渡期同时发新旧两个事件，壁纸窗继续监听旧的；一个版本后移除旧事件。

---

## 8. IPC 契约

### 8.1 返回结构

```ts
type ExtensionKind = "scene" | "widget";

type ExtensionStatus = "ready" | "unverified" | "tampered" | "invalid" | "needs-review";

type ExtensionError = {
  code: string;      // 稳定错误码，见 8.3
  message: string;   // 可直接展示的中文
  detail?: string;   // 开发者信息，可复制
};

type ExtensionInfo = {
  kind: ExtensionKind;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  iconUrl?: string;
  status: ExtensionStatus;
  verified: "declared" | "computed" | "none";
  dev: boolean;
  error?: ExtensionError;

  // widget
  enabled?: boolean;
  running?: boolean;
  visible?: boolean;
  capabilities?: string[];   // 清单声明
  granted?: string[];        // 实际授予
  window?: {
    width: number;
    height: number;
    chrome: "host" | "custom";
  };
  lifecycle?: "background" | "suspend";

  // scene
  entryUrl?: string;
  manifest?: unknown;        // 交给前端 parseSceneManifest 复校
};

export type ExtensionPreview = {
  kind: ExtensionKind;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  capabilities?: string[];   // widget 才有的能力声明
  network?: string[];
  fileCount: number;
  bytes: number;
  sourceDigest: string;      // 源内容指纹（预览→安装一致性），与 integrity 无关
  warnings: string[];        // 未声明许可、未签名等提示
};
```

错误返回统一为 `ExtensionError`（新命令）；保留的运行时命令仍返回 `String`。

### 8.2 命令表

| 命令 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `extensions_list` | — | `ExtensionInfo[]` | 合并两类；单包坏掉不影响其它 |
| `extensions_inspect` | `path` | `ExtensionPreview` | 无副作用校验，供安装确认框使用 |
| `extensions_pick` | — | `{ path, preview } \| null` | 系统对话框选 `.zip` 并校验，不落盘 |
| `extensions_install` | `path, sourceDigest?` | `ExtensionInfo` | 嗅探 kind，走共享管线；源指纹不符则拒绝 |
| `extensions_remove` | `kind, id` | `()` | 卸载，见 7.3 |
| `extensions_open` | `kind, id` | `()` | widget 建窗/唤醒；scene 不建窗，由前端切到壁纸设置 |
| `extensions_close` | `id` | `()` | 按 `lifecycle` 隐藏或销毁窗口 |
| `extensions_stop` | `id` | `()` | 强制销毁窗口 |
| `extensions_set_enabled` | `id, enabled` | `ExtensionInfo` | 启用前 UI 已确认权限 |
| `extensions_set_capability` | `id, capability, granted` | `ExtensionInfo` | 运行中拒绝 |
| `extensions_open_dir` | `kind` | `string` | 打开安装目录 |
| `extensions_dev_state` | — | `DevState` | 开发模式开关 + 已挂目录 |
| `extensions_dev_set_enabled` | `enabled` | `DevState` | 关闭时销毁开发窗口，保留配置 |
| `extensions_dev_pick_and_add` | — | `ExtensionInfo \| null` | 目录选择器 + 挂载 |
| `extensions_dev_remove` | `id` | `()` | 取消挂载（不删文件） |
| `extensions_dev_reload` | `id` | `()` | 重载窗口；未打开则建窗 |

保留的运行时命令：`widget_state_get/set/remove`、`widget_set_transparent`、
`widget_package_notify`、`window_set_frame`、`widget_open` 等。

旧的场景/插件管理命令（`content_package_*`、`widget_packages`、
`widget_package_set_enabled` 等）已在 M6 下线，避免同一功能长期双轨；
设置页统一走 `extensions_*`。

> `content_packages`（只读场景列表）**保留**：壁纸窗需要它来解析场景目录，且不应为了
> 列场景而拿到 widget 管理命令。扩展中心用 `extensions_list`，壁纸窗继续用窄命令。

### 8.3 错误码

| code | 场景 |
| --- | --- |
| `package.not-found` | 源路径不存在 |
| `package.unsupported` | 既不是目录也不是 `.zip` |
| `package.ambiguous` | 同时存在两种根清单 |
| `package.changed` | 预览确认后包内容发生变化 |
| `package.manifest-missing` | 找不到 `catalog.json` / `widget.json` |
| `package.unsafe-entry` | ZIP 条目穿越、绝对路径、符号链接 |
| `package.too-large` | 文件数 / 单文件 / 总量超限 |
| `manifest.invalid-json` | 清单不是合法 JSON |
| `manifest.schema-unsupported` | `schemaVersion` 不支持 |
| `manifest.field-invalid` | 必填字段缺失或格式错误 |
| `manifest.id-invalid` | id 规则不符 |
| `manifest.id-conflict` | widget 同 id 已安装；scene 走覆盖安装 |
| `manifest.entry-missing` | entry 不存在 |
| `manifest.entry-unsafe` | entry 越界 |
| `manifest.host-api-unsupported` | `hostApi` 超出范围 |
| `manifest.capability-unknown` | 能力不在白名单 |
| `manifest.network-invalid` | 网络源不是 https/localhost |
| `manifest.window-invalid` | 窗口尺寸 / chrome / resizable 非法 |
| `manifest.license-missing` | 从 ZIP 安装但未声明许可 |
| `integrity.missing` | scene 安装缺少摘要 |
| `integrity.mismatch` | 摘要不匹配 |
| `integrity.invalid` | 旁路锁文件格式非法 |
| `extension.not-found` | id 未安装 |
| `extension.not-enabled` | 未启用就打开 |
| `extension.running` | 运行中改权限 |
| `extension.in-use` | scene 正被壁纸引用，不能卸载 |
| `extension.unsupported-kind` | `kind` 不是 scene / widget |
| `extension.open-failed` | 创建/唤醒窗口失败 |
| `extension.update-failed` | 启用/停用/权限/关闭失败 |
| `extension.remove-failed` | 卸载失败 |
| `extension.reload-failed` | 开发包重载窗口失败 |
| `dev.disabled` | 开发模式未开启 |
| `dev.not-found` | 没有挂载该开发包 |
| `dev.update-failed` | 切换开发模式失败 |
| `dev.path-invalid` | 本地路径不可用 / 无清单 |
| `dev.id-conflict` | 开发包 id 与已安装冲突 |
| `internal.unimplemented` | 命令尚未实现（仅过渡期） |
| `io.error` | 落盘 / 读取失败 |

---

## 9. 权限模型

### 9.1 三组集合

- **declared**：清单 `capabilities` 声明。
- **granted**：授权账本里用户确认过的能力。
- **effective**：`declared ∩ granted`，再叠加宿主强制规则：

| 能力 | 强制点 | 撤销后的实际效果 | 级别 |
| --- | --- | --- | --- |
| `widget.ui` | 无 | 始终可用（基础） | 基础 |
| `widget.theme` | 宿主不再下发主题消息 | 插件停留旧配色 | 提示 |
| `widget.state` | `require_grant` | 状态命令返回 `denied` | 强制 |
| `widget.audio` | 宿主 `requestAudio` 返回 false | iframe 仍可自行发声 | 提示 |
| `widget.media` | 文件选择请求返回 denied | iframe 仍可用浏览器原生选择 | 提示 |
| `widget.network` | CSP `connect-src` 只留包自身 | 外部请求被 CSP 拦截 | 强制 |
| `widget.chrome` | 宿主拒绝拖拽/最小化/关闭/透明命令 | 窗口回退到宿主顶栏 | 强制 |

> 音频/媒体是产品策略，不是安全沙箱；权限界面必须写清楚“提示级”，不能暗示已阻止。

### 9.2 清单漂移

启用时把 `widget.json` 的 SHA-256 存进授权账本（`manifestHash`）+ 能力快照。
每次扫描：

- 哈希一致 → 正常。
- 哈希不一致 → `status = needs-review`，**不加载、不建窗**；卡片提示“清单已变化，
  请重新确认权限”。用户重新启用即刷新快照。
- 旧版授权记录没有 `manifestHash` → 视为已信任，不强制重新确认；下次启用时写入快照。

这弥补了“摘要锁只证明文件没变、但不能证明能力没变”的缺口：清单本身也在摘要里，
所以正常情况下改清单会先触发 `tampered`；`needs-review` 主要覆盖“用户手动重算锁”
或“开发包”这类场景。

### 9.3 网络

- `network` 只允许 `https://` 与 `http://localhost:<port>`。
- CSP 由“实际授予”决定：未授予 `widget.network` 时，`connect-src` 只有包自身源。
- 详情页列出每个源，支持整体撤销；v1 不做“按源逐个授权”。
- 已打开页面的 CSP 不会因撤销即时收紧；撤销后需**停止并重开**才生效，UI 要写明。

### 9.4 运行中锁定

运行中（窗口存在，含隐藏）禁止修改权限：

- 卡片上的权限开关禁用，提示“先结束运行再修改”。
- 原因：撤销 `widget.chrome` 会让自绘顶栏的插件失去关闭能力；撤销 `widget.state`
  会让页面在运行中报错。停止后修改，语义清晰。
- 停用 / 卸载不受此限：它们本来就会销毁窗口。

### 9.5 授权流程

```text
点“启用”
  → 打开权限确认对话框
      · 列出 declared 能力、级别（强制/提示）、网络源
      · 说明“启用不会自动打开窗口”
  → 用户确认
      → 写 grants：enabled=true, granted=declared, manifestHash
      → 卡片变为“已启用”
  → 用户点“打开”
      → 宿主建窗，注入 granted + theme + viewport
```

不做“安装即授权”。安装只需要文件可信，运行才需要能力可信。

---

## 10. 开发模式

### 10.1 配置文件

`%APPDATA%\app.lull.desktop\extensions.json`：

```json
{
  "schemaVersion": 1,
  "devMode": false,
  "devPackages": [
    { "id": "my-widget", "path": "F:\\dev\\my-widget" }
  ]
}
```

- 原子写；损坏时回退为空并记日志，不阻塞启动。
- `devMode` 默认 `false`；关闭时开发包**不列出、不解析、窗口销毁**，文件不动。

### 10.2 挂载规则

- 路径必须存在、是目录、包含 `widget.json`，清单通过完整校验。
- 路径 canonicalize 后保存；协议服务时再做 `safe_join`，防符号链接逃逸。
- id 与已安装包冲突 → 拒绝，提示先卸载正式包（避免“到底加载了哪个”）。
- 开发包**不复制**文件、**不要求**摘要；`verified = none`，徽章「开发包」。
- 开发目录里的 `.git` 等点号路径不会被协议服务，也不参与任何校验；扫描时直接跳过。
- 开发包仍走同一套授权：未启用不能打开；权限对话框与正式包一致，不额外给系统能力。

### 10.3 重载

- `extensions_dev_reload(id)`：窗口存在 → `webview.reload()`；不存在 → 建窗。
- 资源协议 `Cache-Control: no-store` 已具备，刷新即拿到新文件。
- 清单字段变化（窗口尺寸、能力、chrome）需要重建窗口：先 `stop` 再 `open`，
  重载命令内部按需处理。

### 10.4 隔离与退出

- 开发模式开启时，扩展中心底部显示开发模式卡片；开发包条目带「开发」徽章，
  不能只靠颜色区分。
- 关闭开发模式：销毁所有开发窗口、隐藏开发包；不删除目录、不清授权账本。
- 开发包 ID 与正式包同表展示时必须有显式徽章，不能只靠颜色区分。

---

## 11. 打开与发现

### 11.1 设置页工具列表

「窗口」卡片里的工具列表追加一组“扩展工具”：

- 只列**已启用**的 widget；
- 开关语义 = 打开 / 关闭窗口；关闭时按清单 `lifecycle` 隐藏或销毁；
- `background` 扩展隐藏后仍在运行，列表要标注“后台运行”，不能显示成“已关闭”；
- 未启用的扩展只在扩展中心出现，避免用户误以为开关就是授权。

### 11.2 托盘

- 托盘菜单增加「扩展」子菜单，只列已启用 widget，点击直接打开。
- 没有已启用扩展时省略该子菜单。
- `extensions-changed` 时重建菜单；重建失败保留旧菜单并记日志，不影响托盘退出。
- 实现：`app.tray_by_id("main-tray")` + `set_menu`；菜单构建集中在 `tray.rs`。

### 11.3 Scene 的“打开”

Scene 不建窗。中心里的“查看壁纸设置”切到「壁纸」页签的壁纸层卡片；
如果后续需要一键应用，再单独设计 `extensions_apply_scene`。

---

## 12. 安全边界

### 12.1 威胁与处理

| 威胁 | v1 处理 | 仍未解决 |
| --- | --- | --- |
| ZIP 路径穿越 / 符号链接 | 安装管线统一拒绝 | — |
| ZIP 炸弹 / 超大包 | 文件数、单文件、总量上限 | 解压耗时上限（可后续加） |
| 安装后被本地篡改 | `.lull-integrity.json` + 每次扫描复算 | 有权限的本机攻击者可同时改锁 |
| 改清单提权 | 清单在摘要内 + `manifestHash` 快照 | 用户手动重算锁后仍会信任 |
| 不可信 JS 访问宿主 | 不透明源 iframe + 最小 ACL + postMessage 桥 | WebView2 子帧仍可见 Tauri internals |
| 网络外传 | CSP 按授权源限制 | 声明了 `network` 的包本来就可联网 |
| 供应链投毒 | 无（没有下载源、没有签名） | 需要发布者签名与信任链，v1 明确不做 |
| 开发模式被滥用 | 默认关闭、显式徽章、同权限模型 | 用户主动开启即自担风险 |

### 12.2 必须写进文档与 UI 的话

- **`allow-scripts` + postMessage 不自动构成安全沙箱**。它只保证 iframe 拿不到宿主
  DOM / 存储，不保证插件不联网、不发声、不消耗 CPU。
- **摘要不是签名**。它证明“没被改过”，不证明“是谁做的”。
- **启用不是安全审计**。权限界面展示的是宿主实际能强制执行的能力，提示级能力要标注。
- **不做“任意代码插件系统”的承诺**。扩展仍是静态 Web 包，不能创建窗口、不能调
  任意 Rust 命令、不能访问 Win32。

---

## 13. 兼容与迁移

| 对象 | 迁移方式 |
| --- | --- |
| 已手动安装的 widget | 无锁 → `unverified`；仍可加载；首次启用补锁 |
| 已启用的 widget | 旧记录缺 `manifestHash` 时视为已信任；下次启用写入快照 |
| 已安装的 scene | 完全不变 |
| 旧管理命令 | M6 已下线；`content_packages` 与运行时命令保留 |
| `content-changed` 监听方 | 过渡期继续可用；同时监听 `extensions-changed` |
| `widget.json` | 不改必填字段；新字段可选；旧宿主忽略新字段 |
| 降级 | 新版本安装的 widget 在旧版本仍可加载（旧版本忽略 `.lull-integrity.json`） |

---

## 14. 验收标准

- [ ] 从 ZIP 安装 widget：清单/结构/摘要/许可校验通过才落盘，失败不产生半成品。
- [ ] 安装前展示确认摘要；确认后包被改动时拒绝安装（`package.changed`）。
- [ ] 安装后不自动建窗、不执行扩展 JS。
- [ ] 已安装列表同时展示 scene 与 widget，状态、版本、kind、徽章正确。
- [ ] 启用弹出权限确认；取消则保持未启用。
- [ ] 打开只对已启用扩展生效；关闭隐藏、结束运行销毁、停用销毁并撤销运行资格。
- [ ] 关闭行为符合 `lifecycle`：`background` 隐藏后仍运行，`suspend` 关闭即销毁。
- [ ] 逐能力撤销生效：`network` 被 CSP 拦截，`state` 返回 denied，`chrome` 回退宿主顶栏。
- [ ] 运行中不能改权限，提示明确。
- [ ] 卸载删除文件、授权、状态，并广播事件；scene 被引用时安全回退。
- [ ] 摘要不符的包不加载、不建窗，卡片可诊断。
- [ ] 开发模式：添加目录、打开、改文件、重载生效；关闭开发模式后窗口消失。
- [ ] 托盘「扩展」子菜单随启用状态增删。
- [ ] 旧版已安装包不卸载也能继续用。
- [ ] `pnpm check`、`cargo test` 全绿；新增命令同时进了 `lib.rs` 与 `build.rs`。

---

## 15. 待拍板

| # | 决策 | 建议 | 备选 |
| --- | --- | --- | --- |
| D1 | 品牌与后缀 | 统一 Lull；`.lull-widget.zip` / `.lull-scene.zip`，安装器接受任意 `.zip` | 保留 Serene（需先改品牌文档） |
| D2 | widget 摘要 | 旁路 `.lull-integrity.json` + TOFU；覆盖含 `widget.json` 的全包 | 摘要写进 manifest 并排除自身；强制 `app/` 子目录 |
| D3 | 设置页 IA | 顶部「偏好 / 壁纸 / 扩展」页签 | 单页继续堆卡片 |
| D4 | 权限粒度 | 逐能力开关，运行中锁定 | 只做“全部授权 / 全部撤销” |
| D5 | scene 是否进中心 | 进，但只提供“去壁纸设置 / 卸载” | 中心只做 widget，scene 留在原卡片 |

D1–D5 建议先按“建议”列冻结；实现中若发现冲突，回到本文更新，不在代码里悄悄改。
