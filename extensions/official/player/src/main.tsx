import { connectLullWidget } from "@lull/widget-sdk";
import {
  LullProvider,
  useLullLocale,
  useLullTheme,
} from "@lull/widget-sdk/react";
import { LullMediaProvider } from "@lull/media-sdk/react";
import { createWidgetMediaClient } from "@lull/media-sdk/widget";
import { useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { setLocale } from "virtual:lull-messages";
import { LiquidPlayer } from "./liquid-player";
import { installPlayerBridge, preloadPlayerState } from "./compat";
import "./global.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("缺少 #root");
const mount: HTMLElement = rootElement;

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
    installPlayerBridge(lull);
    await preloadPlayerState();

    document.documentElement.classList.add("lull-transparent-window");
    document.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const target = event.target as Element | null;
      if (!target?.closest("[data-tauri-drag-region]")) return;
      if (target.closest("button,a,input,select,textarea")) return;
      void lull.startDrag();
    });

    createRoot(mount).render(
      <LullProvider client={lull}>
        <LullMediaProvider client={media}>
          <HostSync>
            <LiquidPlayer />
          </HostSync>
        </LullMediaProvider>
      </LullProvider>,
    );
  } catch (error) {
    mount.textContent =
      error instanceof Error
        ? `播放器加载失败：${error.message}`
        : "播放器加载失败";
  }
}

void boot();
