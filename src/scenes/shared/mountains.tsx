/**
 * 场景共用的远山剪影：用归一化 viewBox 保证在视口与跨屏画布中都能等比铺开。
 */
type MountainRangeProps = {
  variant: "bamboo" | "dusk" | "mist";
  className?: string;
  opacity?: number;
};

const PATHS: Record<MountainRangeProps["variant"], string[]> = {
  bamboo: [
    "M0 78 L12 66 L22 72 L36 52 L48 62 L62 44 L76 60 L88 54 L100 70 L100 100 L0 100 Z",
    "M0 88 L14 78 L28 84 L42 72 L58 82 L72 68 L86 80 L100 74 L100 100 L0 100 Z",
  ],
  dusk: [
    "M0 70 L10 62 L20 68 L34 48 L46 58 L60 40 L74 56 L88 50 L100 64 L100 100 L0 100 Z",
    "M0 84 L16 74 L30 82 L44 70 L60 80 L76 66 L90 78 L100 72 L100 100 L0 100 Z",
  ],
  mist: [
    "M0 74 L14 64 L26 70 L40 56 L54 66 L68 50 L84 62 L100 58 L100 100 L0 100 Z",
    "M0 90 L18 82 L34 88 L50 78 L66 86 L82 76 L100 84 L100 100 L0 100 Z",
  ],
};

const FILLS: Record<MountainRangeProps["variant"], string[]> = {
  bamboo: ["rgba(9, 24, 24, 0.78)", "rgba(5, 15, 16, 0.92)"],
  dusk: ["rgba(54, 32, 44, 0.72)", "rgba(30, 18, 28, 0.9)"],
  mist: ["rgba(40, 58, 62, 0.55)", "rgba(20, 34, 38, 0.72)"],
};

export function MountainRange({
  variant,
  className,
  opacity = 1,
}: MountainRangeProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ opacity }}
    >
      {PATHS[variant].map((d, index) => (
        <path key={d} d={d} fill={FILLS[variant][index]} />
      ))}
    </svg>
  );
}
