import { connectLullWidget } from "@lull/widget-sdk";
import { LullProvider, useLullTheme } from "@lull/widget-sdk/react";
import { type ReactNode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { installWidgetBridge, preloadWidgetState } from "./compat";
import { LiquidPomodoro } from "./liquid-pomodoro";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("缺少 #root");
const mount: HTMLElement = rootElement;

/** 宿主下发的主题 token 写到 iframe 文档，玻璃舱的流光随设置变化。 */
function HostSync({ children }: { children: ReactNode }): ReactNode {
  const theme = useLullTheme();
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.flowTheme = theme?.id ?? "";
    for (const [key, value] of Object.entries(theme?.tokens ?? {})) {
      root.style.setProperty(key, value);
    }
  }, [theme]);
  return children;
}

async function boot(): Promise<void> {
  try {
    const lull = await connectLullWidget();
    installWidgetBridge(lull);
    await preloadWidgetState();

    document.documentElement.classList.add("lull-transparent-window");
    // `data-tauri-drag-region` 在 iframe 里不生效，改为显式 startDrag。
    document.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const target = event.target as Element | null;
      if (!target?.closest("[data-tauri-drag-region]")) return;
      if (target.closest("button,a,input,select,textarea")) return;
      void lull.startDrag();
    });

    createRoot(mount).render(
      <LullProvider client={lull}>
        <HostSync>
          <LiquidPomodoro />
        </HostSync>
      </LullProvider>,
    );
  } catch (error) {
    mount.textContent =
      error instanceof Error
        ? `番茄钟加载失败：${error.message}`
        : "番茄钟加载失败";
  }
}

void boot();
