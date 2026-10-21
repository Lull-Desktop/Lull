/**
 * Vitest 配置：启用 jsdom、React 支持和项目路径别名，统一前端单元测试环境。
 * CSS Modules 解析为轻量代理，避免测试启动时加载 Tailwind 原生 PostCSS 依赖。
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

export default defineConfig({
  plugins: [cssModuleMock, tsconfigPaths(), react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
  },
});
