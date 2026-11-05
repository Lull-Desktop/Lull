#!/usr/bin/env node
/**
 * 把构建后的游戏示例目录打成可发布的 `.lull-game.zip`：
 * - zip 根目录直接放 `game.json` / entry / 资源；
 * - 写入 Node 侧计算的 `.lull-integrity.json`（与 Rust `game_package::digest` 同算法）；
 * - 输出 release manifest（id/version/file/sha256/包摘要/体积），方便发布页或安装器索引。
 *
 * 用法：
 *   node scripts/pack-game.mjs
 *   node scripts/pack-game.mjs examples/games/living-world/dist
 *   node scripts/pack-game.mjs --out examples/games/release
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectGameFiles, GamePackageError, validateGamePackage } from "./lib/game-package.mjs";
import { collectFiles, computeDigest } from "./lib/widget-digest.mjs";
import { writeZip } from "./zip-writer.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GAME_SCHEME = "lull-game-package\0";
const GAME_INTEGRITY_FILE = ".lull-integrity.json";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir =
  outIndex >= 0
    ? resolve(args[outIndex + 1])
    : join(root, "examples", "games", "release");
const explicit = args.filter(
  (arg, index) =>
    !arg.startsWith("--") && (outIndex < 0 || index !== outIndex + 1),
);

function discoverDists() {
  if (explicit.length > 0) return explicit.map((dir) => resolve(dir));
  return readdirSync(join(root, "examples", "games"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, "examples", "games", entry.name, "dist"))
    .filter((dir) => existsSync(join(dir, "game.json")))
    .sort();
}

if (discoverDists().length === 0) {
  console.error("[games:pack] 没有可打包的 dist；先执行 pnpm games:samples:build");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const release = [];
for (const distDir of discoverDists()) {
  try {
    const { manifest } = validateGamePackage(distDir);
    const files = collectFiles(distDir, "", false);
    const gameDigest = computeDigest(
      files,
      GAME_SCHEME,
      manifest.id,
      manifest.version,
    );
    const lock = Buffer.from(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          algorithm: "sha256",
          scope: "package",
          digest: gameDigest,
          source: "declared",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const entries = [...files, { name: GAME_INTEGRITY_FILE, data: lock }];
    const base = `${manifest.id}-${manifest.version}`;
    const zipPath = join(outDir, `${base}.lull-game.zip`);
    rmSync(zipPath, { force: true });
    const size = writeZip(zipPath, entries);
    const sha256 = createHash("sha256")
      .update(readFileSync(zipPath))
      .digest("hex");
    const budget = collectGameFiles(distDir).reduce(
      (sum, file) => sum + file.size,
      0,
    );
    release.push({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description ?? "",
      file: `${base}.lull-game.zip`,
      sha256,
      gameDigest,
      files: entries.length,
      bytes: size,
      unpackedBytes: budget,
    });
    console.log(
      `[games:pack] ${manifest.id} ${manifest.version} → ${zipPath} ` +
        `(${entries.length} files, ${(size / 1024).toFixed(1)} KiB, ${gameDigest.slice(0, 12)}…)`,
    );
  } catch (error) {
    if (error instanceof GamePackageError) {
      console.error(`[games:pack] ${distDir} 校验失败：${error.message}`);
    } else {
      console.error(`[games:pack] ${distDir} 打包失败：${error?.stack ?? error}`);
    }
    process.exitCode = 1;
  }
}

release.sort((left, right) => left.id.localeCompare(right.id));
const manifestPath = join(outDir, "manifest.json");
writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      games: release,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
console.log(`[games:pack] release manifest → ${manifestPath}`);
