# Lull 许可说明

> 本文是工程层面的许可说明，不构成法律意见。正式商业发布前建议律师复核。

## 1. 许可矩阵

| 范围 | 许可 | SPDX | 文件 |
| --- | --- | --- | --- |
| 应用代码：Rust / C++ / Next.js / React / 脚本 | GPL-3.0-or-later | `GPL-3.0-or-later` | [LICENSE](../LICENSE) |
| Scene / Widget / Content SDK 公开接口 | Apache-2.0 | `Apache-2.0` | [SDK-LICENSE.md](../SDK-LICENSE.md) |
| 官方内容：catalog / schema / 外部示例 | CC BY 4.0 | `CC-BY-4.0` | [CONTENT-LICENSE.md](../CONTENT-LICENSE.md) |
| 文档 | CC BY 4.0 | `CC-BY-4.0` | 本文与 `docs/**` |
| 字体 | SIL OFL 1.1 | `OFL-1.1` | [LICENSES/OFL-1.1.txt](../LICENSES/OFL-1.1.txt) |
| 名称 / Logo | 商标政策，非 OSI 许可 | — | [TRADEMARK.md](../TRADEMARK.md) |
| 第三方依赖 | 各自许可 | 见 lockfile | [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) |

## 2. 为什么是 GPL-3.0-or-later

- **强 copyleft**：修改后的桌面应用再分发时必须继续开源，防止闭源分叉。
- **与 Apache-2.0 兼容**：Tauri 等依赖是 MIT / Apache-2.0；GPL-2.0 与
  Apache-2.0 不兼容，所以不选 GPL-2.0。
- **不是 AGPL**：Lull 本地优先，在线服务是可选的 D 阶段能力；桌面端用 AGPL
  会扩大网络条款的适用范围，收益有限。未来服务端可以单独选择 AGPL-3.0。
- **`or-later`**：允许未来按 GPL 新版本分发；如果你希望锁定 GPLv3，可改为
  `GPL-3.0-only`，但需要同步所有元数据。

## 3. 为什么 SDK 用 Apache-2.0

`src/sdk/**` 是场景/工具作者直接接触的公开契约。Apache-2.0：

- 允许第三方在自有项目中复用类型和协议；
- 含明确的专利授权；
- 不强迫每个主题/工具都采用 GPL。

注意：Lull 应用整体仍是 GPL。SDK 的 Apache-2.0 只覆盖 SDK 源文件本身；
把 SDK 编译进 Lull 安装包时，整个分发物按 GPL 处理。

## 4. 为什么内容用 CC BY 4.0

- 内容包需要作者署名，但不强制 share-alike，便于传播；
- 官方示例可作为模板被修改；
- 第三方内容仍可自选许可，只需在 manifest 声明。

内置场景实现（`src/scenes/**`）是应用代码，仍为 GPL；不要把它当作 CC BY 内容。

## 5. GPL 合规要点

1. **源码提供**：分发安装包时，必须让接收者能获得对应版本的完整源码。
   当前仓库即对应源码；发布 release 时请打 tag，并在 README/关于页链接到该
   tag 的源码归档。
2. **许可证文本**：安装包内包含 `LICENSE`、`NOTICE` 与 `THIRD_PARTY_NOTICES.md`；
   Tauri 的 `bundle.licenseFile` 已指向 `LICENSE`。
3. **不得附加限制**：安装向导/EULA 不得添加“禁止反向工程”“禁止商业使用”等
   与 GPL 冲突的条款。
4. **修改声明**：如果你分发修改版，需保留版权与许可声明，并标明修改。
5. **安装信息**：GPLv3 对“User Product”有安装信息要求；普通 Windows 安装包
   通常不触发，但若与硬件捆绑销售，请单独复核。
6. **系统组件**：WebView2 运行时是微软的系统组件，不随 Lull 分发；不要把它
   打包进 GPL 安装包而不复核微软条款。

## 6. 贡献政策

- 应用代码贡献按 `GPL-3.0-or-later` 接收；
- `src/sdk/**` 贡献按 `Apache-2.0` 接收；
- 文档/内容贡献按 `CC-BY-4.0` 接收；
- 采用 **DCO**（`git commit -s`）而不是 CLA；如果未来要做商业双许可，再评估 CLA。

## 7. SPDX 头

新增第一方源文件建议加：

```ts
// SPDX-FileCopyrightText: 2026 Lull contributors
// SPDX-License-Identifier: GPL-3.0-or-later
```

SDK 文件使用：

```ts
// SPDX-FileCopyrightText: 2026 Lull contributors
// SPDX-License-Identifier: Apache-2.0
```


## 8. 依赖审计

发布前运行：

```powershell
pnpm licenses list
cargo install cargo-deny --locked
cargo deny check licenses
```

重点排除：

- 非商业 / No-Derivative / Commons Clause；
- SSPL / BSL 等非 OSI 许可；
- 与 GPL-3.0 不兼容且会被链接进应用的许可；
- 未声明许可的字体、图片、音频。

## 9. 常见问题

**可以把 Lull 用在公司内部吗？**
可以。GPL 的义务主要在“对外分发”时触发。

**可以卖 Lull 吗？**
可以，但必须按 GPL 提供对应源码，且不能阻止接收者再分发。

**可以做一个闭源主题/场景吗？**
外部静态内容包是独立文档，可以自选许可；若复制 SDK 代码，需遵守 Apache-2.0。
若把内容编译进应用，则按 GPL 处理。

**可以基于 Lull 做闭源桌面应用吗？**
不可以直接闭源分发衍生应用；需要联系项目讨论商业许可（如提供）。

**为什么不能继续用 HarmonyOS Sans？**
它的自定义许可限制修改/独立再分发，与 GPL 分发放在同一安装包存在冲突风险；
已替换为 OFL 的 Noto Sans SC。
