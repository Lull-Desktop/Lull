/**
 * 原生交互收敛：关闭 WebView 自带的右键菜单。
 * 文本选择（全选 / 框选）由 globals.css 的 user-select 统一关闭，这里只拦右键。
 */
"use client";

import { useEffect } from "react";

export function NativeUiGuard() {
  useEffect(() => {
    // 捕获阶段拦截：确保在 WebView2 弹出原生菜单之前取消默认行为。
    const blockContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
    };
    document.addEventListener("contextmenu", blockContextMenu, true);
    return () => {
      document.removeEventListener("contextmenu", blockContextMenu, true);
    };
  }, []);

  return null;
}
