/**
 * 曲目封面：用 SVG 现绘的天空 / 山脊 / 水面。
 * 同一张封面在 300px 的主球里作为内嵌透镜画面，也在列表里缩成 38px 缩略图；
 * 不依赖任何图片资源，本地文件也能根据文件名稳定映射到一组封面色。
 */
import { useId } from "react";
import { type CoverPalette, coverPalette } from "./player-model";

const STARS = [
  [24, 36, 1.1, 0.75],
  [48, 58, 0.8, 0.5],
  [72, 28, 1.3, 0.62],
  [96, 72, 0.7, 0.4],
  [120, 42, 1, 0.65],
  [146, 22, 0.7, 0.38],
  [170, 66, 1.2, 0.55],
  [194, 34, 0.8, 0.45],
  [218, 56, 0.65, 0.35],
  [242, 26, 1.1, 0.6],
  [264, 74, 0.75, 0.4],
  [286, 46, 0.9, 0.5],
  [36, 92, 0.55, 0.3],
  [138, 86, 0.6, 0.28],
] as const;

const SCENES = [
  {
    far: "M0 188 L22 168 L44 176 L70 147 L96 169 L120 158 L147 174 L170 151 L198 171 L226 149 L252 168 L278 158 L300 174 L300 232 L0 232 Z",
    mid: "M0 204 L30 185 L58 195 L88 173 L116 191 L146 181 L176 198 L204 178 L236 194 L264 184 L300 198 L300 242 L0 242 Z",
    near: "M0 226 L34 210 L68 218 L102 199 L136 214 L168 204 L202 220 L238 206 L272 216 L300 208 L300 300 L0 300 Z",
    water: 216,
  },
  {
    far: "M0 180 C48 156 90 164 132 150 C176 136 214 154 252 146 C274 142 288 148 300 144 L300 232 L0 232 Z",
    mid: "M0 205 C46 186 92 196 136 181 C180 166 224 188 264 176 C282 171 292 176 300 173 L300 246 L0 246 Z",
    near: "M0 235 C54 214 104 224 150 209 C196 194 244 216 300 198 L300 300 L0 300 Z",
    water: 222,
  },
  {
    far: "M0 174 L34 150 L58 170 L90 138 L118 164 L152 142 L184 168 L218 146 L248 166 L278 152 L300 162 L300 232 L0 232 Z",
    mid: "M0 200 L22 180 L48 194 L82 170 L110 190 L146 176 L180 198 L214 180 L244 196 L278 182 L300 192 L300 248 L0 248 Z",
    near: "M0 228 L28 214 L62 224 L96 206 L132 222 L166 210 L200 228 L234 214 L270 226 L300 216 L300 300 L0 300 Z",
    water: 218,
  },
] as const;

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function CoverArt({
  tone,
  className,
}: {
  tone: number;
  className?: string;
}): React.ReactElement {
  const rawId = useId();
  const uid = safeId(rawId);
  const palette: CoverPalette = coverPalette(tone);
  const scene = SCENES[Math.abs(Math.trunc(tone)) % SCENES.length] ?? SCENES[0];
  const skyId = `sky-${uid}`;
  const sunId = `sun-${uid}`;
  const waterId = `water-${uid}`;
  const vignetteId = `vignette-${uid}`;
  const blurId = `blur-${uid}`;
  const horizon = scene.water;

  return (
    <svg
      viewBox="0 0 300 300"
      className={className}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={skyId} x1="0.16" y1="0" x2="0.72" y2="1">
          <stop offset="0%" stopColor={palette.skyTop} />
          <stop offset="52%" stopColor={palette.skyMid} />
          <stop offset="100%" stopColor={palette.skyBottom} />
        </linearGradient>
        <radialGradient id={sunId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={palette.sunGlow} />
          <stop offset="52%" stopColor={palette.sunGlow} stopOpacity="0.28" />
          <stop offset="100%" stopColor={palette.sunGlow} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={waterId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={palette.waterLight} stopOpacity="0.42" />
          <stop offset="42%" stopColor={palette.water} />
          <stop offset="100%" stopColor={palette.near} />
        </linearGradient>
        <radialGradient id={vignetteId} cx="50%" cy="44%" r="72%">
          <stop offset="55%" stopColor="#020812" stopOpacity="0" />
          <stop offset="100%" stopColor="#020812" stopOpacity="0.5" />
        </radialGradient>
        <filter id={blurId} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="10" />
        </filter>
      </defs>

      <rect width="300" height="300" fill={`url(#${skyId})`} />
      <ellipse
        cx={palette.sunX}
        cy={palette.sunY}
        rx={92}
        ry={82}
        fill={`url(#${sunId})`}
      />

      {palette.night ? (
        <g fill={palette.sun}>
          {STARS.map(([x, y, radius, opacity]) => (
            <circle
              key={`${x}-${y}`}
              cx={x}
              cy={y}
              r={radius}
              opacity={opacity}
            />
          ))}
        </g>
      ) : null}

      {palette.aurora ? (
        <g fill="none" strokeLinecap="round" filter={`url(#${blurId})`}>
          <path
            d="M-24 86 C46 36 104 116 178 62 C228 26 282 48 328 92"
            stroke={palette.accent}
            strokeWidth="18"
            opacity="0.17"
          />
          <path
            d="M-12 120 C58 82 122 142 190 96 C240 62 286 78 322 112"
            stroke={palette.waterLight}
            strokeWidth="8"
            opacity="0.15"
          />
        </g>
      ) : null}

      <circle
        cx={palette.sunX}
        cy={palette.sunY}
        r={palette.sunR}
        fill={palette.sun}
        opacity="0.96"
      />
      <circle
        cx={palette.sunX}
        cy={palette.sunY}
        r={palette.sunR + 8}
        fill="none"
        stroke={palette.sun}
        strokeWidth="0.7"
        opacity="0.3"
      />

      <g filter={`url(#${blurId})`} opacity="0.42">
        <ellipse
          cx={palette.sunX - 22}
          cy={palette.sunY + 28}
          rx="82"
          ry="8"
          fill={palette.sun}
          opacity="0.2"
        />
        <ellipse
          cx="96"
          cy={horizon - 88}
          rx="70"
          ry="7"
          fill="#ffffff"
          opacity="0.12"
        />
        <ellipse
          cx="220"
          cy={horizon - 122}
          rx="54"
          ry="5"
          fill={palette.accent}
          opacity="0.13"
        />
      </g>

      <ellipse
        cx="154"
        cy={horizon - 6}
        rx="170"
        ry="20"
        fill={palette.sunGlow}
        opacity="0.14"
        filter={`url(#${blurId})`}
      />

      <path d={scene.far} fill={palette.far} opacity="0.74" />
      <path d={scene.mid} fill={palette.mid} opacity="0.94" />
      <path d={scene.near} fill={palette.near} />
      <rect
        x="0"
        y={horizon - 1}
        width="300"
        height="1"
        fill={palette.waterLight}
        opacity="0.22"
      />

      <rect
        x="0"
        y={horizon}
        width="300"
        height={300 - horizon}
        fill={`url(#${waterId})`}
      />
      <g opacity="0.58">
        <rect
          x={palette.sunX - 16}
          y={horizon + 4}
          width="32"
          height="1.2"
          rx="0.6"
          fill={palette.waterLight}
        />
        <rect
          x={palette.sunX - 30}
          y={horizon + 14}
          width="60"
          height="1"
          rx="0.5"
          fill={palette.waterLight}
          opacity="0.72"
        />
        <rect
          x={palette.sunX - 44}
          y={horizon + 26}
          width="88"
          height="0.9"
          rx="0.45"
          fill={palette.waterLight}
          opacity="0.5"
        />
        <rect
          x={palette.sunX - 58}
          y={horizon + 42}
          width="116"
          height="0.8"
          rx="0.4"
          fill={palette.waterLight}
          opacity="0.3"
        />
      </g>
      <g stroke={palette.waterLight} strokeWidth="0.6" opacity="0.22">
        <path d={`M18 ${horizon + 18} H96`} />
        <path d={`M212 ${horizon + 30} H286`} />
        <path d={`M48 ${horizon + 48} H142`} />
        <path d={`M176 ${horizon + 62} H266`} />
      </g>

      <rect width="300" height="300" fill={`url(#${vignetteId})`} />
    </svg>
  );
}
