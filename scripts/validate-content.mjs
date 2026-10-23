/**
 * 内容目录校验：不依赖外部包，供 `pnpm content:check` 与 CI 使用。
 *
 * 校验范围：
 * - public/content/catalog.json 的 schemaVersion / scenes 结构；
 * - 场景清单必填字段、id / 版本 / capability / entry 安全性；
 * - entry 指向的静态文件确实存在；
 * - id 不重复。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computePackageDigest, packageDirFor } from "./content-digest.mjs";
import { verifyCatalogSignature } from "./sign-content.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = join(root, "public", "content", "catalog.json");
const contentRoot = join(root, "public", "content");

const CAPABILITIES = new Set([
  "wallpaper.viewport",
  "wallpaper.canvas",
  "wallpaper.sync",
  "wallpaper.params",
  "wallpaper.script",
]);
const ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ENTRY = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]*\.html$/;
const COLOR = /^#[0-9A-Fa-f]{6}$/;
const PARAM_KEY = /^[a-z][a-z0-9._-]{0,31}$/;
const PARAM_TYPES = new Set(["number", "boolean", "string", "color", "enum"]);
const PLATFORMS = new Set(["windows", "macos", "linux"]);
const TIERS = new Set(["low", "medium", "high"]);
const MANIFEST_KEYS = new Set([
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

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function checkParams(scene, where) {
  if (scene.params === undefined) return;
  if (!Array.isArray(scene.params)) {
    fail(`${where}.params 必须是数组`);
    return;
  }
  const keys = new Set();
  for (const [index, param] of scene.params.entries()) {
    const at = `${where}.params[${index}]`;
    if (!isObject(param)) {
      fail(`${at} 必须是对象`);
      continue;
    }
    for (const key of Object.keys(param)) {
      if (
        !["key", "type", "label", "description", "default", "min", "max", "step", "options"].includes(
          key,
        )
      ) {
        fail(`${at} 含未知字段: ${key}`);
      }
    }
    if (typeof param.key !== "string" || !PARAM_KEY.test(param.key)) {
      fail(`${at}.key 缺失或格式非法`);
    } else if (keys.has(param.key)) {
      fail(`${at}.key 重复: ${param.key}`);
    } else {
      keys.add(param.key);
    }
    if (typeof param.label !== "string" || param.label.trim() === "") {
      fail(`${at}.label 必填`);
    }
    if (!PARAM_TYPES.has(param.type)) {
      fail(`${at}.type 非法`);
      continue;
    }
    if (!("default" in param)) {
      fail(`${at}.default 必填`);
      continue;
    }
    if (param.type === "number") {
      if (typeof param.default !== "number" || !Number.isFinite(param.default)) {
        fail(`${at}.default 必须是有限数字`);
      }
      for (const key of ["min", "max", "step"]) {
        if (param[key] !== undefined && typeof param[key] !== "number") {
          fail(`${at}.${key} 必须是数字`);
        }
      }
      if (param.min !== undefined && param.max !== undefined && param.min > param.max) {
        fail(`${at}.min 不能大于 max`);
      }
      if (param.step !== undefined && param.step <= 0) {
        fail(`${at}.step 必须大于 0`);
      }
    } else if (param.type === "boolean") {
      if (typeof param.default !== "boolean") {
        fail(`${at}.default 必须是布尔值`);
      }
    } else if (param.type === "color") {
      if (typeof param.default !== "string" || !COLOR.test(param.default)) {
        fail(`${at}.default 必须是 #RRGGBB`);
      }
    } else if (param.type === "enum") {
      if (!Array.isArray(param.options) || param.options.length === 0) {
        fail(`${at}.options 必须是非空数组`);
      } else {
        const values = new Set();
        for (const [optionIndex, option] of param.options.entries()) {
          const optionAt = `${at}.options[${optionIndex}]`;
          if (!isObject(option)) {
            fail(`${optionAt} 必须是对象`);
            continue;
          }
          if (typeof option.value !== "string" || option.value === "") {
            fail(`${optionAt}.value 必填`);
          } else if (values.has(option.value)) {
            fail(`${optionAt}.value 重复: ${option.value}`);
          } else {
            values.add(option.value);
          }
          if (typeof option.label !== "string" || option.label === "") {
            fail(`${optionAt}.label 必填`);
          }
        }
        if (typeof param.default !== "string" || !values.has(param.default)) {
          fail(`${at}.default 必须命中 options.value`);
        }
      }
    } else if (typeof param.default !== "string") {
      fail(`${at}.default 必须是字符串`);
    }
  }
}

function checkMetadata(scene, where) {
  if (scene.performance !== undefined) {
    if (!isObject(scene.performance)) {
      fail(`${where}.performance 必须是对象`);
    } else {
      if (!TIERS.has(scene.performance.tier)) {
        fail(`${where}.performance.tier 非法`);
      }
      const fps = scene.performance.targetFps;
      if (
        fps !== undefined &&
        (!Number.isInteger(fps) || fps < 1 || fps > 240)
      ) {
        fail(`${where}.performance.targetFps 必须是 1-240 的整数`);
      }
    }
  }
  if (scene.compatibility !== undefined) {
    if (!isObject(scene.compatibility)) {
      fail(`${where}.compatibility 必须是对象`);
    } else {
      const hostApi = scene.compatibility.hostApi;
      if (!Number.isInteger(hostApi) || hostApi < 1) {
        fail(`${where}.compatibility.hostApi 必须是正整数`);
      }
      const maxHostApi = scene.compatibility.maxHostApi;
      if (
        maxHostApi !== undefined &&
        (!Number.isInteger(maxHostApi) || maxHostApi < hostApi)
      ) {
        fail(`${where}.compatibility.maxHostApi 必须 >= hostApi`);
      }
      if (scene.compatibility.platforms !== undefined) {
        if (
          !Array.isArray(scene.compatibility.platforms) ||
          scene.compatibility.platforms.length === 0
        ) {
          fail(`${where}.compatibility.platforms 必须是非空数组`);
        } else {
          for (const platform of scene.compatibility.platforms) {
            if (!PLATFORMS.has(platform)) {
              fail(`${where}.compatibility.platforms 含未知平台: ${platform}`);
            }
          }
        }
      }
    }
  }
  if (scene.theme !== undefined) {
    if (!isObject(scene.theme)) {
      fail(`${where}.theme 必须是对象`);
    } else {
      for (const key of ["background", "accent"]) {
        if (scene.theme[key] !== undefined && !COLOR.test(scene.theme[key])) {
          fail(`${where}.theme.${key} 必须是 #RRGGBB`);
        }
      }
    }
  }
}

function checkIntegrity(scene, where) {
  const integrity = scene.integrity;
  if (!isObject(integrity)) {
    fail(`${where}.integrity 必填：官方内容目录必须固定包摘要`);
    return;
  }
  for (const key of Object.keys(integrity)) {
    if (!["algorithm", "scope", "digest"].includes(key)) {
      fail(`${where}.integrity 含未知字段: ${key}`);
    }
  }
  if (integrity.algorithm !== "sha256") {
    fail(`${where}.integrity.algorithm 只支持 sha256`);
  }
  if (integrity.scope !== "package") {
    fail(`${where}.integrity.scope 只支持 package`);
  }
  if (
    typeof integrity.digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(integrity.digest)
  ) {
    fail(`${where}.integrity.digest 必须是 64 位小写十六进制`);
    return;
  }
  try {
    const digest = computePackageDigest({
      id: scene.id,
      version: scene.version,
      dir: packageDirFor(scene.entry, contentRoot),
    });
    if (digest !== integrity.digest) {
      fail(
        `${where}.integrity 不匹配（应为 ${digest}；重跑 pnpm content:hash && pnpm content:sign）`,
      );
    }
  } catch (error) {
    fail(`${where}.integrity 计算失败：${error.message}`);
  }
}

const errors = [];
const fail = (message) => errors.push(message);

let catalog;
try {
  catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
} catch (error) {
  console.error(`[content] 无法读取 ${catalogPath}: ${error.message}`);
  process.exit(1);
}

if (catalog.schemaVersion !== 1) {
  fail(`catalog.schemaVersion 必须是 1，实际 ${String(catalog.schemaVersion)}`);
}
if (!Array.isArray(catalog.scenes)) {
  fail("catalog.scenes 必须是数组");
}

const ids = new Set();
for (const [index, scene] of (catalog.scenes ?? []).entries()) {
  const where = `scenes[${index}]`;
  if (typeof scene !== "object" || scene === null || Array.isArray(scene)) {
    fail(`${where} 必须是对象`);
    continue;
  }
  for (const key of Object.keys(scene)) {
    if (!MANIFEST_KEYS.has(key)) fail(`${where} 含未知字段: ${key}`);
  }
  checkParams(scene, where);
  checkMetadata(scene, where);
  if (scene.schemaVersion !== 1) fail(`${where}.schemaVersion 必须是 1`);
  if (scene.type !== "scene") fail(`${where}.type 必须是 "scene"`);
  if (typeof scene.id !== "string" || !ID.test(scene.id)) {
    fail(`${where}.id 缺失或格式非法`);
  } else if (ids.has(scene.id)) {
    fail(`${where}.id 重复: ${scene.id}`);
  } else {
    ids.add(scene.id);
  }
  if (typeof scene.name !== "string" || scene.name.trim() === "") {
    fail(`${where}.name 必填`);
  }
  if (typeof scene.version !== "string" || !VERSION.test(scene.version)) {
    fail(`${where}.version 不是语义化版本`);
  }
  if (typeof scene.license !== "string" || scene.license.trim() === "") {
    fail(`${where}.license 必填`);
  }
  if (!Array.isArray(scene.capabilities) || scene.capabilities.length === 0) {
    fail(`${where}.capabilities 必须是非空数组`);
  } else {
    for (const capability of scene.capabilities) {
      if (!CAPABILITIES.has(capability)) {
        fail(`${where}.capabilities 含未知能力: ${String(capability)}`);
      }
    }
    const hasCapability = (capability) =>
      scene.capabilities.includes(capability);
    // 外部场景只有脚本桥能收到参数/相位；没有 script 就不能声明这两项。
    if (
      !hasCapability("wallpaper.script") &&
      (hasCapability("wallpaper.params") || hasCapability("wallpaper.sync"))
    ) {
      fail(
        `${where}.capabilities: wallpaper.params / wallpaper.sync 必须同时声明 wallpaper.script`,
      );
    }
    if (
      Array.isArray(scene.params) &&
      scene.params.length > 0 &&
      !hasCapability("wallpaper.params")
    ) {
      fail(`${where}.params 需要同时声明 wallpaper.params`);
    }
  }
  if (typeof scene.entry !== "string" || !ENTRY.test(scene.entry)) {
    fail(`${where}.entry 必须是内容根目录内的相对 .html 路径`);
    continue;
  }
  const file = join(contentRoot, scene.entry);
  if (!existsSync(file)) {
    fail(`${where}.entry 指向的文件不存在: ${scene.entry}`);
  }
  checkIntegrity(scene, where);
}

const signaturePath = join(contentRoot, "catalog.sig.json");
if (!existsSync(signaturePath)) {
  fail("缺少 catalog.sig.json：官方内容目录必须签名");
} else {
  try {
    const signature = JSON.parse(readFileSync(signaturePath, "utf8"));
    if (signature.schemaVersion !== 1) {
      fail("catalog.sig.json.schemaVersion 必须是 1");
    }
    if (signature.algorithm !== "ECDSA-P256-SHA256") {
      fail(`catalog.sig.json.algorithm 不支持：${String(signature.algorithm)}`);
    }
    if (
      typeof signature.keyId !== "string" ||
      !/^[a-z0-9][a-z0-9.-]{2,63}$/.test(signature.keyId)
    ) {
      fail("catalog.sig.json.keyId 非法");
    }
    if (
      typeof signature.signature !== "string" ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(signature.signature)
    ) {
      fail("catalog.sig.json.signature 必须是 base64");
    } else {
      const result = verifyCatalogSignature({
        keyId: signature.keyId,
        signature: signature.signature,
        payload: readFileSync(catalogPath),
      });
      if (!result.ok) {
        fail(
          `目录签名无效：${result.reason}（改过 catalog.json 后需重跑 pnpm content:sign）`,
        );
      }
    }
  } catch (error) {
    fail(`catalog.sig.json 解析失败：${error.message}`);
  }
}

if (errors.length > 0) {
  console.error("[content] 校验失败：");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(
  `[content] OK：${catalog.scenes.length} 个外部场景（${[...ids].join(", ")}），摘要与目录签名均有效`,
);
