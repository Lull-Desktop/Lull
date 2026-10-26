/**
 * Extension standard validator: collapses the hard rules from docs/widget-sdk.md,
 * docs/scene-sdk.md and the host Rust side into one offline-checkable pass.
 *
 * Three levels:
 *   error  the host will reject the package, or it simply cannot run
 *   warn   it installs and runs, but breaks the standard (size / assets / sandbox)
 *   info   style and maintainability hints
 *
 * Rule sources (verify them before changing anything here):
 *   src-tauri/src/widget_package/manifest.rs      -> widget manifest hard rules
 *   src-tauri/src/content_package/manifest.rs     -> content package hard rules
 *   src/sdk/scene/manifest.ts                     -> scene field-level schema
 *   docs/widget-sdk.md / docs/scene-sdk.md        -> artifact and sandbox contracts
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { contentPackageDigest, packageDirFor } from "./digest.mjs";
import { isFile, readJson, toPosix, walkFiles } from "./util.mjs";

/** Widget manifest schemaVersion (host WIDGET_SCHEMA_VERSION). */
export const WIDGET_SCHEMA_VERSION = 2;
/** The host only accepts hostApi 1. */
export const WIDGET_HOST_API = 1;
export const SCENE_SCHEMA_VERSION = 1;
export const SCENE_HOST_API = 1;

export const WIDGET_CAPABILITIES = [
  "widget.ui",
  "widget.theme",
  "widget.state",
  "widget.audio",
  "widget.media",
  "widget.network",
  "widget.chrome",
];
/** Cannot be requested by plugins (host-only). */
export const WIDGET_FORBIDDEN_CAPABILITIES = ["widget.window", "widget.native"];

export const SCENE_CAPABILITIES = [
  "wallpaper.viewport",
  "wallpaper.canvas",
  "wallpaper.sync",
  "wallpaper.params",
  "wallpaper.script",
];
export const SCENE_PLATFORMS = ["windows", "macos", "linux"];
export const SCENE_PARAM_TYPES = ["number", "boolean", "string", "color", "enum"];

const WIDGET_ID = /^[a-z][a-z0-9-]{1,31}$/;
const SCENE_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const RUST_VERSION = /^\d+\.\d+\.\d+$/;
const COLOR = /^#[0-9A-Fa-f]{6}$/;
const PARAM_KEY = /^[a-z][a-z0-9._-]{0,31}$/;
const DIGEST = /^[0-9a-f]{64}$/;

const WIDGET_KNOWN_KEYS = new Set([
  "schemaVersion",
  "type",
  "id",
  "name",
  "version",
  "description",
  "author",
  "license",
  "builtin",
  "hostApi",
  "entry",
  "icon",
  "lifecycle",
  "capabilities",
  "window",
  "network",
]);

const SCENE_KNOWN_KEYS = new Set([
  "schemaVersion",
  "type",
  "id",
  "name",
  "version",
  "description",
  "author",
  "license",
  "capabilities",
  "entry",
  "theme",
  "params",
  "performance",
  "compatibility",
  "integrity",
]);

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist-cache"]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Files inside the package that get scanned and counted towards size (deps and dotfiles excluded). */
function packageFiles(root) {
  const all = walkFiles(root);
  return all.filter((rel) => {
    const parts = rel.split("/");
    if (parts.some((part) => SKIP_DIRS.has(part))) return false;
    const name = parts[parts.length - 1];
    if (name.startsWith(".")) return false;
    return true;
  });
}

export function detectKind(root) {
  if (isFile(join(root, "widget.json"))) return "widget";
  if (isFile(join(root, "catalog.json"))) return "scene";
  return null;
}

/** Create a report collector. */
function createReport(kind, root) {
  const report = {
    ok: false,
    kind,
    root,
    id: null,
    name: null,
    version: null,
    entry: null,
    errors: [],
    warnings: [],
    infos: [],
    stats: { files: 0, bytes: 0 },
  };
  const add = (level, code, message, hint) => {
    const bucket =
      level === "error" ? report.errors : level === "warn" ? report.warnings : report.infos;
    bucket.push({ code, message, ...(hint ? { hint } : {}) });
  };
  return { report, add };
}

function finish(report, strict) {
  if (strict) {
    for (const warning of report.warnings) {
      report.errors.push({ ...warning, code: `${warning.code} (strict)` });
    }
    report.warnings = [];
  }
  report.ok = report.errors.length === 0;
  return report;
}

