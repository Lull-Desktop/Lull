#!/usr/bin/env node
/**
 * 校验站点文档区与仓库 docs/ 是否一一对应。
 *
 * 规则：`docs/*.md` 里的每一篇，站点都要有同名页面（`src/content/docs/<name>.md`）。
 * 反向不要求——站点可以有一篇导读页（`getting-started`），它取材于 README。
 * 例外：已经并入其它页面的文档登记在 `MERGED_INTO` 里（如 `content-format` → `scene-sdk`），
 * 不再要求单独建页。
 *
 * 为什么要有这一步：文档目录和站点目录是两处物理位置，靠人记一定会漂。
 * 加了新文档却忘了写站点页时，这个脚本会直接把名字打出来，`pnpm check` 就红了。
 *
 * 用法：
 *   node scripts/check-docs-sync.mjs            # 校验
 *   node scripts/check-docs-sync.mjs --list     # 顺便打印当前映射
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const websiteRoot = resolve(here, "..");
const repoRoot = resolve(websiteRoot, "..");
const repoDocs = resolve(repoRoot, "docs");
const siteDocs = resolve(websiteRoot, "src/content/docs");

/** 站点自有、仓库 docs/ 里没有对应文件的导读页 */
const SITE_ONLY = new Set(["getting-started"]);

/**
 * 已并入其它站点页的仓库文档：仓库原文还在（仍是字段级事实源、仍被 README 等引用），
 * 但站点只保留合并后的那一页，不再单独建页。
 *
 * 登记在这里的文档不算「缺页」，同时会校验两件事：
 *   1. 目标站点页存在（否则链接会死）；
 *   2. 站点里没有残留同名页（否则等于又维护了两份）。
 * `astro.config.mjs` 的 `redirects` 要给出对应的旧地址跳转。
 */
const MERGED_INTO = new Map([["content-format", "scene-sdk"]]);

const mdNames = (dir) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name.replace(/\.md$/, ""))
    .sort();

const repo = mdNames(repoDocs);
const site = mdNames(siteDocs);

/** 从每个站点页的 frontmatter 里读 source，确认它指的文件真的存在 */
const brokenSources = [];
for (const name of site) {
  const raw = readFileSync(join(siteDocs, `${name}.md`), "utf8");
  const front = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const source = front?.[1].match(/^source:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (!source) continue;
  const target = resolve(repoRoot, source);
  try {
    readFileSync(target);
  } catch {
    brokenSources.push(`${name}.md → source: ${source}`);
  }
}

const missing = repo.filter((name) => !site.includes(name) && !MERGED_INTO.has(name));
const extra = site.filter((name) => !repo.includes(name) && !SITE_ONLY.has(name));

/** 合并登记的完整性：被并入的目标页得在，被合并的旧页不该残留 */
const badMerged = [];
for (const [from, to] of MERGED_INTO) {
  if (!repo.includes(from)) badMerged.push(`MERGED_INTO 登记了 docs/${from}.md，但仓库里没有这个文件`);
  if (!site.includes(to)) badMerged.push(`docs/${from}.md 并入的 ${to} 没有站点页，旧链接会 404`);
  if (site.includes(from)) badMerged.push(`docs/${from}.md 已并入 ${to}，站点里不该再有 ${from}.md`);
}

if (process.argv.includes("--list")) {
  console.log("仓库 docs/：", repo.join(", "));
  console.log("站点文档：", site.join(", "));
  console.log("站点自有：", [...SITE_ONLY].join(", "));
  console.log("已合并：", [...MERGED_INTO].map(([from, to]) => `${from} → ${to}`).join(", ") || "无");
}

if (missing.length || extra.length || brokenSources.length || badMerged.length) {
  if (missing.length) console.error(`缺少站点页面（docs/${missing.join(".md, docs/")}.md）：\n  ${missing.join("\n  ")}`);
  if (extra.length) console.error(`站点多出的页面（docs/ 里没有对应文件）：\n  ${extra.join("\n  ")}`);
  if (brokenSources.length) console.error(`frontmatter 的 source 指向不存在的文件：\n  ${brokenSources.join("\n  ")}`);
  if (badMerged.length) console.error(`合并登记不一致（见 MERGED_INTO）：\n  ${badMerged.join("\n  ")}`);
  console.error("\n文档区与 docs/ 不同步：补齐页面或把站点自有页加入 SITE_ONLY，见 website/README.md。");
  if (missing.length) {
    console.error("提示：若该文件本地明明存在，先确认它已被 git 跟踪（`git add docs/<name>.md`）——CI 只看得见已提交的文件。");
  }
  process.exit(1);
}

console.log(`[docs-sync] ${repo.length} 篇仓库文档 ↔ ${site.length} 个站点页面，一致`);
