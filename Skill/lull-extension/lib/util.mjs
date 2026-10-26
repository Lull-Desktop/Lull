/**
 * Shared file / digest / path helpers.
 *
 * Conventions:
 * - Every "package-relative path" uses forward slashes (zip entries, manifest entry, digests).
 * - Symlinks are a hard error: the digest must cover exactly the bytes the runtime reads.
 */
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Skill package root (the parent of bin/ and lib/). Under npx this is the unpacked directory. */
export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Cache root: SDK clones and build artefacts live here; override with LULL_SKILL_CACHE. */
export function cacheRoot() {
  return resolve(process.env.LULL_SKILL_CACHE ?? join(homedir(), ".lull-skill"));
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readText(path) {
  return readFileSync(path, "utf8");
}

export function writeText(path, text) {
  ensureDir(dirname(path));
  writeFileSync(path, text, "utf8");
}

export function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Recursively list files as forward-slash paths relative to `base`, sorted by UTF-8 bytes. Symlinks throw. */
export function walkFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (isSymlink(absolute)) {
      throw new Error(`Symlinks are not allowed inside a package: ${absolute}`);
    }
    if (entry.isDirectory()) {
      walkFiles(absolute, base, out);
    } else if (entry.isFile()) {
      out.push(toPosix(absolute.slice(base.length + 1)));
    }
  }
  return out.sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
}

export function toPosix(path) {
  return path.split(sep).join("/");
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

/** Only delete inside the cache / temp directories: never wipe a user directory by accident. */
export function removeInside(dir, allowedRoot) {
  const target = resolve(dir);
  const root = resolve(allowedRoot);
  if (!target.startsWith(root + sep) && target !== root) {
    throw new Error(`Refusing to delete ${target}: not inside the cache directory ${root}`);
  }
  rmSync(target, { recursive: true, force: true });
}

export function copyFile(from, to) {
  ensureDir(dirname(to));
  writeFileSync(to, readFileSync(from));
}

/** Copy a directory or a single file; node_modules / .git are skipped. */
export function copyPath(from, to) {
  if (isFile(from)) {
    copyFile(from, to);
    return;
  }
  copyDir(from, to);
}

export function copyDir(from, to) {
  ensureDir(dirname(to));
  cpSync(from, to, {
    recursive: true,
    force: true,
    filter(source) {
      const name = source.slice(source.lastIndexOf(sep) + 1);
      return name !== "node_modules" && name !== ".git";
    },
  });
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function dirSize(dir) {
  let total = 0;
  for (const rel of walkFiles(dir)) {
    total += statSync(join(dir, rel)).size;
  }
  return total;
}

export function exists(path) {
  return existsSync(path);
}
