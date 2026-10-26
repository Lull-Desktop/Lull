/**
 * SDK fetch and compile.
 *
 * Goal: get build artefacts (dist + .d.ts) of `@lull/widget-sdk` / `@lull/scene-sdk`
 * that match the **current code** under the Lull repo `packages/` directory, so an
 * extension project can consume them via vendor (native ESM) or a file: dependency.
 *
 * Two sources:
 *   --from <dir>   use an existing local checkout (offline, reproducible, preferred in-repo)
 *   (default)      sparse-clone the GitHub repo into the cache and check out packages/ only
 *
 * No pnpm involved: each package has its own tsconfig and devDependencies, so running
 * `tsc -p tsconfig.json` inside the package directory is enough. That avoids the root
 * workspace native deps (Next / Tauri) and any local pnpm linker quirks.
 */
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { log } from "./log.mjs";
import {
  cacheRoot,
  copyDir,
  copyPath,
  ensureDir,
  formatBytes,
  isDir,
  isFile,
  readJson,
  removeInside,
  walkFiles,
  writeJson,
} from "./util.mjs";

export const REPO_URL = "https://github.com/Lull-Desktop/Lull.git";
export const SDKS = [
  { dir: "widget-sdk", name: "@lull/widget-sdk" },
  { dir: "scene-sdk", name: "@lull/scene-sdk" },
];

