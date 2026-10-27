/** 版块之间的细分隔线（原 `.rule`）：两端渐隐，不做满宽硬线 */
export default function Rule() {
  return (
    <hr className="m-0 h-px border-0 bg-[linear-gradient(90deg,transparent,var(--color-line-strong)_20%,var(--color-line-strong)_80%,transparent)]" />
  );
}
