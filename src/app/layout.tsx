/**
 * 应用根布局：挂载全局字体与样式，只定义全站 HTML/body 骨架，不包含控制窗主题外壳。
 *
 * 字体全部来自仓库内 `src/assets/fonts`（见 globals.css 的 @font-face），
 * 不依赖构建期下载 Google Fonts —— 离线与内网构建应完全可复现。
 */
import { NativeUiGuard } from "@/components/native-ui-guard";
import "@/styles/globals.css";

// 根布局保持极简：只有 html/body 与字体。花笺主题外壳（ThemeProvider / ThemeSwitcher /
// Toaster / 纸纹背景）只属于控制面窗口，见 (control)/layout.tsx —— 壁纸页不应带这些。
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="font-body antialiased">
        {/* 关闭 WebView 系统右键菜单；文本选择由 globals.css 全局禁用 */}
        <NativeUiGuard />
        {children}
      </body>
    </html>
  );
}
