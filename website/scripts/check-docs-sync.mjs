#!/usr/bin/env node
/**
 * 校验站点文档区与仓库 docs/ 是否一一对应。
 *
 * 规则：`docs/*.md` 里的每一篇，站点都要有同名页面（`src/content/docs/<name>.md`）。
 * 反向不要求——站点可以有一篇导读页（`getting-started`），它取材于 README。
 * 两处例外：
 *   - `MERGED_INTO`：内容已并入别的站点页（如 `content-format` → `scene-sdk`）；
 *   - `NOT_ON_SITE`：站点暂不收录，原文只留在 docs/（要写原因）。
 * 两处登记都不算「缺页」，但会校验登记本身没写错。
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

/**
 * 站点**暂不收录**的仓库文档：原文留在 docs/ 供开发与 review，站点不建页。
 *
 * 和 `MERGED_INTO` 的区别：这些内容没有并进别的页面，只是没上线。
 * 登记时要写清原因——`--list` 会打印出来，免得以后没人知道为什么少了一页。
 * 旧地址同样应该在 `astro.config.mjs` 的 `redirects` 里兜一下。
 */
const NOT_ON_SITE = new Map([
  ["native-host", "原生宿主的内部分层说明，随实现变动，不对外"],
  ["extension-center", "扩展中心的设计稿，实现稳定前不对外"],
  ["extension-center-plan", "实施计划，天然会过期，不上站"],
]);

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

const missing = repo.filter(
  (name) => !site.includes(name) && !MERGED_INTO.has(name) && !NOT_ON_SITE.has(name),
);
const extra = site.filter((name) => !repo.includes(name) && !SITE_ONLY.has(name));

/** 合并登记的完整性：被并入的目标页得在，被合并的旧页不该残留 */
const badMerged = [];
for (const [from, to] of MERGED_INTO) {
  if (!repo.includes(from)) badMerged.push(`MERGED_INTO 登记了 docs/${from}.md，但仓库里没有这个文件`);
  if (!site.includes(to)) badMerged.push(`docs/${from}.md 并入的 ${to} 没有站点页，旧链接会 404`);
  if (site.includes(from)) badMerged.push(`docs/${from}.md 已并入 ${to}，站点里不该再有 ${from}.md`);
}

/** 暂不收录的登记也得对得上：文件得在，站点里确实没有 */
const badSkipped = [];
for (const [name, reason] of NOT_ON_SITE) {
  if (!repo.includes(name)) badSkipped.push(`NOT_ON_SITE 登记了 docs/${name}.md，但仓库里没有这个文件`);
  if (site.includes(name)) badSkipped.push(`docs/${name}.md 已登记为「暂不收录」，但站点里有同名页——删页或删登记`);
  if (!reason?.trim()) badSkipped.push(`docs/${name}.md 的「暂不收录」没写原因`);
}

if (process.argv.includes("--list")) {
  console.log("仓库 docs/：", repo.join(", "));
  console.log("站点文档：", site.join(", "));
  console.log("站点自有：", [...SITE_ONLY].join(", "));
  console.log("已合并：", [...MERGED_INTO].map(([from, to]) => `${from} → ${to}`).join(", ") || "无");
  console.log(
    "暂不收录：",
    [...NOT_ON_SITE].map(([name, reason]) => `${name}（${reason}）`).join(", ") || "无",
  );
}

if (missing.length || extra.length || brokenSources.length || badMerged.length || badSkipped.length) {
  if (missing.length) console.error(`缺少站点页面（docs/${missing.join(".md, docs/")}.md）：\n  ${missing.join("\n  ")}`);
  if (extra.length) console.error(`站点多出的页面（docs/ 里没有对应文件）：\n  ${extra.join("\n  ")}`);
  if (brokenSources.length) console.error(`frontmatter 的 source 指向不存在的文件：\n  ${brokenSources.join("\n  ")}`);
  if (badMerged.length) console.error(`合并登记不一致（见 MERGED_INTO）：\n  ${badMerged.join("\n  ")}`);
  if (badSkipped.length) console.error(`暂不收录登记不一致（见 NOT_ON_SITE）：\n  ${badSkipped.join("\n  ")}`);
  console.error(
    "\n文档区与 docs/ 不同步：补齐页面、在 MERGED_INTO / NOT_ON_SITE 里登记、或把站点自有页加入 SITE_ONLY，见 website/README.md。",
  );
  console.error("\n文档区与 docs/ 不同步：补齐页面或把站点自有页加入 SITE_ONLY，见 website/README.md。");
  if (missing.length) {
    console.error("提示：若该文件本地明明存在，先确认它已被 git 跟踪（`git add docs/<name>.md`）——CI 只看得见已提交的文件。");
  }
  process.exit(1);
}

console.log(`[docs-sync] ${repo.length} 篇仓库文档 ↔ ${site.length} 个站点页面，一致`);