/** Single entry point: detect widget / scene and validate. */
export function validatePackage(target, options = {}) {
  const root = resolve(target);
  if (!existsSync(root)) {
    throw new Error(`Directory does not exist: ${root}`);
  }
  const kind = options.kind ?? detectKind(root);
  if (!kind) {
    throw new Error(
      `${root} has neither widget.json nor catalog.json; cannot detect the extension kind (pass --kind)`,
    );
  }
  const { report, add } = createReport(kind, root);

  const stat = statSync(root);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${root}`);

  const files = packageFiles(root);
  report.stats = {
    files: files.length,
    bytes: files.reduce((sum, rel) => sum + statSync(join(root, rel)).size, 0),
  };

  if (kind === "widget") {
    validateWidget(root, report, add, files);
  } else {
    validateScene(root, report, add, files);
  }
  scanAssets(root, report, add, files, kind);
  return finish(report, options.strict === true);
}

/* ------------------------------------------------------------------ widget */

function validateWidget(root, report, add, files) {
  let manifest;
  try {
    manifest = readJson(join(root, "widget.json"));
  } catch (error) {
    add("error", "W-MANIFEST-JSON", `widget.json is not valid JSON: ${error.message}`);
    return;
  }
  if (!isRecord(manifest)) {
    add("error", "W-MANIFEST-SHAPE", "widget.json must be a JSON object");
    return;
  }

  for (const key of Object.keys(manifest)) {
    if (!WIDGET_KNOWN_KEYS.has(key)) {
      add("info", "W-UNKNOWN-FIELD", `widget.json has an unknown field "${key}" (the host ignores it)`);
    }
  }

  if (manifest.schemaVersion !== WIDGET_SCHEMA_VERSION) {
    add(
      "error",
      "W-SCHEMA",
      `schemaVersion must be ${WIDGET_SCHEMA_VERSION}, got ${JSON.stringify(manifest.schemaVersion)}`,
    );
  }
  if (manifest.type !== "widget") {
    add("error", "W-TYPE", 'type must be "widget"');
  }

  const id = typeof manifest.id === "string" ? manifest.id.trim() : "";
  if (!WIDGET_ID.test(id)) {
    add(
      "error",
      "W-ID",
      `id "${id}" is invalid: expected ^[a-z][a-z0-9-]{1,31}$ (lowercase letter first, 2-32 chars)`,
    );
  } else {
    report.id = id;
    if (basename(root) !== id) {
      add(
        "warn",
        "W-ID-DIR",
        `Directory name "${basename(root)}" does not match id "${id}"`,
        "When installed under %APPDATA%\\app.lull.desktop\\widgets\\<id> the directory name must equal the id; packaging is unaffected",
      );
    }
  }

  const name = typeof manifest.name === "string" ? manifest.name.trim() : "";
  if (name.length < 1 || [...name].length > 64) {
    add("error", "W-NAME", "name must be 1-64 characters");
  } else {
    report.name = name;
  }

  const version = typeof manifest.version === "string" ? manifest.version.trim() : "";
  if (!VERSION.test(version)) {
    add("error", "W-VERSION", `version "${version}" is not semver (MAJOR.MINOR.PATCH)`);
  } else {
    report.version = version;
    if (!RUST_VERSION.test(version)) {
      add(
        "warn",
        "W-VERSION-PRE",
        `version "${version}" carries a prerelease suffix; the Rust side only accepts MAJOR.MINOR.PATCH`,
        "Do not ship -alpha / -beta in extension package versions",
      );
    }
  }

  if (typeof manifest.license !== "string" || manifest.license.trim() === "") {
    add("warn", "W-LICENSE", "Third-party packages should declare license (SPDX id)", "e.g. MIT / Apache-2.0");
  }
  if (manifest.builtin === true) {
    add("error", "W-BUILTIN", "builtin=true is not accepted in the user directory");
  }

  const hostApi = manifest.hostApi;
  if (!Number.isInteger(hostApi) || hostApi < 1 || hostApi > WIDGET_HOST_API) {
    add(
      "error",
      "W-HOSTAPI",
      `hostApi must be an integer in 1-${WIDGET_HOST_API}, got ${JSON.stringify(hostApi)}`,
    );
  }

  // entry
  const entry = manifest.entry;
  if (typeof entry !== "string" || !safeWidgetEntry(entry)) {
    add(
      "error",
      "W-ENTRY-SAFE",
      `entry "${entry}" must be a package-relative .html path (no .., backslash, % or absolute path)`,
    );
  } else {
    report.entry = entry;
    if (!isFile(join(root, entry))) {
      add("error", "W-ENTRY-MISSING", `entry points to a missing file: ${entry}`);
    }
  }

  // capabilities
  const caps = manifest.capabilities;
  if (!Array.isArray(caps) || caps.length === 0) {
    add("error", "W-CAPS-EMPTY", "capabilities must be a non-empty array (widget.ui at minimum)");
  } else {
    const seen = new Set();
    for (const [index, cap] of caps.entries()) {
      if (typeof cap !== "string") {
        add("error", "W-CAPS-TYPE", `capabilities[${index}] must be a string`);
        continue;
      }
      if (WIDGET_FORBIDDEN_CAPABILITIES.includes(cap)) {
        add("error", "W-CAPS-FORBIDDEN", `Plugins cannot request ${cap} (host-only)`);
        continue;
      }
      if (!WIDGET_CAPABILITIES.includes(cap)) {
        add("error", "W-CAPS-UNKNOWN", `Unknown capability ${cap}`);
        continue;
      }
      if (seen.has(cap)) add("error", "W-CAPS-DUP", `Duplicate capability: ${cap}`);
      seen.add(cap);
    }

    const network = manifest.network;
    const hasNetworkCap = caps.includes("widget.network");
    const hasNetworkList = Array.isArray(network) && network.length > 0;
    if (hasNetworkCap !== hasNetworkList) {
      add(
        "error",
        "W-NET-CAP",
        "The widget.network capability and the network allowlist must appear together (drop both, or keep both)",
      );
    }
    if (Array.isArray(network)) {
      for (const source of network) {
        if (
          typeof source !== "string" ||
          !(source.startsWith("https://") || source.startsWith("http://localhost:")) ||
          source.length > 256 ||
          /[\s;'"\n\r\t]/.test(source)
        ) {
          add(
            "error",
            "W-NET-SOURCE",
            `network only allows https:// or http://localhost: origins, got ${JSON.stringify(source)}`,
          );
        }
      }
    }
    if (caps.includes("widget.audio")) {
      add("info", "W-AUDIO", "widget.audio requested: must run silently when not granted, do not call new AudioContext directly");
    }
  }

  // window
  const win = manifest.window;
  if (!isRecord(win)) {
    add("error", "W-WINDOW", "window must be an object");
  } else {
    const { width, height, minWidth, minHeight, resizable, chrome } = win;
    const sizeOk =
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width >= 320 &&
      width <= 1600 &&
      height >= 240 &&
      height <= 1200;
    if (!sizeOk) {
      add(
        "error",
        "W-WINDOW-SIZE",
        `Window size must be within 320x240 - 1600x1200, got ${JSON.stringify(width)}x${JSON.stringify(height)}`,
      );
    }
    if (resizable === true) {
      add("error", "W-WINDOW-RESIZABLE", "v1 plugin windows have a fixed size; resizable=true is not allowed");
    }
    if (
      (Number.isFinite(minWidth) && Number.isFinite(width) && minWidth > width) ||
      (Number.isFinite(minHeight) && Number.isFinite(height) && minHeight > height)
    ) {
      add("error", "W-WINDOW-MIN", "Minimum size must not exceed the initial size");
    }
    if (chrome !== undefined && chrome !== "host" && chrome !== "custom") {
      add("error", "W-WINDOW-CHROME", 'window.chrome must be "host" or "custom"');
    }
    if (chrome === "custom" && !(Array.isArray(caps) && caps.includes("widget.chrome"))) {
      add("error", "W-CHROME-CAP", 'window.chrome="custom" requires the widget.chrome capability');
    }
    if (chrome === "custom") {
      add(
        "info",
        "W-CHROME-SELF",
        "Custom chrome: you must provide the drag region (pointerdown -> startDrag), minimize and close buttons",
      );
    }
  }

  if (manifest.lifecycle !== undefined && !["background", "suspend"].includes(manifest.lifecycle)) {
    add("error", "W-LIFECYCLE", 'lifecycle must be "background" or "suspend"');
  }

  if (manifest.icon !== undefined) {
    if (typeof manifest.icon !== "string" || !safeIcon(manifest.icon)) {
      add("error", "W-ICON", "icon must be a package-relative .png/.jpg/.jpeg/.webp path");
    } else if (!isFile(join(root, manifest.icon))) {
      add("error", "W-ICON-MISSING", `icon file does not exist: ${manifest.icon}`);
    }
  }

  // Size: keep a single package under 5 MB
  if (report.stats.bytes > 5 * 1024 * 1024) {
    add(
      "warn",
      "W-SIZE",
      `Package is ${(report.stats.bytes / 1024 / 1024).toFixed(2)} MB; keep it under 5 MB`,
      "Compress large assets to WebP / drop sourcemaps",
    );
  }
  if (files.some((rel) => rel.endsWith(".map"))) {
    add("info", "W-SOURCEMAP", "Package contains .map files; install packages usually do not need them");
  }
}

