import { setLocale } from "virtual:lull-messages";
import { createWidgetMediaClient } from "@lull/media-sdk/widget";
import { connectLullWidget } from "@lull/widget-sdk";
import {
  LullProvider,
  useLullLocale,
  useLullTheme,
} from "@lull/widget-sdk/react";
import { type ReactNode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  createDemoWidgetClient,
  installNoiseBridge,
  preloadNoiseState,
} from "./compat";
import { EtherBubbles } from "./ether-bubbles";
import "./global.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("缺少 #root");
const mount: HTMLElement = rootElement;

/** 把宿主下发的语言/主题 token 同步到 iframe 文档，并在变化时重渲染子树。 */
function HostSync({ children }: { children: ReactNode }): ReactNode {
  const locale = useLullLocale();
  const theme = useLullTheme();
  setLocale(locale);
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
    const media = createWidgetMediaClient({
      request: (method, params) =>
        lull.request(method as never, params as never),
      onMediaEvent: (listener) => lull.onMediaEvent(listener),
    });
    installNoiseBridge(lull, media);
    await preloadNoiseState();

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
          <EtherBubbles />
        </HostSync>
      </LullProvider>,
    );
  } catch {
    // 非宿主 iframe（独立预览/单测）：用内存桩渲染演示态，便于查看与截图。
    createRoot(mount).render(
      <LullProvider client={createDemoWidgetClient()}>
        <HostSync>
          <EtherBubbles />
        </HostSync>
      </LullProvider>,
    );
  }
}

void boot();
