/**
 * Next.js 构建配置：生成供 Tauri 嵌入的静态前端，并关闭服务端图片优化。
 */
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "export",
  // 无头预览 / Tauri WebView 会用 127.0.0.1 访问 dev server；Next 16 默认拦截
  // 跨来源的 HMR 资源，显式放行本地回环地址，避免客户端脚本被 403 拦截。
  allowedDevOrigins: ["127.0.0.1"],
  // 应用窗口本身已经有完整视觉，开发态指示器会破坏沉浸式界面（也会出现在截图里）。
  devIndicators: false,
  images: {
    unoptimized: true,
  },
  distDir: "dist",
};

export default nextConfig;
