# 第三方组件与素材授权

Lull 采用分层许可：

- 应用代码：**GPL-3.0-or-later**（见 [LICENSE](LICENSE)）
- SDK 公开接口：**Apache-2.0**（见 [SDK-LICENSE.md](SDK-LICENSE.md)）
- 官方内容与文档：**CC BY 4.0**（见 [CONTENT-LICENSE.md](CONTENT-LICENSE.md)）
- 字体：**SIL OFL 1.1**
- 名称与 Logo：商标政策（见 [TRADEMARK.md](TRADEMARK.md)）

下列组件、字体与素材保留各自授权；再分发安装包或素材时必须同时遵守。

## 1. 上游项目

| 项目 | 授权 | 说明 |
| --- | --- | --- |
| Tauri | MIT / Apache-2.0 | 桌面运行时；GPL-3.0 兼容 |
| Next.js | MIT，Copyright © Vercel | 前端框架 |
| React / React DOM | MIT，Copyright © Meta | UI 运行时 |

## 2. 前端依赖（主要）

| 依赖 | 授权 |
| --- | --- |
| Radix UI / `radix-ui` | MIT |
| shadcn/ui（复制进仓库的组件） | MIT |
| Tailwind CSS | MIT |
| lucide-react（图标） | ISC |
| sonner | MIT |
| class-variance-authority | Apache-2.0 |
| clsx | MIT |
| tailwind-merge | MIT |

完整依赖树以 `pnpm-lock.yaml` 为准；发布安装包前建议生成 SBOM，或使用
`pnpm licenses list` 复核。

## 3. Rust 依赖（主要）

| 依赖 | 授权 |
| --- | --- |
| tauri / tauri-build / tauri-plugin-* | MIT / Apache-2.0 |
| serde / serde_json | MIT / Apache-2.0 |
| libloading | ISC |
| windows（微软 `windows-rs`） | MIT / Apache-2.0 |

完整列表见 `src-tauri/Cargo.lock`。

## 4. 字体

### Noto Sans SC

- 文件：`src/assets/fonts/NotoSansSC-VariableFont_wght.ttf`
- 版权：Copyright 2014-2021 Adobe，Reserved Font Name 'Source'。
- 授权：SIL Open Font License 1.1。
- 完整声明：[`src/assets/fonts/LICENSE_NotoSansSC`](src/assets/fonts/LICENSE_NotoSansSC)。

### Source Han Serif SC

- 文件：`src/assets/fonts/SourceHanSerifSC-Regular.woff2`
- 版权：Copyright © 2017-2022 Adobe，Reserved Font Name 'Source'。
- 授权：SIL Open Font License 1.1。
- 完整文本：[`src/assets/fonts/LICENSE_SourceHanSerif`](src/assets/fonts/LICENSE_SourceHanSerif)。

> HarmonyOS Sans 已移除，不再随 Lull 分发；界面字体统一替换为 OFL 的 Noto Sans SC。

## 5. 图标与品牌素材

- `assets/brand/lull-icon.svg` 与由它生成的 `src-tauri/icons/*`：Lull 项目原创，
  随应用以 GPL-3.0-or-later 发布。
- Lull 名称、云栖名称与 Logo 的商标使用规则见 [`TRADEMARK.md`](TRADEMARK.md)。
- 界面内图标来自 lucide-react（ISC）；未直接复制第三方图标文件。

## 6. 声音与场景素材

- 内置场景（竹影 / 极光 / 暮色）是应用代码，GPL-3.0-or-later。
- 白噪音通过 Web Audio 合成，未打包第三方音频采样。
- 播放器的在线曲目来自其配置的公开源；再分发时需自行确认曲目授权。
- 外部示例场景 `public/content/scenes/mist` 为 Lull 原创示例，CC BY 4.0。

## 7. GPL 分发检查

- [ ] 安装包内包含 `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md` 与 `LICENSES/`；
- [ ] 安装包元数据包含 `GPL-3.0-or-later`（Tauri `bundle.license` / `licenseFile`）；
- [ ] README / 关于页提供对应 release tag 的源码位置；
- [ ] 安装向导/EULA 没有附加与 GPL 冲突的限制；
- [ ] 复核所有图片、音频、场景素材来源与许可证；
- [ ] 复核依赖许可证（重点：Apache-2.0、ISC、OFL、MIT）；
- [ ] 完成代码签名与发布渠道合规检查。
