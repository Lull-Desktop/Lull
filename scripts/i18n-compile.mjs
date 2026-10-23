#!/usr/bin/env node
/**
 * 编译 i18n 消息：i18n/messages/*.json → src/paraglide/（生成物不入库）。
 *
 * 为什么用 CLI 脚本而不是 next 的 webpack 插件：本项目 `next dev` 走 Turbopack、
 * 构建走 `output: "export"`，插件在两条链路上都不稳；编译期一次性产出的 `m.xxx()`
 * 纯函数对两边是一样的。
 *
 * 策略只保留 localStorage + baseLocale：桌面应用没有服务端，也不把 locale 放进 URL。
 * 真正的取值来源是 Rust 注入的 `window.__LULL_LOCALE__`（见 src/i18n/locale.ts）。
 */
import { compile } from "@inlang/paraglide-js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await compile({
  project: join(root, "project.inlang"),
  outdir: join(root, "src", "paraglide"),
  strategy: ["localStorage", "baseLocale"],
  // 生成的 .d.ts 让 `m.xxx()` 在 tsc / 编辑器里有完整类型，代价是编译稍慢。
  emitTsDeclarations: true,
  // 生成目录整体被 gitignore，README / .prettierignore 没有意义。
  emitReadme: false,
  emitPrettierIgnore: false,
  includeEslintDisableComment: false,
});

console.log("[i18n] 编译完成 → src/paraglide");
