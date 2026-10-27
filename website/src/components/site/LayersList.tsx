export interface Layer {
  name: string;
  body: string;
}

/** 四层架构清单（原 `.layers` / `.layer`）：左侧层名 + 圆点，右侧一句话职责 */
export default function LayersList({ items }: { items: Layer[] }) {
  return (
    <div className="grid gap-2.5">
      {items.map((layer) => (
        <div
          key={layer.name}
          className="grid grid-cols-[148px_minmax(0,1fr)] items-baseline gap-5 rounded-[14px] border border-line bg-ghost px-[22px] py-[18px] max-[720px]:grid-cols-1 max-[720px]:gap-1.5"
        >
          <div className="flex items-center gap-2.5 text-[0.92rem] text-mist">
            <span className="size-1.5 flex-none rounded-full bg-green" aria-hidden="true" />
            {layer.name}
          </div>
          <p className="m-0 text-[0.9rem] text-muted">{layer.body}</p>
        </div>
      ))}
    </div>
  );
}
