/**
 * 水合守卫：静态导出会把基准语言（zh-CN）写进预渲染 HTML，
 * 而客户端首帧已经是注入的真实语言 —— 直接渲染必然水合不匹配。
 *
 * 做法：首帧只渲染空容器（与预渲染 HTML 一致），挂载后再渲染真实内容。
 * 代价是一帧空白，收益是没有错误语言的闪烁与 React 水合告警。
 */
"use client";

import { type ReactNode, useEffect, useState } from "react";

/** 挂载后才返回 true；用于把「文案相关」的渲染推迟到客户端语言就绪之后。 */
export function useLocaleReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
  }, []);
  return ready;
}

export function LocaleGate({ children }: { children: ReactNode }) {
  const ready = useLocaleReady();
  if (!ready) return null;
  return <>{children}</>;
}
