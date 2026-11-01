/**
 * 官方扩展的 Vite 配置工厂：生产 build 与 dev server 共用一套解析规则。
 *
 * - `@lull/widget-sdk` / `@lull/media-sdk` 解析到 `packages/<pkg>/dist`（与发布物一致）；
 * - `server.fs.allow` 放开仓库根：仓库没有 pnpm workspace，扩展目录之外的文件默认会被挡；
 * - 生产 `base: "./"`，产物由 `lullwidget://` 以相对路径服务；
 * - 关闭 modulePreload polyfill：WebView2 原生支持，避免多余的 inline script。
 */
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const EXTENSION_PORTS = {
  noise: 5273,
  player: 5274,
};

/**
 * `virtual:lull-messages`：把仓库的 i18n 消息表编进扩展包。
 * 运行期由 `setLocale(locale)` 切换；m 是一个按 key 取文案的 Proxy。
 */
function lullMessagesPlugin(repoRoot) {
  const virtualId = "\0virtual:lull-messages";
  return {
    name: "lull-messages",
    resolveId(id) {
      return id === "virtual:lull-messages" ? virtualId : null;
    },
    load(id) {
      if (id !== virtualId) return null;
      const read = (locale) =>
        JSON.parse(
          readFileSync(
            resolve(repoRoot, "i18n", "messages", `${locale}.json`),
            "utf8",
          ),
        );
      const catalogs = {
        "zh-CN": read("zh-CN"),
        "en-US": read("en-US"),
      };
      return `
const catalogs = ${JSON.stringify(catalogs)};
let locale = "zh-CN";
export function setLocale(next) {
  locale = next === "en-US" ? "en-US" : "zh-CN";
}
function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\\{(\\w+)\\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
  );
}
export const m = new Proxy({}, {
  get(_target, key) {
    if (typeof key !== "string") return undefined;
    return (params) => {
      const dict = catalogs[locale] ?? catalogs["zh-CN"];
      const template = dict[key] ?? catalogs["zh-CN"][key] ?? key;
      return interpolate(template, params);
    };
  },
});
`;
    },
    handleHotUpdate(context) {
      if (!context.file.includes("i18n/messages")) return;
      context.server.ws.send({ type: "full-reload" });
    },
  };
}

function sdkAliases(repoRoot) {
  const alias = (pkg, sub = "") => {
    const base = resolve(repoRoot, "packages", pkg, "dist");
    return sub ? `${base}/${sub}.js` : `${base}/index.js`;
  };
  return [
    { find: /^@lull\/widget-sdk$/, replacement: alias("widget-sdk") },
    { find: /^@lull\/widget-sdk\/(.*)$/, replacement: alias("widget-sdk", "$1") },
    { find: /^@lull\/media-sdk$/, replacement: alias("media-sdk") },
    { find: /^@lull\/media-sdk\/(.*)$/, replacement: alias("media-sdk", "$1") },
  ];
}

/**
 * @param {object} options
 * @param {string} options.repoRoot 仓库根目录
 * @param {string} options.extensionDir 扩展源目录（含 widget.json / index.html）
 * @param {string} options.outDir 生产产物目录
 * @param {boolean} [options.serve] 是否 dev server 配置
 * @param {number} [options.port] dev server 端口
 */
export function createExtensionConfig({
  repoRoot,
  extensionDir,
  outDir,
  serve = false,
  port,
}) {
  return {
    configFile: false,
    root: extensionDir,
    base: serve ? "/" : "./",
    publicDir: "public",
    plugins: [react(), lullMessagesPlugin(repoRoot)],
    // 扩展不使用仓库根的 Tailwind PostCSS 配置；显式清空，避免 Vite 向上查找。
    css: { postcss: { plugins: [] } },
    resolve: {
      alias: sdkAliases(repoRoot),
      dedupe: ["react", "react-dom"],
    },
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
      // 插件 iframe 是 sandbox="allow-scripts"，origin 为 `null`；
      // Vite 默认只回显 localhost origin，会导致模块脚本被浏览器 CORS 拦截。
      cors: true,
      fs: { allow: [repoRoot] },
      hmr: { protocol: "ws" },
    },
    build: {
      outDir,
      // 由调用方先清空，避免 Vite 对 root 之外目录的 emptyOutDir 限制。
      emptyOutDir: false,
      target: "es2022",
      sourcemap: false,
      modulePreload: { polyfill: false },
    },
    clearScreen: false,
  };
}
