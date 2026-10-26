/**
 * Pack into an installable zip.
 *
 * widget -> `<id>-<version>.lull-widget.zip`, zip root holds widget.json plus assets;
 * scene  -> `<id>-<version>.zip`, contents = catalog.json + the entry directory
 *           (paths relative to the package root).
 *
 * Never use Compress-Archive: it writes backslash entry names and the installer
 * rejects the whole package on its safety checks.
 */
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { writeContentIntegrity } from "./digest.mjs";
import { log } from "./log.mjs";
import { ensureDir, formatBytes, isFile, readJson, toPosix, walkFiles } from "./util.mjs";
import { detectKind, formatReport, validatePackage } from "./validate.mjs";
import { writeZip } from "./zip.mjs";

/** Package files: skip dependencies and dotfiles (including .lull-integrity.json and .DS_Store). */
function packageEntries(root) {
  return walkFiles(root).filter((rel) => {
    const parts = rel.split("/");
    if (parts.some((part) => part === "node_modules" || part === ".git")) return false;
    return !parts[parts.length - 1].startsWith(".");
  });
}

/**
 * @param {{target: string, out?: string, force?: boolean, skipValidate?: boolean}} options
 */
export function packExtension(options) {
  const root = resolve(options.target);
  const out = resolve(options.out ?? join(root, "artifacts"));
  const kind = detectKind(root);
  if (!kind) {
    throw new Error(`${root} has neither widget.json nor catalog.json, so it is not an extension package`);
  }

  // Content package integrity is derived data: recompute before packing so the output always installs.
  if (kind === "scene" && options.hash !== false) {
    const hashed = writeContentIntegrity(root);
    const changed = hashed.previous && hashed.previous !== hashed.digest;
    log.info(
      `${changed ? "Updated" : "Confirmed"} the integrity in catalog.json: ${hashed.digest.slice(0, 12)}...`,
    );
  }

  let report = null;
  if (!options.skipValidate) {
    report = validatePackage(root, {});
    log.raw(formatReport(report));
    if (!report.ok) {
      throw new Error(
        `Validation failed (${report.errors.length} error(s)): fix them before packing, or pass --skip-validate`,
      );
    }
    if (report.warnings.length > 0) {
      log.warn(`${report.warnings.length} warning(s): the package installs, but fix them if you can`);
    }
  }

  const id = report?.id;
  const version = report?.version;
  if (!id || !version) {
    throw new Error("Cannot read id / version from the manifest, so the output cannot be named");
  }

  let entries;
  let filename;
  if (kind === "widget") {
    entries = packageEntries(root).map((rel) => ({ name: rel, data: readFileSync(join(root, rel)) }));
    if (!entries.some((entry) => entry.name === "widget.json")) {
      throw new Error("The zip root must contain widget.json");
    }
    filename = `${id}-${version}.lull-widget.zip`;
  } else {
    const catalog = readJson(join(root, "catalog.json"));
    const entry = catalog.scenes?.[0]?.entry;
    if (typeof entry !== "string") throw new Error("catalog.json is missing scenes[0].entry");
    const entryDir = toPosix(dirname(entry));
    entries = [{ name: "catalog.json", data: readFileSync(join(root, "catalog.json")) }];
    for (const rel of packageEntries(root)) {
      if (rel === "catalog.json") continue;
      if (!rel.startsWith(`${entryDir}/`)) continue;
      entries.push({ name: rel, data: readFileSync(join(root, rel)) });
    }
    filename = `${id}-${version}.zip`;
  }

  ensureDir(out);
  const zipPath = join(out, filename);
  const bytes = writeZip(zipPath, entries);
  log.ok(`Packed ${basename(zipPath)} (${entries.length} entries / ${formatBytes(bytes)})`);
  log.item(zipPath);
  log.next("Lull -> Settings -> Extensions -> Install from file, then pick this zip");
  return { kind, id, version, zipPath, bytes, entries: entries.length };
}
