/**
 * Generate an extension skeleton from templates.
 *
 * The output is a **directly installable** minimal package: valid manifest, relative
 * entry path, and a native-ESM SDK copy under vendor/ so no bundler is required.
 * (Add Vite / esbuild later if you want React / Vue / TS, see references/sdk-reference.md.)
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { log } from "./log.mjs";
import { ensureDir, isDir, packageRoot, writeText } from "./util.mjs";
import { WIDGET_SCHEMA_VERSION } from "./validate.mjs";

const WIDGET_ID = /^[a-z][a-z0-9-]{1,31}$/;
const SCENE_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;

function assertEmptyTarget(target, force) {
  if (!existsSync(target)) return;
  if (!isDir(target)) throw new Error(`${target} already exists and is not a directory`);
  const entries = readdirSync(target);
  if (entries.length > 0 && !force) {
    throw new Error(`${target} is not empty (pass --force to overwrite, or scaffold into an empty directory)`);
  }
}

/** Scene directory name: take the last segment of the id and normalise to [a-z0-9-]. */
export function sceneSlug(id) {
  const last = id.split(/[._-]/).filter(Boolean).pop() ?? "scene";
  const slug = last.toLowerCase().replace(/[^a-z0-9-]/g, "");
  return slug || "scene";
}

function render(text, tokens) {
  return text.replace(/__([A-Z_]+)__/g, (match, key) =>
    Object.hasOwn(tokens, key) ? String(tokens[key]) : match,
  );
}

function writeFromTemplate(templateDir, relativeTarget, targetDir, tokens) {
  const from = join(templateDir, relativeTarget);
  const to = join(targetDir, render(relativeTarget, tokens));
  writeText(to, render(readFileSync(from, "utf8"), tokens));
  return to;
}

/** Every file under the template directory (absolute paths). */
function templateFiles(templateDir, base = templateDir, out = []) {
  for (const entry of readdirSync(templateDir, { withFileTypes: true })) {
    const absolute = join(templateDir, entry.name);
    if (entry.isDirectory()) templateFiles(absolute, base, out);
    else out.push(absolute);
  }
  return out;
}

/**
 * Create a tool extension.
 * @param {{target: string, id?: string, name?: string, description?: string,
 *          chrome?: "host"|"custom", audio?: boolean, force?: boolean}} options
 */
