/**
 * Command line entry point and help text.
 *
 * Output contract (easy to parse for AI or scripts):
 *   stdout carries human-readable progress and results, stderr carries diagnostics and errors;
 *   exit code 0 = success, 1 = failure (validation / network / bad target directory), 2 = usage error.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { writeContentIntegrity } from "./digest.mjs";
import { log, paint, usageError } from "./log.mjs";
import { packExtension } from "./pack.mjs";
import { createScene, createWidget, vendorDirFor } from "./scaffold.mjs";
import { buildSdk, hasGit, readSdkManifest, vendorSdk } from "./sdk.mjs";
import {
  cacheRoot,
  isFile,
  packageRoot,
  readJson,
} from "./util.mjs";
import { detectKind, formatReport, validatePackage } from "./validate.mjs";

const VERSION = readJson(join(packageRoot, "package.json")).version;
/** Skill directory name, used to probe the standard install locations (Agent Skills spec: name matches directory). */
const SKILL_NAME = "lull-extension";

function camel(key) {
  return key.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

/** Minimal argument parser: --flag, --flag=value, --flag value, --no-flag, -h. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      flags.help = true;
      continue;
    }
    if (arg === "-v" || arg === "--version") {
      flags.version = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    if (body.startsWith("no-")) {
      flags[camel(body.slice(3))] = false;
      continue;
    }
    const [rawKey, inline] = body.split("=");
    if (inline !== undefined) {
      flags[camel(rawKey)] = inline;
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("-")) {
      flags[camel(rawKey)] = next;
      index += 1;
    } else {
      flags[camel(rawKey)] = true;
    }
  }
  return { flags, positional };
}

const HELP = `
lull-ext v${VERSION} - Lull extension development (widget tools / wallpaper scenes)

Usage
  lull-ext <command> [options]

Commands
  doctor               health check: node / git / npm / cache / SDK artefacts / skill install location
  sdk build            fetch the Lull repo packages/ and compile @lull/widget-sdk and @lull/scene-sdk
  sdk info             print the last SDK build manifest
  new widget <dir>     scaffold a tool extension (manifest + vendor)
  new scene <dir>      scaffold a wallpaper scene (script or static)
  vendor <dir>         copy the SDK dist into the extension vendor/
  hash <dir>           recompute the content package integrity and write it back to catalog.json
  validate <dir>       validate against the extension standard (manifest + artefacts + sandbox rules)
  pack <dir>           pack into an installable zip

Options
  --from <repo>        compile the SDK from a local checkout (offline, matches local code)
  --ref <branch|tag>   clone a specific ref (default main)
  --out <dir>          SDK output directory / package output directory
  --sdk <dir>          SDK directory used by vendor / new
  --json               validate and doctor emit machine-readable JSON
  --strict             validate: treat warnings as errors
  --force              overwrite the generated directory

Examples
  lull-ext sdk build --from .                    # compile the current working tree
  lull-ext sdk build                             # clone main from GitHub and compile
  lull-ext new widget ./my-tool --id my-tool --name "My tool"
  lull-ext validate ./my-tool --strict
  lull-ext pack ./my-tool --out ./artifacts
  lull-ext new scene ./mist --id community.mist --name Mist --static

Installing the skill itself is not this CLI's job:
  npx skills add Lull-Desktop/Lull --skill lull-extension
`;

function requirePositional(positional, index, name) {
  const value = positional[index];
  if (!value) throw usageError(`Missing argument: ${name} (run lull-ext --help for usage)`);
  return value;
}

function commandDoctor(flags) {
  const checks = [];
  const add = (name, ok, detail, hint) => checks.push({ name, ok, detail, ...(hint ? { hint } : {}) });

  const major = Number(process.versions.node.split(".")[0]);
  add("node", major >= 20, `${process.version} · ${process.platform}/${process.arch}`, major >= 20 ? undefined : "Compiling the SDK requires Node >= 20");

  const git = hasGit();
  add("git", git, git ? "available" : "not found", git ? undefined : "Without git you can only use --from <local checkout>");

  let npm = null;
  try {
    npm = execSync("npm -v", { encoding: "utf8", shell: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    npm = null;
  }
  add("npm", Boolean(npm), npm ?? "not found", npm ? undefined : "The first SDK build needs npm to install typescript");

  const cache = cacheRoot();
  add("cache", true, cache, existsSync(cache) ? "exists" : "created on first run");

  const sdkOut = resolve(String(flags.sdk ?? join(cache, "sdk")));
  const manifestPath = join(sdkOut, "sdk-manifest.json");
  if (isFile(manifestPath)) {
    const manifest = readJson(manifestPath);
    const pkgs = manifest.packages.map((item) => `${item.name}@${item.version}`).join(", ");
    add("sdk", true, `${pkgs} · ${new Date(manifest.builtAt).toLocaleString()}`, sdkOut);
  } else {
    add("sdk", false, "not built yet", `Run lull-ext sdk build --out "${sdkOut}"`);
  }

  // Is the skill installed into any agent's standard skill directory (Agent Skills spec; the skills CLI owns installs)
  const installed = [
    join(process.cwd(), ".agents", "skills", SKILL_NAME),
    join(process.cwd(), ".claude", "skills", SKILL_NAME),
    join(homedir(), ".claude", "skills", SKILL_NAME),
    join(homedir(), ".agents", "skills", SKILL_NAME),
  ].find((dir) => isFile(join(dir, "SKILL.md")));
  if (installed) {
    add("skill", true, installed);
  } else {
    add("skill", false, "not found in the standard locations", "npx skills add Lull-Desktop/Lull --skill lull-extension -y");
  }

  const cwdRepo = isFile(join(process.cwd(), "packages", "widget-sdk", "package.json"));
  add(
    "repo",
    cwdRepo,
    cwdRepo ? `current directory is the Lull repo: ${process.cwd()}` : "current directory is not the Lull repo",
    cwdRepo ? "You can run lull-ext sdk build --from ." : undefined,
  );

  if (flags.json) {
    log.raw(JSON.stringify({ version: VERSION, ok: checks.every((item) => item.ok), checks }, null, 2));
    return checks;
  }
  for (const item of checks) {
    const tag = item.ok ? paint.green("[ok]  ") : paint.yellow("[warn]");
    log.raw(`${tag} ${item.name.padEnd(6)} ${item.detail}`);
    if (item.hint) log.raw(`       ${paint.dim(item.hint)}`);
  }
  return checks;
}

async function commandSdk(flags, positional) {
  const sub = positional[0] ?? "build";
  if (sub === "info") {
    const out = resolve(String(flags.out ?? join(cacheRoot(), "sdk")));
    const { manifest } = readSdkManifest(out);
    log.raw(JSON.stringify(manifest, null, 2));
    return manifest;
  }
  if (sub !== "build") throw usageError(`Unknown subcommand: sdk ${sub} (available: build / info)`);

  const result = await buildSdk({
    from: flags.from ? String(flags.from) : undefined,
    ref: flags.ref ? String(flags.ref) : undefined,
    cache: flags.cache ? String(flags.cache) : undefined,
    out: flags.out ? String(flags.out) : undefined,
    refresh: flags.refresh === true,
    offline: flags.offline === true,
    skipSmoke: flags.smoke === false,
  });
  log.next(`To consume it: run lull-ext vendor <dir> inside the extension, or install file:${result.out}/widget-sdk as a dependency`);
  return result;
}

function commandVendor(flags, positional) {
  const target = resolve(requirePositional(positional, 0, "<extension directory>"));
  const kind = flags.kind ? String(flags.kind) : detectKind(target);
  if (!kind) throw new Error(`${target} is not an extension package (missing widget.json / catalog.json)`);

  let entry = null;
  if (kind === "widget") {
    entry = readJson(join(target, "widget.json")).entry;
  } else {
    const catalog = readJson(join(target, "catalog.json"));
    entry = catalog.scenes?.[0]?.entry;
  }
  const vendorRoot = vendorDirFor(target, kind, entry);
  const sdkOut = resolve(String(flags.sdk ?? process.env.LULL_SDK_DIR ?? join(cacheRoot(), "sdk")));
  const result = vendorSdk(vendorRoot, sdkOut, kind);
  if (kind === "scene") {
    const hashed = writeContentIntegrity(target);
    log.info(`Recomputed script scene integrity: ${hashed.digest.slice(0, 12)}... (vendor/ is inside the digest scope)`);
  }
  return result;
}

function commandHash(flags, positional) {
  const bundle = resolve(requirePositional(positional, 0, "<content bundle directory>"));
  const result = writeContentIntegrity(bundle);
  log.ok(`integrity written to catalog.json: ${result.digest}`);
  if (result.previous && result.previous !== result.digest) {
    log.item(`previous value ${result.previous}`);
  }
  log.item(`digest directory ${result.dir}`);
  return result;
}

function commandValidate(flags, positional) {
  const target = resolve(requirePositional(positional, 0, "<extension directory>"));
  const report = validatePackage(target, {
    strict: flags.strict === true,
    kind: flags.kind ? String(flags.kind) : undefined,
  });
  if (flags.json) {
    log.raw(JSON.stringify(report, null, 2));
  } else {
    log.raw(formatReport(report));
  }
  if (!report.ok) {
    const error = new Error(`Validation failed: ${report.errors.length} error(s)`);
    error.exitCode = 1;
    throw error;
  }
  return report;
}

function commandNew(flags, positional) {
  const kind = positional[0];
  const target = resolve(requirePositional(positional, 1, "<directory>"));
  if (kind !== "widget" && kind !== "scene") {
    throw usageError("new needs a kind: widget or scene");
  }

  const created =
    kind === "widget"
      ? createWidget({
          target,
          id: flags.id ? String(flags.id) : undefined,
          name: flags.name ? String(flags.name) : undefined,
          description: flags.description ? String(flags.description) : undefined,
          chrome: flags.chrome ? String(flags.chrome) : "custom",
          audio: flags.audio === true,
          force: flags.force === true,
        })
      : createScene({
          target,
          id: flags.id ? String(flags.id) : undefined,
          name: flags.name ? String(flags.name) : undefined,
          description: flags.description ? String(flags.description) : undefined,
          mode: flags.static ? "static" : "script",
          params: flags.params !== false,
          force: flags.force === true,
        });

  const sdkOut = resolve(String(flags.sdk ?? process.env.LULL_SDK_DIR ?? join(cacheRoot(), "sdk")));
  const needsSdk = kind === "widget" || (created.kind === "scene" && created.mode === "script");
  if (flags.vendor === false || !needsSdk) {
    if (needsSdk) log.warn("Skipped vendor: run lull-ext vendor <dir> before validation can pass");
    return created;
  }
  if (!isFile(join(sdkOut, `${kind}-sdk`, "dist", "index.js"))) {
    log.warn(`No built SDK found (${sdkOut}): run lull-ext sdk build first`);
    log.next(`Then run: lull-ext vendor "${target}"`);
    return created;
  }
  const vendorRoot = vendorDirFor(target, kind, created.entry ?? "index.html");
  vendorSdk(vendorRoot, sdkOut, kind);
  if (kind === "scene") {
    const hashed = writeContentIntegrity(target);
    log.info(`Recomputed integrity: ${hashed.digest.slice(0, 12)}...`);
  }
  return created;
}

function commandPack(flags, positional) {
  const target = resolve(requirePositional(positional, 0, "<extension directory>"));
  return packExtension({
    target,
    out: flags.out ? String(flags.out) : undefined,
    skipValidate: flags.skipValidate === true,
    hash: flags.hash !== false,
  });
}

export async function main(argv) {
  const { flags, positional } = parseArgs(argv);
  const command = positional.shift();

  if (flags.version && !command) {
    log.raw(`lull-ext v${VERSION}`);
    return;
  }
  if (!command || command === "help" || flags.help) {
    log.raw(HELP.trim());
    return;
  }

  switch (command) {
    case "doctor":
      commandDoctor(flags);
      return;
    case "sdk":
      await commandSdk(flags, positional);
      return;
    case "new":
      commandNew(flags, positional);
      return;
    case "vendor":
      commandVendor(flags, positional);
      return;
    case "hash":
      commandHash(flags, positional);
      return;
    case "validate":
      commandValidate(flags, positional);
      return;
    case "pack":
      commandPack(flags, positional);
      return;
    default:
      throw usageError(`Unknown command: ${command}\n\n${HELP.trim()}`);
  }
}