function safeWidgetEntry(entry) {
  if (!entry || entry.length > 128 || !entry.endsWith(".html")) return false;
  if (entry.startsWith("/") || entry.includes("\\") || entry.includes("%")) return false;
  return entry
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function safeIcon(icon) {
  if (!icon || icon.length > 128) return false;
  const lower = icon.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf(".") + 1);
  if (!["png", "jpg", "jpeg", "webp"].includes(ext)) return false;
  if (icon.startsWith("/") || icon.includes("\\") || icon.includes("%")) return false;
  return icon
    .split("/")
    .every(
      (segment) => segment !== "" && segment !== "." && segment !== ".." && !segment.startsWith("."),
    );
}

/* ------------------------------------------------------------------- scene */

function validateScene(root, report, add, files) {
  let catalog;
  try {
    catalog = readJson(join(root, "catalog.json"));
  } catch (error) {
    add("error", "S-CATALOG-JSON", `catalog.json is not valid JSON: ${error.message}`);
    return;
  }
  if (!isRecord(catalog)) {
    add("error", "S-CATALOG-SHAPE", "catalog.json must be a JSON object");
    return;
  }
  if (catalog.schemaVersion !== SCENE_SCHEMA_VERSION) {
    add("error", "S-CATALOG-SCHEMA", "catalog.json schemaVersion must be 1");
  }
  if (!Array.isArray(catalog.scenes)) {
    add("error", "S-CATALOG-SCENES", "catalog.json scenes must be an array");
    return;
  }
  if (catalog.scenes.length !== 1) {
    add(
      "error",
      "S-SINGLE-SCENE",
      `The v1 installer only accepts single-scene packages: scenes must contain exactly one entry, got ${catalog.scenes.length}`,
    );
    return;
  }
  const scene = catalog.scenes[0];
  if (!isRecord(scene)) {
    add("error", "S-SCENE-SHAPE", "scenes[0] must be a JSON object");
    return;
  }

  for (const key of Object.keys(scene)) {
    if (!SCENE_KNOWN_KEYS.has(key)) {
      add("error", "S-UNKNOWN-FIELD", `Unknown field "${key}" (scene manifests reject unknown fields)`);
    }
  }

  if (scene.schemaVersion !== SCENE_SCHEMA_VERSION) {
    add("error", "S-SCHEMA", "scene.schemaVersion must be 1");
  }
  if (scene.type !== "scene") {
    add("error", "S-TYPE", 'scene.type must be "scene"');
  }

  const id = typeof scene.id === "string" ? scene.id.trim() : "";
  if (!SCENE_ID.test(id)) {
    add("error", "S-ID", `id "${id}" is invalid: expected ^[a-z0-9][a-z0-9._-]{2,63}$ (author.scene recommended)`);
  } else {
    report.id = id;
  }

  const name = typeof scene.name === "string" ? scene.name.trim() : "";
  if (name.length === 0) {
    add("error", "S-NAME", "name must be a non-empty string");
  } else if ([...name].length > 80) {
    add("error", "S-NAME-LEN", "name must not exceed 80 characters");
  } else {
    report.name = name;
  }

  const version = typeof scene.version === "string" ? scene.version.trim() : "";
  if (!VERSION.test(version)) {
    add("error", "S-VERSION", `version "${version}" is not semver`);
  } else {
    report.version = version;
  }

  if (typeof scene.license !== "string" || scene.license.trim() === "") {
    add("error", "S-LICENSE", "Content packages must declare license (SPDX id, e.g. CC-BY-4.0)");
  }

  const caps = scene.capabilities;
  let hasScript = false;
  if (!Array.isArray(caps) || caps.length === 0) {
    add("error", "S-CAPS-EMPTY", "capabilities must be a non-empty array");
  } else {
    const seen = new Set();
    for (const cap of caps) {
      if (typeof cap !== "string" || !SCENE_CAPABILITIES.includes(cap)) {
        add("error", "S-CAPS-UNKNOWN", `Unknown capability: ${JSON.stringify(cap)}`);
        continue;
      }
      if (seen.has(cap)) add("error", "S-CAPS-DUP", `Duplicate capability: ${cap}`);
      seen.add(cap);
    }
    hasScript = seen.has("wallpaper.script");
    if (!hasScript && (seen.has("wallpaper.params") || seen.has("wallpaper.sync"))) {
      add(
        "error",
        "S-CAPS-SCRIPT",
        "External packages must also declare wallpaper.script when using wallpaper.params / wallpaper.sync",
      );
    }
    if (!seen.has("wallpaper.viewport") && !seen.has("wallpaper.canvas")) {
      add(
        "warn",
        "S-CAPS-VIEWPORT",
        "Neither wallpaper.viewport nor wallpaper.canvas declared: the scene cannot run in mirror mode",
      );
    }
  }

  // entry
  const entry = scene.entry;
  if (typeof entry !== "string" || entry.trim() === "") {
    add("error", "S-ENTRY", "Content package scenes must declare entry");
  } else if (!safeSceneEntry(entry)) {
    add(
      "error",
      "S-ENTRY-SAFE",
      `entry "${entry}" is unsafe: must be a relative .html path inside a subdirectory, no .. / backslash / %`,
    );
  } else {
    report.entry = entry;
    const target = join(root, entry);
    if (!isFile(target)) {
      add("error", "S-ENTRY-MISSING", `entry points to a missing file: ${entry}`);
    }
  }

  validateSceneParams(scene, caps, add);
  validateSceneTheme(scene.theme, add);
  validateScenePerformance(scene.performance, add);
  validateSceneCompatibility(scene.compatibility, add);

  // integrity: once declared it must match reality (the installer rejects mismatches)
  if (scene.integrity !== undefined && scene.integrity !== null) {
    const integrity = scene.integrity;
    if (!isRecord(integrity)) {
      add("error", "S-INTEGRITY-SHAPE", "integrity must be an object");
    } else {
      if (integrity.algorithm !== "sha256") add("error", "S-INTEGRITY-ALG", "integrity.algorithm only supports sha256");
      if (integrity.scope !== "package") add("error", "S-INTEGRITY-SCOPE", "integrity.scope only supports package");
      const digest = integrity.digest;
      if (typeof digest !== "string" || !DIGEST.test(digest)) {
        add("error", "S-INTEGRITY-DIGEST", "integrity.digest must be 64 lowercase hex characters");
      } else if (report.id && report.version && typeof entry === "string" && isFile(join(root, entry))) {
        try {
          const actual = contentPackageDigest({
            id: report.id,
            version: report.version,
            dir: packageDirFor(entry, root),
          });
          if (actual !== digest) {
            add(
              "error",
              "S-INTEGRITY-MISMATCH",
              `integrity does not match the package: declared ${digest.slice(0, 12)}..., actual ${actual.slice(0, 12)}...`,
              "Run lull-ext hash <bundle> after changing package content",
            );
          }
        } catch (error) {
          add("error", "S-INTEGRITY-COMPUTE", `Cannot compute the content package digest: ${error.message}`);
        }
      }
    }
  } else {
    add("info", "S-INTEGRITY-ABSENT", "No integrity declared: manual placement works, the installer will refuse it");
  }

  // Static packages must not ship scripts
  if (!hasScript && typeof entry === "string" && isFile(join(root, entry))) {
    const html = readFileSync(join(root, entry), "utf8");
    if (/<script[\s>]/i.test(html)) {
      add(
        "error",
        "S-STATIC-SCRIPT",
        'A static package without wallpaper.script runs in sandbox="", so scripts never execute; remove <script> or declare wallpaper.script',
      );
    }
  }
  if (hasScript && typeof entry === "string" && isFile(join(root, entry))) {
    const entryDir = toPosix(dirname(entry));
    const hasScriptFile = files.some(
      (rel) => /\.m?js$/.test(rel) && rel.startsWith(`${entryDir}/`),
    );
    if (!hasScriptFile) {
      add(
        "warn",
        "S-NO-SCRIPT-FILE",
        "wallpaper.script is declared but no .js file sits next to the entry",
        "Script scenes need main.js in the same directory as index.html",
      );
    }
  }
}

