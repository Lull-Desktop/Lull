/**
 * 确保 `packages/widget-sdk/dist` 与 `packages/media-sdk/dist` 存在。
 *
 * SDK dist 不入库；官方扩展构建 / dev server 启动前按需编译，避免依赖 pnpm
 * 生命周期钩子，也避免 CI 里必须先记得跑 `pnpm widgets:sdk`。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(path));
    else if (entry.isFile()) newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

export function ensureSdkDist(repoRoot) {
  const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  for (const pkg of ["widget-sdk", "media-sdk"]) {
    const sourceDir = join(repoRoot, "packages", pkg, "src");
    const distEntry = join(repoRoot, "packages", pkg, "dist", "index.js");
    const stale =
      !existsSync(distEntry) ||
      newestMtime(sourceDir) > statSync(distEntry).mtimeMs;
    if (!stale) {
      continue;
    }
    const result = spawnSync(
      process.execPath,
      [tsc, "-p", join("packages", pkg, "tsconfig.json")],
      { encoding: "utf8", cwd: repoRoot },
    );
    if (result.status !== 0) {
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
      throw new Error(`编译 @lull/${pkg} 失败：\n${output}`);
    }
  }
}
