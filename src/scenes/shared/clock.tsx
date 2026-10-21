"use client";

/**
 * 场景内时钟：只读本地时间，不依赖 Tauri，也不参与同步相位。
 * 壁纸页在客户端就绪后才渲染场景，因此不会产生 hydration 差异。
 */
import { useEffect, useState } from "react";

type SceneClockProps = {
  className?: string;
  style?: React.CSSProperties;
};

export function SceneClock({ className, style }: SceneClockProps) {
  const [clock, setClock] = useState("--:--:--");

  useEffect(() => {
    const update = (): void => {
      setClock(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
    };
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div
      data-testid="scene-clock"
      className={className}
      style={{ fontVariantNumeric: "tabular-nums", ...style }}
    >
      {clock}
    </div>
  );
}
