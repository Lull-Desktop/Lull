#!/usr/bin/env node
/**
 * Tauri 打包前置脚本：校验内容目录、构建原生 host、清理旧产物、导出静态前端，
 * 并强制重新嵌入最新资源。
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync, rmSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (msg) => {
  console.error(`[prebuild] ${msg}`);
  process.exit(1);
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: root,
    ...options,
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} 失败`);
  }
}

// ① 内容目录校验（场景包清单 / entry 存在性 / id 唯一）
run(process.execPath, [join(root, "scripts", "validate-content.mjs")]);

// ② 定位 git-bash（git --exec-path → <Git>/mingw64/libexec/git-core → <Git>/bin/bash.exe）
function findGitBash() {
  try {
    const execPath = execSync("git --exec-path", { encoding: "utf8" })
      .trim()
      .replace(/\\/g, "/");
    const gitRoot = execPath.replace(/\/mingw64\/libexec\/git-core\/?$/, "");
    const cand = join(gitRoot, "bin", "bash.exe");
    if (existsSync(cand)) {
      return cand;
    }
  } catch {
    // 忽略，走兜底
  }
  for (const c of [
    "C:/Program Files/Git/bin/bash.exe",
    "C:/Program Files (x86)/Git/bin/bash.exe",
  ]) {
    if (existsSync(c)) {
      return c;
    }
  }
  return null;
}

const bash = findGitBash();
if (!bash) {
  fail("找不到 Git Bash——编译 lull_native.dll 需要它（git 是否在 PATH 里？）");
}
console.log(`[prebuild] git-bash: ${bash}`);
run(bash, [join(root, "src-tauri", "native", "build-shim.sh")]);

// ③ 清洁导出目录
for (const d of ["dist", ".next"]) {
  rmSync(join(root, d), { recursive: true, force: true });
  console.log(`[prebuild] cleaned ${d}`);
}

// ④ Next 静态导出（直接调用 Next CLI，避免 shell 转义与 pnpm 生命周期脚本）
run(process.execPath, [
  join(root, "node_modules", "next", "dist", "bin", "next"),
  "build",
]);

// ⑤ 强制重嵌入
const lib = join(root, "src-tauri", "src", "lib.rs");
const now = new Date();
utimesSync(lib, now, now);
console.log("[prebuild] touched src-tauri/src/lib.rs（强制重嵌入前端）");
console.log("[prebuild] done");
