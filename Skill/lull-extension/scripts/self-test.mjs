#!/usr/bin/env node
/**
 * Self-test: pins the three facts this skill relies on to executable assertions.
 *
 *   1. the digest algorithm matches the repo (checked against the known param-demo digest)
 *   2. the packages shipped in the repo pass validation (catches standard/implementation drift)
 *   3. the template chain works end to end: new -> vendor -> validate -> pack
 *
 * Usage: node scripts/self-test.mjs [--repo <Lull checkout>]
 * Exit code 0 = all green, 1 = at least one failure.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contentPackageDigest, packageDirFor } from "../lib/digest.mjs";
import { vendorSdk } from "../lib/sdk.mjs";
import { createScene, createWidget, vendorDirFor } from "../lib/scaffold.mjs";
import { validatePackage, formatReport } from "../lib/validate.mjs";
import { packExtension } from "../lib/pack.mjs";
import { readJson } from "../lib/util.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoFlagIndex = process.argv.indexOf("--repo");
const REPO = resolve(repoFlagIndex > 0 ? process.argv[repoFlagIndex + 1] : join(here, "../../.."));
const failures = [];
const results = [];

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
    failures.push({ name, error });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// 1) Digest cross-check against the official param-demo 1.1.0 digest
check("digest algorithm matches the repo", () => {
  const bundle = join(REPO, "examples/scenes/param-demo");
  const catalog = readJson(join(bundle, "catalog.json"));
  const scene = catalog.scenes[0];
  const digest = contentPackageDigest({
    id: scene.id,
    version: scene.version,
    dir: packageDirFor(scene.entry, bundle),
  });
  assert(digest === scene.integrity.digest, `digest mismatch: computed ${digest}, manifest ${scene.integrity.digest}`);
  return digest.slice(0, 12);
});

// 2) Packages shipped in the repo must pass validation
check("example: script scene param-demo", () => {
  const report = validatePackage(join(REPO, "examples/scenes/param-demo"));
  assert(report.ok, `${report.errors.length} error(s):\n${report.errors.map((e) => `${e.code} ${e.message}`).join("\n")}`);
  return `${report.id}@${report.version}, ${report.warnings.length} warning(s)`;
});

check("example: vanilla TS widget pomodoro-js", () => {
  const report = validatePackage(join(REPO, "examples/widgets/pomodoro-js/dist"));
  assert(report.ok, `${report.errors.length} error(s):\n${report.errors.map((e) => `${e.code} ${e.message}`).join("\n")}`);
  return `${report.id}@${report.version}, ${report.warnings.length} warning(s)`;
});

const work = mkdtempSync(join(tmpdir(), "lull-ext-selftest-"));
const sdkOut = join(work, "sdk");

function copyDist(pkg) {
  const from = join(REPO, "packages", pkg, "dist");
  const to = join(sdkOut, pkg, "dist");
  assert(existsSync(join(from, "index.js")), `${from}/index.js is missing (build the SDK in the repo first)`);
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const source = join(from, name);
    if (!statSync(source).isFile()) continue;
    copyFileSync(source, join(to, name));
  }
  copyFileSync(join(REPO, "packages", pkg, "package.json"), join(sdkOut, pkg, "package.json"));
}

check("prepare SDK directory (reuse the repo build output)", () => {
  copyDist("widget-sdk");
  copyDist("scene-sdk");
  return sdkOut;
});

check("template: widget -> vendor -> validate -> pack", () => {
  const target = join(work, "selftest-widget");
  const created = createWidget({ target, id: "selftest-widget", name: "Self-test tool" });
  assert(created.kind === "widget", "wrong kind");
  vendorSdk(vendorDirFor(target, "widget", "index.html"), sdkOut, "widget");
  const report = validatePackage(target, { strict: true });
  assert(report.ok, `validation failed://n${formatReport(report)}`);
  const packed = packExtension({ target, out: join(work, "out") });
  assert(existsSync(packed.zipPath), "zip was not produced");
  assert(packed.entries >= 5, `too few entries: ${packed.entries}`);
  return `${packed.zipPath.split(/[\\/]/).pop()} (${packed.entries} entries)`;
});

check("template: static scene -> hash -> validate -> pack", () => {
  const target = join(work, "demo-scene-static");
  createScene({ target, id: "selftest.static", name: "Self-test static scene", mode: "static" });
  const report = validatePackage(target, { strict: true });
  assert(report.ok, `validation failed://n${formatReport(report)}`);
  const packed = packExtension({ target, out: join(work, "out") });
  assert(existsSync(packed.zipPath), "zip was not produced");
  const catalog = readJson(join(target, "catalog.json"));
  assert(typeof catalog.scenes[0].integrity?.digest === "string", "no integrity after packing");
  return `${catalog.scenes[0].id}@${catalog.scenes[0].version}`;
});

check("template: script scene -> vendor -> hash -> validate -> pack", () => {
  const target = join(work, "demo-scene-script");
  const created = createScene({ target, id: "selftest.script", name: "Self-test script scene", mode: "script" });
  vendorSdk(vendorDirFor(target, "scene", created.entry), sdkOut, "scene");
  const report = validatePackage(target, { strict: true });
  assert(report.ok, `validation failed://n${formatReport(report)}`);
  const packed = packExtension({ target, out: join(work, "out") });
  assert(existsSync(packed.zipPath), "zip was not produced");
  return `${packed.entries} entries`;
});

check("validator catches typical mistakes", () => {
  const target = join(work, "selftest-bad");
  createWidget({ target, id: "selftest-bad", name: "Bad example" });
  const manifestPath = join(target, "widget.json");
  const manifest = readJson(manifestPath);
  manifest.capabilities = [...manifest.capabilities, "widget.native"];
  manifest.window.resizable = true;
  manifest.entry = "../escape.html";
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const report = validatePackage(target);
  const codes = report.errors.map((item) => item.code);
  assert(!report.ok, "should have failed");
  assert(codes.includes("W-CAPS-FORBIDDEN"), `missing W-CAPS-FORBIDDEN: ${codes.join(",")}`);
  assert(codes.includes("W-WINDOW-RESIZABLE"), `missing W-WINDOW-RESIZABLE: ${codes.join(",")}`);
  assert(codes.includes("W-ENTRY-SAFE"), `missing W-ENTRY-SAFE: ${codes.join(",")}`);
  return codes.join(", ");
});

for (const item of results) {
  const tag = item.ok ? "[ok]  " : "[fail]";
  console.log(`${tag} ${item.name}${item.detail !== undefined ? ` - ${item.detail}` : ""}`);
}
rmSync(work, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error.message}`);
  process.exit(1);
}
console.log("\nAll checks passed");