function safeSceneEntry(entry) {
  if (entry.startsWith("/") || entry.includes("\\") || entry.includes("%") || entry.includes("\0")) {
    return false;
  }
  const segments = entry.split("/");
  if (segments.length < 2 || segments.length > 6) return false;
  if (!segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")) return false;
  return entry.endsWith(".html");
}

function validateSceneParams(scene, caps, add) {
  const params = scene.params;
  if (params === undefined || params === null) return;
  if (!Array.isArray(params)) {
    add("error", "S-PARAMS-SHAPE", "params must be an array or omitted");
    return;
  }
  if (params.length === 0) return;
  if (Array.isArray(caps) && !caps.includes("wallpaper.params")) {
    add("error", "S-PARAMS-CAP", "Declaring params requires wallpaper.params");
  }

  const seen = new Set();
  params.forEach((param, index) => {
    const at = `params[${index}]`;
    if (!isRecord(param)) {
      add("error", "S-PARAM-SHAPE", `${at} must be an object`);
      return;
    }
    const allowed = ["key", "type", "label", "description", "default", "min", "max", "step", "options"];
    for (const field of Object.keys(param)) {
      if (!allowed.includes(field)) add("error", "S-PARAM-FIELD", `${at} has an unknown field "${field}"`);
    }
    const key = param.key;
    if (typeof key !== "string" || !PARAM_KEY.test(key)) {
      add("error", "S-PARAM-KEY", `${at}.key is invalid: expected ^[a-z][a-z0-9._-]{0,31}$`);
      return;
    }
    if (seen.has(key)) add("error", "S-PARAM-DUP", `${at}.key is duplicated: ${key}`);
    seen.add(key);

    const type = param.type;
    if (!SCENE_PARAM_TYPES.includes(type)) {
      add("error", "S-PARAM-TYPE", `${at}.type is unknown: ${JSON.stringify(type)}`);
      return;
    }
    if (typeof param.label !== "string" || param.label.trim() === "") {
      add("error", "S-PARAM-LABEL", `${at}.label must be a non-empty string`);
    }
    if (!("default" in param)) {
      add("error", "S-PARAM-DEFAULT", `${at} is missing default`);
      return;
    }
    const value = param.default;
    const hasRange = ("min" in param) || ("max" in param) || ("step" in param);

    if (type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        add("error", "S-PARAM-DEFAULT", `${at}.default must be a finite number`);
      } else {
        if (typeof param.min === "number" && value < param.min) {
          add("warn", "S-PARAM-DEFAULT-RANGE", `${at}.default is below min; the host clamps it to min`);
        }
        if (typeof param.max === "number" && value > param.max) {
          add("warn", "S-PARAM-DEFAULT-RANGE", `${at}.default is above max; the host clamps it to max`);
        }
      }
      if (typeof param.min === "number" && typeof param.max === "number" && param.min > param.max) {
        add("error", "S-PARAM-RANGE", `${at}.min must not exceed max`);
      }
      if ("step" in param && !(typeof param.step === "number" && param.step > 0)) {
        add("error", "S-PARAM-STEP", `${at}.step must be greater than 0`);
      }
    } else if (type === "boolean") {
      if (typeof value !== "boolean") add("error", "S-PARAM-DEFAULT", `${at}.default must be a boolean`);
    } else if (type === "color") {
      if (typeof value !== "string" || !COLOR.test(value)) {
        add("error", "S-PARAM-DEFAULT", `${at}.default must be #RRGGBB`);
      }
    } else if (type === "enum") {
      if (!Array.isArray(param.options) || param.options.length === 0) {
        add("error", "S-PARAM-OPTIONS", `${at}.options must be a non-empty array`);
      } else {
        const values = new Set();
        param.options.forEach((option, optionIndex) => {
          const optionAt = `${at}.options[${optionIndex}]`;
          if (!isRecord(option)) {
            add("error", "S-PARAM-OPTION-SHAPE", `${optionAt} must be an object`);
            return;
          }
          for (const field of Object.keys(option)) {
            if (field !== "value" && field !== "label") {
              add("error", "S-PARAM-OPTION-FIELD", `${optionAt} has an unknown field "${field}"`);
            }
          }
          if (typeof option.value !== "string" || option.value.trim() === "") {
            add("error", "S-PARAM-OPTION-VALUE", `${optionAt}.value must be a non-empty string`);
          } else {
            if (values.has(option.value)) add("error", "S-PARAM-OPTION-DUP", `${optionAt}.value is duplicated`);
            values.add(option.value);
          }
          if (typeof option.label !== "string" || option.label.trim() === "") {
            add("error", "S-PARAM-OPTION-LABEL", `${optionAt}.label must be a non-empty string`);
          }
        });
        if (typeof value !== "string" || !values.has(value)) {
          add("error", "S-PARAM-DEFAULT", `${at}.default must match one of options.value`);
        }
      }
    } else if (type === "string") {
      if (typeof value !== "string") add("error", "S-PARAM-DEFAULT", `${at}.default must be a string`);
    }

    if (type !== "number" && hasRange) {
      add("error", "S-PARAM-RANGE-TYPE", `${at}: min/max/step only apply to number params`);
    }
    if (type !== "enum" && "options" in param) {
      add("error", "S-PARAM-OPTIONS-TYPE", `${at}: options only applies to enum params`);
    }
  });
}

