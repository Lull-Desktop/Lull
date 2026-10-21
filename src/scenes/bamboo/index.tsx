"use client";

/**
 * 竹影（bamboo）：Lull 的默认场景。
 *
 * 深夜竹林 + 薄雾 + 远山 + 缓慢摆动的竹竿；文字只作为安静的陪伴，
 * 不做任何提示或交互。跨屏模式下所有位置都按画布比例计算。
 */
import type { ReactNode } from "react";
import { canvasFont, canvasSize, delay } from "@/scenes/shared/anim";
import { SceneClock } from "@/scenes/shared/clock";
import { MountainRange } from "@/scenes/shared/mountains";
import type { SceneProps } from "@/sdk/scene";

type Stalk = {
  left: string;
  width: number;
  height: string;
  opacity: number;
  duration: number;
  delay: number;
  hue: string;
};

const STALKS: Stalk[] = [
  {
    left: "4%",
    width: 10,
    height: "86%",
    opacity: 0.7,
    duration: 11,
    delay: -2,
    hue: "#6f8f6a",
  },
  {
    left: "11%",
    width: 5,
    height: "62%",
    opacity: 0.45,
    duration: 9,
    delay: -5,
    hue: "#58775b",
  },
  {
    left: "17%",
    width: 3,
    height: "48%",
    opacity: 0.35,
    duration: 13,
    delay: -1,
    hue: "#4e6a51",
  },
  {
    left: "84%",
    width: 8,
    height: "78%",
    opacity: 0.6,
    duration: 12,
    delay: -6,
    hue: "#647f60",
  },
  {
    left: "91%",
    width: 4,
    height: "56%",
    opacity: 0.4,
    duration: 10,
    delay: -3,
    hue: "#526d54",
  },
  {
    left: "96%",
    width: 2.5,
    height: "42%",
    opacity: 0.3,
    duration: 14,
    delay: -8,
    hue: "#466049",
  },
];

const STARS = [
  [8, 14],
  [16, 8],
  [24, 22],
  [33, 11],
  [41, 18],
  [52, 7],
  [61, 16],
  [69, 10],
  [77, 21],
  [86, 13],
  [93, 24],
  [29, 31],
  [57, 28],
] as const;

