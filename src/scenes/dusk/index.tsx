"use client";

/**
 * 暮色（dusk）：收工后的暖调天光。
 * 与竹影的冷绿夜色互补，适合傍晚与睡前过渡；文字同样只做安静陪伴。
 */
import type { ReactNode } from "react";
import { canvasFont, delay } from "@/scenes/shared/anim";
import { SceneClock } from "@/scenes/shared/clock";
import { MountainRange } from "@/scenes/shared/mountains";
import type { SceneProps } from "@/sdk/scene";

const CLOUDS = [
  { top: "22%", left: "-8%", width: "72%", duration: 26, opacity: 0.3 },
  { top: "34%", left: "28%", width: "88%", duration: 34, opacity: 0.22 },
  { top: "12%", left: "52%", width: "60%", duration: 30, opacity: 0.18 },
] as const;

export function DuskScene({ layout, sync, canvas }: SceneProps): ReactNode {
  const isCanvas = layout === "canvas";
  const wordmarkSize = isCanvas ? canvasFont(canvas, 38) : 38;
  const clockSize = isCanvas ? canvasFont(canvas, 84) : 84;

  return (
    <div
      data-testid="scene-dusk"
      className="absolute inset-0 overflow-hidden bg-[#1b1520] font-serif text-[#f6e7d8]"
    >
      <div className="absolute inset-0 bg-[linear-gradient(168deg,#2a2038_0%,#4a3040_34%,#8a5148_62%,#c18463_82%,#e0ad83_100%)]" />
      {/* 落日 */}
      <div
        data-testid="dusk-sun"
        className="lull-breath absolute bottom-[20%] left-[16%] size-[22vmin] rounded-full bg-[radial-gradient(circle,rgba(255,224,184,0.92),rgba(255,176,120,0.38)_45%,rgba(255,150,100,0)_72%)] blur-[2px]"
        style={{ animationDuration: "12s", animationDelay: delay(12000, sync) }}
      />
      {/* 云带 */}
      {CLOUDS.map((cloud) => (
        <div
          key={cloud.top}
          className="lull-mist absolute h-[6%] rounded-full bg-[linear-gradient(90deg,transparent,rgba(255,222,196,0.5),transparent)] blur-[22px]"
          style={{
            top: cloud.top,
            left: cloud.left,
            width: cloud.width,
            opacity: cloud.opacity,
            animationDuration: `${cloud.duration}s`,
            animationDelay: delay(cloud.duration * 1000, sync),
          }}
        />
      ))}
      {/* 层叠远山 */}
      <MountainRange
        variant="dusk"
        className="absolute inset-x-0 bottom-0 h-[54%] w-full"
        opacity={0.9}
      />
      <div className="absolute inset-x-0 bottom-0 h-[18%] bg-[linear-gradient(0deg,rgba(20,14,22,0.72),transparent)]" />

      <div
        className="absolute"
        style={
          isCanvas ? { left: 48, top: 44 } : { left: "3rem", top: "2.75rem" }
        }
      >
        <div
          className="font-sans uppercase tracking-[0.42em] text-[#f3ddc8]"
          style={{ fontSize: wordmarkSize, opacity: 0.9 }}
        >
          LULL
        </div>
        <SceneClock
          className="font-light tracking-[0.06em] text-[#fff3e4]"
          style={{ fontSize: clockSize, marginTop: 12, lineHeight: 1.05 }}
        />
        <div
          className="font-serif tracking-[0.18em] text-[#f0d6c0]"
          style={{
            fontSize: isCanvas ? canvasFont(canvas, 20) : 20,
            marginTop: 18,
            opacity: 0.86,
          }}
        >
          把今天轻轻放下
        </div>
        <div
          className="font-sans tracking-[0.3em] text-[#d8b39d]"
          style={{ fontSize: 12, marginTop: 12, opacity: 0.82 }}
        >
          暮色 · 归鸟 · 晚风
        </div>
      </div>
    </div>
  );
}