function validateSceneTheme(theme, add) {
  if (theme === undefined || theme === null) return;
  if (!isRecord(theme)) {
    add("error", "S-THEME-SHAPE", "theme must be an object");
    return;
  }
  for (const key of Object.keys(theme)) {
    if (key !== "background" && key !== "accent") {
      add("error", "S-THEME-FIELD", `theme has an unknown field "${key}"`);
    }
  }
  for (const key of ["background", "accent"]) {
    const value = theme[key];
    if (value !== undefined && (typeof value !== "string" || !COLOR.test(value))) {
      add("error", "S-THEME-COLOR", `theme.${key} must be #RRGGBB`);
    }
  }
  if (theme.background === undefined) {
    add("info", "S-THEME-BG", "Declare theme.background to avoid a white flash before the first frame");
  }
}

function validateScenePerformance(performance, add) {
  if (performance === undefined || performance === null) return;
  if (!isRecord(performance)) {
    add("error", "S-PERF-SHAPE", "performance must be an object");
    return;
  }
  for (const key of Object.keys(performance)) {
    if (key !== "tier" && key !== "targetFps") {
      add("error", "S-PERF-FIELD", `performance has an unknown field "${key}"`);
    }
  }
  if (!["low", "medium", "high"].includes(performance.tier)) {
    add("error", "S-PERF-TIER", 'performance.tier must be "low" / "medium" / "high"');
  }
  if (performance.targetFps !== undefined) {
    const fps = performance.targetFps;
    if (!Number.isInteger(fps) || fps < 1 || fps > 240) {
      add("error", "S-PERF-FPS", "performance.targetFps must be an integer in 1-240");
    }
  }
}