export function createWidget(options) {
  const target = resolve(options.target);
  const id = options.id ?? basename(target).toLowerCase();
  if (!WIDGET_ID.test(id)) {
    throw new Error(`id "${id}" is invalid: expected ^[a-z][a-z0-9-]{1,31}$ (lowercase letter first, 2-32 chars)`);
  }
  const name = options.name ?? "New tool";
  const chrome = options.chrome ?? "custom";
  if (chrome !== "host" && chrome !== "custom") {
    throw new Error('--chrome must be "host" or "custom"');
  }
  assertEmptyTarget(target, options.force);

  const capabilities = ["widget.ui", "widget.theme", "widget.state"];
  if (chrome === "custom") capabilities.push("widget.chrome");
  if (options.audio) capabilities.push("widget.audio");

  const manifest = {
    schemaVersion: WIDGET_SCHEMA_VERSION,
    type: "widget",
    id,
    name,
    version: "0.1.0",
    description: options.description ?? `${name} (Lull tool extension)`,
    author: "you",
    license: "MIT",
    builtin: false,
    hostApi: 1,
    entry: "index.html",
    lifecycle: "background",
    capabilities,
    window: {
      width: 420,
      height: 560,
      minWidth: 380,
      minHeight: 480,
      resizable: false,
      transparent: true,
      chrome,
    },
    network: [],
  };

  const tokens = { NAME: name, ID: id, DIR: basename(target), VERSION: "0.1.0" };
  const templateDir = join(packageRoot, "templates", "widget");
  ensureDir(target);
  const written = [];
  for (const file of templateFiles(templateDir)) {
    const relative = file.slice(templateDir.length + 1).split("\\").join("/");
    written.push(writeFromTemplate(templateDir, relative, target, tokens));
  }
  const manifestPath = join(target, "widget.json");
  writeText(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  written.push(manifestPath);

  log.ok(`Created tool extension ${id} -> ${target}`);
  if (basename(target) !== id) {
    log.warn(
      `Directory name "${basename(target)}" does not match id "${id}": when installed under widgets\\ the directory name must equal the id`,
    );
    log.next(`Consider renaming to ${id}: mv "${target}" "${join(resolve(target, ".."), id)}"`);
  }
  for (const file of written) log.item(file.slice(target.length + 1));
  return { kind: "widget", id, target, manifestPath, files: written, chrome };
}

/**
 * Create a wallpaper scene (content package).
 * @param {{target: string, id?: string, name?: string, description?: string,
 *          mode?: "script"|"static", params?: boolean, force?: boolean}} options
 */
export function createScene(options) {
  const target = resolve(options.target);
  const id = options.id ?? `community.${basename(target).toLowerCase()}`;
  if (!SCENE_ID.test(id)) {
    throw new Error(`id "${id}" is invalid: expected ^[a-z0-9][a-z0-9._-]{2,63}$ (author.scene recommended)`);
  }
  const mode = options.mode ?? "script";
  if (mode !== "script" && mode !== "static") {
    throw new Error('--mode must be "script" or "static"');
  }
  assertEmptyTarget(target, options.force);

  const slug = sceneSlug(id);
  const name = options.name ?? "New scene";
  const background = "#0a1416";
  const accent = "#9fc7c2";
  const entry = `scenes/${slug}/index.html`;

  const capabilities =
    mode === "script"
      ? ["wallpaper.viewport", "wallpaper.canvas", "wallpaper.params", "wallpaper.sync", "wallpaper.script"]
      : ["wallpaper.viewport", "wallpaper.canvas"];

  const scene = {
    schemaVersion: 1,
    type: "scene",
    id,
    name,
    version: "0.1.0",
    description: options.description ?? `${name} (Lull wallpaper scene)`,
    author: "you",
    license: "CC-BY-4.0",
    capabilities,
    entry,
    theme: { background, accent },
    performance: { tier: "medium", targetFps: 60 },
    compatibility: { hostApi: 1, platforms: ["windows"] },
  };
  if (mode === "script" && options.params !== false) {
    scene.params = [
      {
        key: "glow",
        type: "number",
        label: "Glow strength",
        description: "0 is off, 1 is brightest.",
        default: 0.45,
        min: 0,
        max: 1,
        step: 0.05,
      },
      { key: "tint", type: "color", label: "Tint", default: accent },
      {
        key: "speed",
        type: "number",
        label: "Breathing period (s)",
        default: 12,
        min: 4,
        max: 40,
        step: 1,
      },
    ];
  }

  const catalog = { schemaVersion: 1, scenes: [scene] };
  const tokens = {
    NAME: name,
    SCENE_ID: id,
    SLUG: slug,
    DIR: basename(target),
    BG: background,
    ACCENT: accent,
    VERSION: "0.1.0",
    MODE_NOTE:
      mode === "script"
        ? "Script scene: declares wallpaper.script / wallpaper.params / wallpaper.sync, so parameter changes are pushed live to the wallpaper."
        : 'Static package: no wallpaper.script, the iframe runs with sandbox="", so **do not** add <script> (the validator rejects it).',
  };

  const templateDir = join(packageRoot, "templates", mode === "script" ? "scene" : "scene-static");
  const entryDir = join(target, ...entry.split("/").slice(0, -1));
  ensureDir(entryDir);
  const written = [];
  for (const file of templateFiles(templateDir)) {
    const relative = file.slice(templateDir.length + 1).split("\\").join("/");
    if (relative === "README.md") continue;
    written.push(writeFromTemplate(templateDir, relative, entryDir, tokens));
  }
  // README lives at the package root (the layer holding catalog.json) and stays out of the digest.
  const readmeSource = join(templateDir, "README.md");
  if (existsSync(readmeSource)) {
    written.push(
      writeFromTemplate(templateDir, "README.md", target, tokens),
    );
  }
  const catalogPath = join(target, "catalog.json");
  writeText(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  written.push(catalogPath);

  log.ok(`Created ${mode === "script" ? "script" : "static"} scene ${id} -> ${target}`);
  log.item(`entry: ${entry}`);
  for (const file of written) log.item(file.slice(target.length + 1));
  return { kind: "scene", id, target, catalogPath, entry, slug, mode, files: written };
}

/** Work out the vendor target: widget at the package root, scene next to the entry (so the digest covers it). */
export function vendorDirFor(target, kind, entry) {
  const root = resolve(target);
  if (kind === "widget") return join(root, "vendor");
  if (!entry) throw new Error("Script scenes need an entry to locate the vendor directory");
  const segments = entry.split("/");
  return join(root, ...segments.slice(0, -1), "vendor");
}
