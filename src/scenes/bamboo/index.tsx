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

const MIST_BANDS = [
  {
    top: 54,
    height: 18,
    alpha: 0.5,
    delayMs: 24000,
    duration: "26s",
    reverse: false,
  },
  {
    top: 68,
    height: 14,
    alpha: 0.42,
    delayMs: 31000,
    duration: "31s",
    reverse: true,
  },
  {
    top: 79,
    height: 11,
    alpha: 0.34,
    delayMs: 19000,
    duration: "23s",
    reverse: false,
  },
] as const;

export function BambooScene({
  layout,
  sync,
  canvas,
  params,
}: SceneProps): ReactNode {
  const isCanvas = layout === "canvas";
  const { w, h } = canvasSize(canvas);
  // 雾浓度：0 = 无雾，1 = 最浓。直接作为各层不透明度，避免默认值叠出「看起来没反应」。
  const rawMist = typeof params.mist === "number" ? params.mist : 0.5;
  const mist = Math.min(1, Math.max(0, rawMist));
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

      {/* 薄雾：整屏雾幔 + 三层带状雾。
          不透明度直接等于 mist（0 = 完全不画），浓度越高雾层越厚、越亮，
          这样滑到 0 与 1 的差别是肉眼可辨的，而不是「感觉没生效」。 */}
      <div
        data-testid="bamboo-mist-veil"
        className="absolute inset-0 bg-[linear-gradient(180deg,transparent_32%,rgba(198,218,203,0.34)_56%,rgba(178,204,190,0.16)_100%)]"
        style={{ opacity: mist * 0.62 }}
      />
      {MIST_BANDS.map((band) => (
        <div
          key={band.top}
          data-testid={`bamboo-mist-band-${band.top}`}
          className="lull-mist absolute inset-x-[-10%] bg-[linear-gradient(90deg,transparent,rgba(214,230,216,0.55),transparent)] blur-[26px]"
          style={{
            top: `${band.top}%`,
            height: `${band.height + mist * 6}%`,
            opacity: mist * band.alpha,
            animationDelay: delay(band.delayMs, sync),
            animationDuration: band.duration,
            animationDirection: band.reverse ? "reverse" : undefined,
          }}
        />
      ))}

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
            animationDelay:
              delay(stalk.duration * 1000, sync) ?? `${stalk.delay}s`,
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