function validateSceneCompatibility(compatibility, add) {
  if (compatibility === undefined || compatibility === null) return;
  if (!isRecord(compatibility)) {
    add("error", "S-COMPAT-SHAPE", "compatibility must be an object");
    return;
  }
  for (const key of Object.keys(compatibility)) {
    if (!["hostApi", "maxHostApi", "platforms"].includes(key)) {
      add("error", "S-COMPAT-FIELD", `compatibility has an unknown field "${key}"`);
    }
  }
  const hostApi = compatibility.hostApi;
  if (!Number.isInteger(hostApi) || hostApi < 1) {
    add("error", "S-COMPAT-HOSTAPI", "compatibility.hostApi must be a positive integer");
  } else if (hostApi > SCENE_HOST_API) {
    add(
      "warn",
      "S-COMPAT-FUTURE",
      `hostApi ${hostApi} is above the current host (${SCENE_HOST_API}): the catalog layer will filter this scene out`,
    );
  }
  if (compatibility.maxHostApi !== undefined) {
    if (
      !Number.isInteger(compatibility.maxHostApi) ||
      (Number.isInteger(hostApi) && compatibility.maxHostApi < hostApi)
    ) {
      add("error", "S-COMPAT-MAX", "maxHostApi must be an integer >= hostApi");
    }
  }
  if (compatibility.platforms !== undefined) {
    if (!Array.isArray(compatibility.platforms) || compatibility.platforms.length === 0) {
      add("error", "S-COMPAT-PLATFORMS", "platforms must be a non-empty array or omitted");
    } else {
      const seen = new Set();
      for (const platform of compatibility.platforms) {
        if (!SCENE_PLATFORMS.includes(platform)) {
          add("error", "S-COMPAT-PLATFORM", `Unknown platform: ${JSON.stringify(platform)}`);
        } else if (seen.has(platform)) {
          add("error", "S-COMPAT-PLATFORM-DUP", `Duplicate platform: ${platform}`);
        }
        seen.add(platform);
      }
    }
  }
}