export function BambooScene({
  layout,
  sync,
  canvas,
  params,
}: SceneProps): ReactNode {
  const isCanvas = layout === "canvas";
  const { w, h } = canvasSize(canvas);
  const mist = typeof params.mist === "number" ? params.mist : 0.5;
  const mistOpacity = 0.35 + mist * 0.65;
  const wordmarkSize = isCanvas ? canvasFont(canvas, 40) : 40;
  const clockSize = isCanvas ? canvasFont(canvas, 88) : 88;
  const subtitleSize = isCanvas ? canvasFont(canvas, 20) : 20;

  return (
    <div
      data-testid="scene-bamboo"
      className="absolute inset-0 overflow-hidden bg-[#07110f] font-serif text-[#e9efe4]"
    >
      {/* 夜色底：深青绿到近乎黑，保证长时间亮屏不刺眼。 */}
      <div className="absolute inset-0 bg-[radial-gradient(1200px_820px_at_78%_8%,rgba(184,214,181,0.16),transparent_62%),radial-gradient(900px_700px_at_16%_86%,rgba(36,78,64,0.42),transparent_70%),linear-gradient(158deg,#0a1714_0%,#0b1d18_45%,#06100e_100%)]" />

      {/* 月晕 */}
      <div
        data-testid="bamboo-moon"
        className="absolute right-[10%] top-[8%] size-[18vmin] rounded-full bg-[radial-gradient(circle,rgba(232,241,219,0.72),rgba(232,241,219,0.18)_42%,rgba(232,241,219,0)_70%)] blur-[6px] lull-breath"
        style={{ animationDelay: delay(9000, sync) }}
      />

      {/* 星点 */}
      {STARS.map(([x, y]) => (
        <span
          key={`${x}-${y}`}
          className="absolute size-px rounded-full bg-[#dcead8]"
          style={{
            left: `${x}%`,
            top: `${y}%`,
            opacity: 0.22 + ((x * 7 + y * 13) % 40) / 100,
          }}
        />
      ))}

      {/* 远山：两层剪影制造纵深 */}
      <MountainRange
        variant="bamboo"
        className="absolute inset-x-0 bottom-0 h-[58%] w-full"
        opacity={0.85}
      />

      {/* 薄雾：按元素自身宽度平移，视口与跨屏画布都不会跑出画面 */}
      <div
        className="lull-mist absolute inset-x-[-10%] top-[54%] h-[18%] bg-[linear-gradient(90deg,transparent,rgba(190,214,198,0.14),transparent)] blur-[26px]"
        style={{ opacity: mistOpacity }}
      />
      <div
        className="lull-mist absolute inset-x-[-16%] top-[68%] h-[14%] bg-[linear-gradient(90deg,transparent,rgba(160,196,178,0.11),transparent)] blur-[30px]"
        style={{
          animationDuration: "31s",
          animationDirection: "reverse",
          opacity: mistOpacity,
        }}
      />

      {/* 竹竿与竹叶 */}
      {STALKS.map((stalk, index) => (
        <div
          key={stalk.left}
          data-testid={`bamboo-stalk-${index}`}
          className="lull-sway absolute bottom-[-6%] rounded-full"
          style={{
            left: stalk.left,
            width: stalk.width,
            height: stalk.height,
            opacity: stalk.opacity,
            backgroundImage: `linear-gradient(90deg, ${stalk.hue}00, ${stalk.hue} 32%, #b7c9a8 50%, ${stalk.hue} 68%, ${stalk.hue}00)`,
            animationDuration: `${stalk.duration}s`,
            animationDelay: `${stalk.delay}s`,
          }}
        >
          {[18, 38, 62, 82].map((top, leafIndex) => (
            <span
              key={top}
              className="absolute block h-px rounded-full bg-[#a9bf9b]"
              style={{
                top: `${top}%`,
                left: leafIndex % 2 === 0 ? "52%" : "-46%",
                width: `${26 + leafIndex * 7}px`,
                transform: `rotate(${leafIndex % 2 === 0 ? -26 : 24}deg)`,
                opacity: 0.36,
              }}
            />
          ))}
        </div>
      ))}

      {/* 时间与文案 */}
      <div
        className="absolute"
        style={
          isCanvas ? { left: 48, top: 44 } : { left: "3rem", top: "2.75rem" }
        }
      >
        <div
          className="font-sans uppercase tracking-[0.42em] text-[#c7d6bf]"
          style={{ fontSize: wordmarkSize, opacity: 0.9 }}
        >
          LULL
        </div>
        <SceneClock
          className="font-light tracking-[0.06em] text-[#f0f4e9]"
          style={{ fontSize: clockSize, marginTop: 12, lineHeight: 1.05 }}
        />
        <div
          className="font-serif tracking-[0.18em] text-[#c3d2bb]"
          style={{ fontSize: subtitleSize, marginTop: 18, opacity: 0.82 }}
        >
          云栖之处，安然入眠
        </div>
        <div
          className="font-sans tracking-[0.3em] text-[#8fa38a]"
          style={{ fontSize: 12, marginTop: 12, opacity: 0.8 }}
        >
          竹影 · 山风 · 远处磬声
        </div>
      </div>

      {/* 跨屏接缝之外的角落标记，便于真机确认窗口/画布对应关系 */}
      {isCanvas && (
        <div className="absolute bottom-4 right-5 font-sans text-[10px] tracking-[0.2em] text-[#8fa38a]/70">
          {w}×{h} · CANVAS
        </div>
      )}
    </div>
  );
}
