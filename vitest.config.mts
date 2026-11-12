/**
 * Vitest 配置：启用 jsdom、React 支持和项目路径别名，统一前端单元测试环境。
 * CSS Modules 解析为轻量代理，避免测试启动时加载 Tailwind 原生 PostCSS 依赖。
 * `virtual:lull-messages` 由扩展的 Vite 配置在构建期注入，这里给一份同形状的桩，
 * 让直接渲染扩展组件的用例也能跑。
 */
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const cssModuleMock = {
  name: "ether-css-module-mock",
  enforce: "pre" as const,
  resolveId(source: string) {
    return source.endsWith(".module.css") ? "\0css-module-mock" : null;
  },
  load(id: string) {
    if (id !== "\0css-module-mock") return null;
    return "const styles = new Proxy({}, { get: (_target, key) => String(key) });\nexport default styles;";
  },
};

/** 扩展组件里的 `m.xxx()`：任何 key 都回一条不会崩的占位文案。 */
const lullMessagesMock = {
  name: "lull-messages-mock",
  enforce: "pre" as const,
  resolveId(source: string) {
    return source === "virtual:lull-messages" ? "\0lull-messages-mock" : null;
  },
  load(id: string) {
    if (id !== "\0lull-messages-mock") return null;
    return [
      'const message = () => "文案";',
      "export const m = new Proxy({}, { get: () => message });",
      "export function setLocale() {}",
    ].join("\n");
  },
};

export default defineConfig({
  plugins: [cssModuleMock, lullMessagesMock, tsconfigPaths(), react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
  },
});