/** Is git usable on this machine. */
export function hasGit() {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function slug(text) {
  return text.replace(/[^A-Za-z0-9._-]+/g, "_");
}

/**
 * Prepare the source directory, return { repoRoot, source }.
 * @param {{from?: string, ref?: string, cache?: string, refresh?: boolean, offline?: boolean}} options
 */
export function resolveSource(options = {}) {
  const cache = resolve(options.cache ?? cacheRoot());

  if (options.from) {
    const repoRoot = resolve(options.from);
    if (!isFile(join(repoRoot, "packages", "widget-sdk", "package.json"))) {
      throw new Error(
        `--from ${repoRoot} does not look like the Lull repo root: packages/widget-sdk/package.json is missing`,
      );
    }
    let commit = null;
    try {
      commit = git(["rev-parse", "--short", "HEAD"], repoRoot);
    } catch {
      commit = null;
    }
    return {
      repoRoot,
      source: { mode: "local", path: repoRoot, ref: commit ?? "worktree" },
    };
  }

  if (options.offline) {
    throw new Error("--offline also requires --from <local checkout>");
  }
  if (!hasGit()) {
    throw new Error("git not found: install git, or use --from <local checkout>");
  }

  const ref = options.ref ?? "main";
  const cloneDir = join(cache, "src", slug(ref));

  if (isDir(cloneDir) && options.refresh) {
    log.info(`Refreshing cached clone: ${cloneDir}`);
    removeInside(cloneDir, cache);
  }

  if (!isDir(cloneDir)) {
    ensureDir(join(cache, "src"));
    log.step(`Sparse-cloning ${REPO_URL} (${ref}) -> ${cloneDir}`);
    const args = [
      "clone",
      "--depth",
      "1",
      "--filter=blob:none",
      "--sparse",
      "--branch",
      ref,
      REPO_URL,
      cloneDir,
    ];
    try {
      git(args, cache);
    } catch (error) {
      throw new Error(
        `git clone failed (${ref}): ${error.stderr?.toString().trim() || error.message}\n` +
          "  Check the network/proxy and whether the tag exists (git ls-remote --tags " + REPO_URL + ")",
      );
    }
    // Check out only what is needed: src-tauri / website are large and never touched here.
    git(["sparse-checkout", "set", "packages"], cloneDir);
  } else {
    log.info(`Reusing cached clone: ${cloneDir} (pass --refresh to re-clone)`);
    if (!isDir(join(cloneDir, "packages"))) {
      git(["sparse-checkout", "set", "packages"], cloneDir);
    }
  }

  let commit;
  try {
    commit = git(["rev-parse", "HEAD"], cloneDir);
  } catch (error) {
    throw new Error(`Cannot read the commit of ${cloneDir}: ${error.message}`);
  }
  return { repoRoot: cloneDir, source: { mode: "git", remote: REPO_URL, ref, commit } };
}

/** Locate a usable tsc entry (absolute path to typescript/bin/tsc). */
function findTsc(repoRoot, pkgDir) {
  const candidates = [
    join(pkgDir, "node_modules", "typescript", "bin", "tsc"),
    join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
  ];
  return candidates.find((candidate) => isFile(candidate)) ?? null;
}

function installPackageDeps(pkgDir, pkgName) {
  log.step(`Installing compile dependencies for ${pkgName} (npm install, this package only)`);
  try {
    execSync(
      "npm install --no-package-lock --no-audit --no-fund --loglevel=error",
      { cwd: pkgDir, stdio: ["ignore", "pipe", "pipe"], shell: true, encoding: "utf8" },
    );
  } catch (error) {
    throw new Error(
      `npm install failed in ${pkgDir}: ${(error.stderr || error.stdout || error.message).toString().trim()}`,
    );
  }
}

/** Deterministic digest of the dist directory (path/size/bytes), used to tell whether artefacts changed. */
function distDigest(distDir) {
  const hash = createHash("sha256");
  for (const rel of walkFiles(distDir)) {
    const path = join(distDir, rel);
    const bytes = readFileSync(path);
    hash.update(rel, "utf8");
    hash.update("\0");
    hash.update(String(bytes.length), "utf8");
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function buildPackage(repoRoot, sdk, options) {
  const pkgDir = join(repoRoot, "packages", sdk.dir);
  if (!isFile(join(pkgDir, "package.json"))) {
    throw new Error(`${sdk.name} is missing from the source tree: expected ${join(pkgDir, "package.json")}`);
  }

  let tsc = findTsc(repoRoot, pkgDir);
  if (!tsc && !options.offline) {
    installPackageDeps(pkgDir, sdk.name);
    tsc = findTsc(repoRoot, pkgDir);
  }
  if (!tsc) {
    throw new Error(
      `No typescript compiler found: neither ${pkgDir}/node_modules nor ${repoRoot}/node_modules has one.\n` +
        "  Re-run with network access (it runs npm install automatically), or run npm install in that package first.",
    );
  }

  const tsconfig = join(pkgDir, "tsconfig.json");
  log.step(`Compiling ${sdk.name} (tsc -p ${tsconfig})`);
  try {
    execFileSync(process.execPath, [tsc, "-p", tsconfig], {
      cwd: pkgDir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (error) {
    throw new Error(
      `${sdk.name} failed to compile:\n${(error.stdout || error.stderr || error.message).toString().trim()}`,
    );
  }

  const distDir = join(pkgDir, "dist");
  for (const required of ["index.js", "index.d.ts"]) {
    if (!isFile(join(distDir, required))) {
      throw new Error(`${sdk.name} is missing dist/${required} after compiling`);
    }
  }

  const pkg = readJson(join(pkgDir, "package.json"));
  return {
    sdk,
    pkgDir,
    distDir,
    manifest: pkg,
    dist: {
      files: walkFiles(distDir),
      bytes: statSync(join(distDir, "index.js")).size,
      digest: distDigest(distDir),
      totalBytes: walkFiles(distDir).reduce(
        (sum, rel) => sum + statSync(join(distDir, rel)).size,
        0,
      ),
    },
  };
}

/**
 * Fetch + compile + emit a consumable SDK directory.
 * @param {{from?: string, ref?: string, cache?: string, out?: string,
 *          refresh?: boolean, offline?: boolean, skipSmoke?: boolean}} options
 */
export async function buildSdk(options = {}) {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 20) {
    throw new Error(`Node >= 20 is required, current ${process.versions.node}`);
  }

  const cache = resolve(options.cache ?? cacheRoot());
  const out = resolve(options.out ?? join(cache, "sdk"));
  const { repoRoot, source } = resolveSource(options);

  const built = SDKS.map((sdk) => buildPackage(repoRoot, sdk, options));

  // Land in out/: <out>/widget-sdk/{package.json,dist,README.md}
  const packages = [];
  for (const item of built) {
    const target = join(out, item.sdk.dir);
    ensureDir(target);
    copyDir(item.distDir, join(target, "dist"));
    for (const extra of ["package.json", "README.md"]) {
      if (isFile(join(item.pkgDir, extra))) {
        copyPath(join(item.pkgDir, extra), join(target, extra));
      }
    }
    packages.push({
      name: item.manifest.name,
      version: item.manifest.version,
      dir: item.sdk.dir,
      entry: `${item.sdk.dir}/dist/index.js`,
      types: `${item.sdk.dir}/dist/index.d.ts`,
      files: item.dist.files.length,
      indexBytes: item.dist.bytes,
      distBytes: item.dist.totalBytes,
      digest: `sha256:${item.dist.digest}`,
    });
  }

  const recorded = {
    schemaVersion: 1,
    source,
    builtAt: new Date().toISOString(),
    node: process.versions.node,
    packages,
  };
  writeJson(join(out, "sdk-manifest.json"), recorded);

  if (!options.skipSmoke) {
    for (const item of packages) {
      const entry = pathToFileURL(join(out, item.entry)).href;
      const mod = await import(`${entry}?t=${Date.now()}`);
      const expected = item.dir === "widget-sdk" ? "connectLullWidget" : "connectLullScene";
      if (typeof mod[expected] !== "function") {
        throw new Error(`${item.name} does not export ${expected} (the dist looks incomplete)`);
      }
    }
    log.ok("Artefact self-check passed: ESM imports and exposes the expected symbols");
  }

  log.ok(`SDK ready -> ${out}`);
  for (const item of packages) {
    log.item(
      `${item.name}@${item.version}  ${item.files} files / ${formatBytes(item.distBytes)}  ${item.digest.slice(0, 19)}...`,
    );
  }
  return { out, repoRoot, source, packages, manifestPath: join(out, "sdk-manifest.json") };
}

/** Read the manifest of a previously built SDK. */
export function readSdkManifest(out) {
  const path = join(resolve(out), "sdk-manifest.json");
  if (!isFile(path)) {
    throw new Error(`${path} not found: run lull-ext sdk build first`);
  }
  return { path, manifest: readJson(path) };
}

/**
 * Copy the SDK dist into an extension package (native ESM, imported directly by the
 * browser, no bundler required).
 *
 * @param {string} vendorRoot target vendor directory (widget: `<pkg>/vendor`;
 *   scene: `<bundle>/<entryDir>/vendor`, because the content digest only covers the entry directory)
 * @param {string} sdkOut the --out used for sdk build
 * @param {"widget"|"scene"} kind
 */
export function vendorSdk(vendorRoot, sdkOut, kind) {
  const item = SDKS.find((sdk) => sdk.dir === `${kind}-sdk`);
  if (!item) throw new Error(`Unknown extension kind: ${kind}`);
  const from = join(resolve(sdkOut), item.dir, "dist");
  if (!isDir(from)) {
    throw new Error(`${from} not found: run lull-ext sdk build first`);
  }
  const to = join(resolve(vendorRoot), item.dir);
  // Copy only runtime files: sourcemaps are useless to the host and just add weight.
  if (isDir(to)) rmSync(to, { recursive: true, force: true });
  ensureDir(to);
  const files = readdirSync(from).filter(
    (name) => !name.endsWith(".map") && !name.startsWith("."),
  );
  for (const name of files) {
    copyFileSync(join(from, name), join(to, name));
  }
  log.ok(`Vendored ${item.name} -> ${to} (${files.length} entries)`);
  return { pkg: item.name, dir: item.dir, path: to, files };
}
