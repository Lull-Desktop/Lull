#!/usr/bin/env node
/**
 * 整理发布产物：从 `src-tauri/target/release` 收集 MSI / NSIS 安装包，
 * 额外打一个便携版 zip，并生成 SHA256SUMS.txt。
 *
 * 用法：
 *   pnpm release:package              # 打包到 artifacts/release
 *   node scripts/package-release.mjs --out some/dir
 *
 * 前提：已经跑过 `pnpm tauri build`（或 `pnpm build`），
 * 即 `src-tauri/target/release/{lull.exe,lull_native.dll}` 与 `bundle/{msi,nsis}` 都在。
 *
 * 为什么单独写脚本而不是在 CI 里塞 PowerShell：
 *   1. 便携版 zip 复用 scripts/zip-writer.mjs——Windows 的 Compress-Archive 会写成
 *      反斜杠路径，安装器/插件包按安全规则拒绝这种条目；
 *   2. 版本号从 tauri.conf.json 单一取值，并进行一致性校验，避免 tag / 包名漂移；
 *   3. 本地和 CI 用同一条命令，本地能过就说明 CI 也能过。
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createZip } from "./zip-writer.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = join(root, "src-tauri", "target", "release");
const bundleDir = join(releaseDir, "bundle");

const fail = (message) => {
  console.error(`[release] ${message}`);
  process.exit(1);
};

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return fallback;
  }
  const value = process.argv[index + 1];
  if (!value) {
    fail(`${flag} 需要一个路径参数`);
  }
  return value;
}

const outDir = join(root, argValue("--out", join("artifacts", "release")));

// ① 版本号：tauri.conf.json 是打包器真正读取的那一份，package.json 必须跟它一致，
//    否则 CI 里 tag、安装包文件名、站点下载链接会三处对不上。
const tauriConf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = tauriConf.version;
if (!version) {
  fail("src-tauri/tauri.conf.json 缺少 version");
}
if (pkg.version !== version) {
  fail(`版本不一致：package.json=${pkg.version}，tauri.conf.json=${version}`);
}

const product = tauriConf.productName ?? "Lull";
const arch = process.arch === "arm64" ? "arm64" : "x64";

// ② 收集打包器产物。Tauri 的文件名带版本号，这里保留原名，
//    下载页与 sync-release.mjs 都按 `<Product>_<version>_<arch>...` 的形态解析。
//
//    只认当前版本前缀：CI 会复用 src-tauri/target 的编译缓存，里面可能躺着上一次
//    构建留下的旧版本安装包，不过滤就会把旧包一起发到 Release 上。
const expectedPrefix = `${product}_${version}_${arch}`;

function pickFiles(dir, extension) {
  if (!existsSync(dir)) {
    return [];
  }
  const all = readdirSync(dir).filter((name) => name.toLowerCase().endsWith(extension));
  const matched = all.filter((name) => name.startsWith(expectedPrefix));
  const stale = all.filter((name) => !name.startsWith(expectedPrefix));
  for (const name of stale) {
    console.warn(`[release] 忽略版本不匹配的产物：${name}（期望前缀 ${expectedPrefix}）`);
  }
  return matched.map((name) => join(dir, name));
}

const msiFiles = pickFiles(join(bundleDir, "msi"), ".msi");
const exeFiles = pickFiles(join(bundleDir, "nsis"), ".exe");

if (msiFiles.length === 0) {
  fail(`没有找到 ${expectedPrefix}*.msi：先执行 \`pnpm tauri build\`（bundle.targets 需包含 msi）`);
}
if (exeFiles.length === 0) {
  fail(`没有找到 ${expectedPrefix}*.exe：先执行 \`pnpm tauri build\`（bundle.targets 需包含 nsis）`);
}

// ③ 便携版：exe + 原生宿主 DLL + 许可证。
//    ffi.rs 只在 current_exe 同目录找 lull_native.dll，所以 DLL 必须和 exe 同级；
//    便携版仍会往 %APPDATA%\<identifier> 写配置，这一点在 README 里说清楚。
const portableExe = join(releaseDir, "lull.exe");
if (!existsSync(portableExe)) {
  fail(`缺少 ${portableExe}：先执行 \`pnpm tauri build\``);
}
const nativeDll = [
  join(releaseDir, "lull_native.dll"),
  join(root, "src-tauri", "native", "lull_native.dll"),
].find(existsSync);
if (!nativeDll) {
  fail("缺少 lull_native.dll（prebuild 会构建它，检查 scripts/prebuild.mjs 是否跑过）");
}

const licenseNames = ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"];
const licenseFiles = licenseNames.map((name) => join(root, name));
const licenseDir = join(root, "LICENSES");
const bundledLicenses = existsSync(licenseDir)
  ? readdirSync(licenseDir).map((name) => join(licenseDir, name))
  : [];

const readme = [
  `${product} ${version} 便携版 / Portable build`,
  "",
  "解压后直接运行 Lull.exe，无需安装，也不写注册表。",
  "Run Lull.exe directly, no installation required.",
  "",
  "注意：",
  "1. Lull.exe 与 lull_native.dll 必须放在同一目录（壁纸/专注等原生能力靠它加载）。",
  "2. 便携版不写注册表，但配置、扩展与内容包仍保存在",
  "   %APPDATA%\\app.lull.desktop 下，删除该目录即可恢复出厂状态。",
  "3. 便携版不带自动更新，升级请重新下载并整体替换。",
  "",
  "This build is licensed under GPL-3.0-or-later. See LICENSE / NOTICE / THIRD_PARTY_NOTICES.md.",
  "",
].join("\r\n");

const portableRoot = `${product}_${version}_${arch}-portable`;
const zipEntries = [
  { name: `${portableRoot}/${product}.exe`, data: readFileSync(portableExe) },
  { name: `${portableRoot}/lull_native.dll`, data: readFileSync(nativeDll) },
  { name: `${portableRoot}/README.txt`, data: Buffer.from(readme, "utf8") },
];
for (const file of licenseFiles) {
  if (existsSync(file)) {
    zipEntries.push({ name: `${portableRoot}/${basename(file)}`, data: readFileSync(file) });
  }
}
for (const file of bundledLicenses) {
  zipEntries.push({ name: `${portableRoot}/LICENSES/${basename(file)}`, data: readFileSync(file) });
}

// ④ 清空并重建输出目录（只清自己管的目录，避免误删 artifacts/ 下的内容包样例）
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const produced = [];
const emit = (name, buffer) => {
  const target = join(outDir, name);
  writeFileSync(target, buffer);
  produced.push(target);
  console.log(`[release] ${name} (${(statSync(target).size / 1024 / 1024).toFixed(1)} MB)`);
};

for (const file of [...msiFiles, ...exeFiles]) {
  emit(basename(file), readFileSync(file));
}
emit(`${product}_${version}_${arch}-portable.zip`, createZip(zipEntries));

// ⑤ 校验和：发布页上跟安装包放一起，下载后能自查完整性
const sums = produced
  .map((file) => {
    const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
    return `${digest}  ${basename(file)}`;
  })
  .join("\n");
const sumsPath = join(outDir, "SHA256SUMS.txt");
writeFileSync(sumsPath, `${sums}\n`, "utf8");
console.log("[release] SHA256SUMS.txt");

console.log(`[release] done → ${outDir}`);
