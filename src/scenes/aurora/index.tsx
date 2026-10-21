"use client";

/**
 * 极光（aurora）：深蓝夜空 + 三条错落光带。
 * “铺满全屏”是硬要求：近黑底必须铺满，光带只做层次，避免画面浮在黑幕上。
 */
import type { CSSProperties, ReactNode } from "react";
import { canvasFont, canvasSize, delay } from "@/scenes/shared/anim";
import { SceneClock } from "@/scenes/shared/clock";
import type { SceneProps } from "@/sdk/scene";

const BANDS = [
  {
    id: "band-a",
    cls: "left-[6%] top-[16%] h-[36%] w-[88%] animate-wp-drift-b",
    durationS: 17,
    color:
      "linear-gradient(90deg, rgba(96,235,200,.60), rgba(120,110,255,.50))",
    opacity: 0.75,
    rect: { l: 0.06, t: 0.16, w: 0.88, h: 0.36 },
    drift: { fx: 0.02, fy: 0.01, tx: 0.06, ty: 0.03 },
  },
  {
    id: "band-b",
    cls: "left-[24%] top-[46%] h-[30%] w-[70%] animate-wp-drift-a",
    durationS: 13,
    color:
      "linear-gradient(90deg, rgba(140,120,255,.45), rgba(90,170,255,.40))",
    opacity: 0.55,
    rect: { l: 0.24, t: 0.46, w: 0.7, h: 0.3 },
    drift: { fx: 0.05, fy: 0.03, tx: 0.01, ty: 0.06 },
  },
  {
    id: "band-c",
    cls: "left-[-5%] top-[70%] h-[30%] w-[110%] animate-wp-drift-c",
    durationS: 11,
    color: "linear-gradient(90deg, rgba(80,220,180,.35), rgba(80,220,180,.05))",
    opacity: 0.45,
    rect: { l: -0.05, t: 0.7, w: 1.1, h: 0.3 },
    drift: { fx: 0.03, fy: 0.01, tx: -0.02, ty: 0.04 },
  },
] as const;

const STARS = [
  [6, 12],
  [13, 22],
  [21, 9],
  [29, 17],
  [38, 6],
  [46, 20],
  [54, 11],
  [63, 24],
  [71, 8],
  [79, 18],
  [88, 13],
  [94, 26],
  [34, 29],
  [57, 31],
] as const;

export function AuroraScene({ layout, sync, canvas }: SceneProps): ReactNode {
  const isCanvas = layout === "canvas";
  const { w, h } = canvasSize(canvas);
  const wordmarkSize = isCanvas ? canvasFont(canvas, 38) : 38;
  const clockSize = isCanvas ? canvasFont(canvas, 84) : 84;

  return (
    <div
      data-testid="scene-aurora"
      className="absolute inset-0 overflow-hidden"
    >
      <div className="absolute inset-0 bg-[linear-gradient(165deg,#07131f_0%,#0d2338_40%,#081827_75%,#040b14_100%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(1000px_620px_at_18%_82%,rgba(60,120,150,0.16),transparent_70%)]" />
      {STARS.map(([x, y]) => (
        <span
          key={`${x}-${y}`}
          className="absolute size-px rounded-full bg-[#d9e9ff]"
          style={{
            left: `${x}%`,
            top: `${y}%`,
            opacity: 0.2 + ((x * 11 + y * 7) % 45) / 100,
          }}
        />
      ))}
      {BANDS.map((band) => (
        <div
          key={band.id}
          data-testid={band.id}
          className={`absolute rounded-full blur-[80px] ${
            isCanvas ? "wp-canvas-drift" : band.cls
          }`}
          style={{
            opacity: band.opacity,
            backgroundImage: band.color,
            ...(isCanvas
              ? ({
                  width: w * band.rect.w,
                  height: h * band.rect.h,
                  left: w * band.rect.l,
                  top: h * band.rect.t,
                  "--wp-from-x": `${w * band.drift.fx}px`,
                  "--wp-from-y": `${h * band.drift.fy}px`,
                  "--wp-to-x": `${w * band.drift.tx}px`,
                  "--wp-to-y": `${h * band.drift.ty}px`,
                  animationDuration: `${band.durationS}s`,
                  animationDelay: delay(band.durationS * 1000, sync),
                } as CSSProperties)
              : { animationDelay: delay(band.durationS * 1000, sync) }),
          }}
        />
      ))}
      {/* 地平线雾光：让光带落回“夜空”而不是悬空 */}
      <div className="absolute inset-x-0 bottom-0 h-[26%] bg-[linear-gradient(0deg,rgba(6,14,22,0.85),transparent)]" />

      <div
        className="absolute"
        style={
          isCanvas ? { left: 48, top: 44 } : { left: "3rem", top: "2.75rem" }
        }
      >
        <div
          className="font-sans uppercase tracking-[0.42em] text-[#cfe3f2]"
          style={{ fontSize: wordmarkSize, opacity: 0.9 }}
        >
          LULL
        </div>
        <SceneClock
          className="font-light tracking-[0.06em] text-[#eef6ff]"
          style={{ fontSize: clockSize, marginTop: 12, lineHeight: 1.05 }}
        />
        <div
          className="font-serif tracking-[0.18em] text-[#c3d8e6]"
          style={{
            fontSize: isCanvas ? canvasFont(canvas, 20) : 20,
            marginTop: 18,
            opacity: 0.84,
          }}
        >
          极光之下，慢慢呼吸
        </div>
        <div
          className="font-sans tracking-[0.3em] text-[#8fa7b8]"
          style={{ fontSize: 12, marginTop: 12, opacity: 0.8 }}
        >
          极光 · 长夜 · 星野
        </div>
      </div>
    </div>
  );
}
