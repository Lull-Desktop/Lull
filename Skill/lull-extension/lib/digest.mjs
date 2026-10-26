/**
 * Content package digest (same algorithm as the repo `scripts/content-digest.mjs`
 * and the Rust `content_package::digest`).
 *
 *   sha256(
 *     "lull-content-package\0" +
 *     id + "\0" + version + "\0" +
 *     Σ(relPath + "\0" + size + "\0" + bytes + "\0")   // relPath sorted by UTF-8 bytes
 *   )
 *
 * The digest covers the **entry directory** and excludes catalog.json: writing the
 * integrity back would otherwise change the bytes being hashed, so it could never settle.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { walkFiles } from "./util.mjs";

const SCHEME = "lull-content-package\0";

export function contentPackageDigest({ id, version, dir }) {
  if (!id || !version) {
    throw new Error("Computing the content package digest needs id and version");
  }
  const files = walkFiles(dir);
  if (files.length === 0) {
    throw new Error(`Content package directory is empty: ${dir}`);
  }
  const hash = createHash("sha256");
  hash.update(SCHEME, "utf8");
  for (const part of [id, version]) {
    hash.update(part, "utf8");
    hash.update("\0");
  }
  for (const relPath of files) {
    const bytes = readFileSync(join(dir, relPath));
    hash.update(relPath, "utf8");
    hash.update("\0");
    hash.update(String(bytes.length), "utf8");
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Derive the content package directory from the entry: `scenes/mist/index.html` -> `<root>/scenes/mist`. */
export function packageDirFor(entry, contentRoot) {
  const segments = typeof entry === "string" ? entry.split("/") : [];
  if (segments.length < 2) {
    throw new Error("entry must live in its own directory under the content root (e.g. scenes/mist/index.html)");
  }
  return join(contentRoot, ...segments.slice(0, -1));
}

/**
 * Recompute and write back `scenes[0].integrity` in catalog.json.
 *
 * integrity is derived data (the digest covers the entry directory, not catalog.json),
 * so recomputing before packaging is both safe and required: ship a stale digest and the
 * installer rejects the package.
 */
export function writeContentIntegrity(bundle) {
  const catalogPath = join(bundle, "catalog.json");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const scene = Array.isArray(catalog.scenes) ? catalog.scenes[0] : null;
  if (!scene) throw new Error(`${catalogPath} is missing scenes[0]`);
  if (typeof scene.entry !== "string") throw new Error("scenes[0].entry is missing, cannot locate the directory to digest");

  const dir = packageDirFor(scene.entry, bundle);
  const digest = contentPackageDigest({ id: scene.id, version: scene.version, dir });
  const previous = scene.integrity?.digest ?? null;
  scene.integrity = { algorithm: "sha256", scope: "package", digest };
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  return { catalogPath, dir, id: scene.id, version: scene.version, digest, previous };
}