/* ------------------------------------------------------------------ assets */

const REMOTE_URL = /(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//i;
const ABS_PATH = /(?:src|href)\s*=\s*["']\//i;
const INLINE_HANDLER = /\son[a-z]+\s*=\s*["']/i;
const CSS_REMOTE = /url\(\s*["']?\s*(?:https?:)?\/\//i;
const LOCAL_STORAGE = /\b(?:localStorage|sessionStorage|indexedDB)\b|document\.cookie/;
const EVAL = /\beval\s*\(|new\s+Function\s*\(/;
const DARK_SCHEME = /color-scheme\s*:\s*dark/i;
const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

/**
 * Strip comments before scanning: writing "do not use localStorage" in a comment
 * must not be flagged. The `//` rule skips `https://`.
 */
function stripComments(text, kind) {
  if (kind === "html") return text.replace(/<!--[\s\S]*?-->/g, "");
  if (kind === "css") return text.replace(/\/\*[\s\S]*?\*\//g, "");
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

function scanAssets(root, report, add, files, kind) {
  const transparent = kind === "widget" ? isTransparentWidget(root) : false;

  for (const rel of files) {
    const absolute = join(root, rel);
    const lower = rel.toLowerCase();
    if (!/\.(html?|css|m?js|json|svg)$/.test(lower)) continue;
    // vendor/ holds a copy of the SDK: its window.parent / new Function is bridge code, not a violation.
    const vendored = rel.split("/").includes("vendor");
    let text;
    try {
      text = stripComments(readFileSync(absolute, "utf8"), lower.endsWith(".html") ? "html" : lower.endsWith(".css") ? "css" : "js");
    } catch {
      continue;
    }

    if (lower.endsWith(".html") || lower.endsWith(".htm")) {
      if (REMOTE_URL.test(text)) {
        add(
          "error",
          "P-REMOTE",
          `${rel}: references a remote resource (http/https)`,
          "Only relative assets belong in a package; API calls go through the manifest.network allowlist + fetch()",
        );
      }
      if (ABS_PATH.test(text)) {
        add("error", "P-ABS-PATH", `${rel}: uses a root-absolute path starting with / (packages are not served at the site root)`, "Use ./ relative paths");
      }
      if (INLINE_HANDLER.test(text)) {
        add(
          "error",
          "P-INLINE-HANDLER",
          `${rel}: uses inline event handlers (onclick= etc.); the host CSP forbids them`,
          "Use addEventListener",
        );
      }
      if (!/<meta\s+charset=/i.test(text)) {
        add("info", "P-CHARSET", `${rel}: add <meta charset="utf-8">`);
      }
    }
    if (lower.endsWith(".css") || lower.endsWith(".html")) {
      if (CSS_REMOTE.test(text)) {
        add("error", "P-REMOTE-CSS", `${rel}: CSS references a remote resource (url(http...))`);
      }
    }
    if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".html")) {
      if (text.includes("@tauri-apps/")) {
        add(
          "error",
          "P-TAURI",
          `${rel}: imports @tauri-apps/api`,
          "Plugins must not touch Tauri IPC; host capabilities go through the SDK postMessage bridge",
        );
      }
      if (LOCAL_STORAGE.test(text) && !vendored) {
        add(
          "warn",
          "P-STORAGE",
          `${rel}: uses localStorage / cookie / indexedDB`,
          "The iframe is an opaque origin, these APIs are unavailable; keep state in the SDK getState/setState",
        );
      }
      if (EVAL.test(text) && !vendored) {
        add("warn", "P-EVAL", `${rel}: uses eval / new Function`, "Usually blocked by the host CSP (includes Vue runtime templates)");
      }
      // Relative modules must exist (the most common cause is a missing vendor/)
      for (const match of text.matchAll(RELATIVE_IMPORT)) {
        const specifier = match[1];
        const target = resolve(dirname(absolute), specifier);
        const candidates = [target, `${target}.js`, `${target}.mjs`, join(target, "index.js")];
        if (!candidates.some((candidate) => existsSync(candidate))) {
          add(
            "error",
            "P-MODULE-MISSING",
            `${rel}: cannot resolve relative import -> ${specifier}`,
            "Run lull-ext vendor <dir> to copy the SDK dist, or fix the path",
          );
        }
      }
      // The bridge itself uses window.parent.postMessage; reaching into host DOM is the violation.
      if (kind === "scene" && !vendored && /\bwindow\.(?:top|parent)\.(?!postMessage)/.test(text)) {
        add(
          "warn",
          "P-PARENT",
          `${rel}: touches the host window object (window.top/parent)`,
          "Scenes talk through the @lull/scene-sdk bridge only; do not read host DOM",
        );
      }
    }
    if (transparent && DARK_SCHEME.test(text) && !vendored) {
      add(
        "warn",
        "P-DARK-SCHEME",
        `${rel}: color-scheme: dark inside a transparent window`,
        "WebView2 paints the iframe canvas opaque, so the desktop no longer shows through; scope dark colors to a local container",
      );
    }
  }
}

function isTransparentWidget(root) {
  try {
    const manifest = readJson(join(root, "widget.json"));
    const win = manifest?.window;
    return !(isRecord(win) && win.transparent === false);
  } catch {
    return true;
  }
}

/** Render the report as human-readable text. */
export function formatReport(report) {
  const lines = [];
  const head = `${report.kind}  ${report.id ?? "<no id>"}${report.version ? `@${report.version}` : ""}`;
  lines.push(`${report.ok ? "[ok]" : "[fail]"} ${head}`);
  lines.push(
    `   root  ${report.root}\n   files ${report.stats.files} / ${(report.stats.bytes / 1024).toFixed(1)} KB`,
  );
  if (report.entry) lines.push(`   entry ${report.entry}`);
  for (const [label, bucket] of [
    ["errors", report.errors],
    ["warnings", report.warnings],
    ["notes", report.infos],
  ]) {
    if (bucket.length === 0) continue;
    lines.push(`   ${label} (${bucket.length})`);
    for (const item of bucket) {
      lines.push(`     - ${item.code}: ${item.message}`);
      if (item.hint) lines.push(`       -> ${item.hint}`);
    }
  }
  return lines.join("\n");
}
