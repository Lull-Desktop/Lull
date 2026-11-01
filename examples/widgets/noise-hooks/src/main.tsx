/**
 * N5 React hooks 验证示例。
 *
 * 两个 Probe 各自调用 `useNoiseSession` / `useNoiseTracks`，共享同一个
 * MediaClient 与同一次 `media.connect`；全部卸载后 hooks store 调用
 * `media.disconnect`。页面把 bridge 的 connect/disconnect 次数直接显示出来。
 */
import { useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { connectLullWidget, type LullWidgetClient } from "@lull/widget-sdk";
import {
  createWidgetMediaClient,
  type WidgetMediaBridge,
} from "@lull/media-sdk/widget";
import {
  LullMediaProvider,
  useNoiseSession,
  useNoiseTracks,
} from "@lull/media-sdk/react";

type Stats = {
  connect: number;
  disconnect: number;
  requests: number;
  last: string;
};

let stats: Stats = { connect: 0, disconnect: 0, requests: 0, last: "—" };
const statsListeners = new Set<() => void>();

const statsStore = {
  get: (): Stats => stats,
  subscribe: (listener: () => void): (() => void) => {
    statsListeners.add(listener);
    return () => {
      statsListeners.delete(listener);
    };
  },
  bump: (method: string): void => {
    stats = {
      connect: stats.connect + (method === "media.connect" ? 1 : 0),
      disconnect: stats.disconnect + (method === "media.disconnect" ? 1 : 0),
      requests: stats.requests + 1,
      last: method,
    };
    for (const listener of statsListeners) listener();
  },
};

function useStats(): Stats {
  return useSyncExternalStore(
    statsStore.subscribe,
    statsStore.get,
    statsStore.get,
  );
}

function Probe({ name }: { name: string }) {
  const session = useNoiseSession();
  const tracks = useNoiseTracks();
  const renders = useRef(0);
  renders.current += 1;

  return (
    <div className="probe">
      <h2>Probe {name}</h2>
      <p>渲染次数：{renders.current}</p>
      <p>Session：{session?.state ?? "未连接"}</p>
      <p>轨道：{tracks.length}</p>
    </div>
  );
}

function App() {
  const current = useStats();
  const [mounted, setMounted] = useState(true);
  const [tick, setTick] = useState(0);

  return (
    <main className="app">
      <header>
        <p className="eyebrow">LULL / MEDIA SDK / REACT</p>
        <h1>Noise Hooks</h1>
      </header>
      <p className="lead">
        验证共享连接：两个 Probe 都调用 hooks，但只应产生一次 connect；全部卸载后产生一次
        disconnect。父组件渲染轮次：{tick}。
      </p>

      <div className="stats">
        <div className="stat">
          <span>connect</span>
          <strong>{current.connect}</strong>
        </div>
        <div className="stat">
          <span>disconnect</span>
          <strong>{current.disconnect}</strong>
        </div>
        <div className="stat">
          <span>requests</span>
          <strong>{current.requests}</strong>
        </div>
      </div>

      <div className="actions">
        <button type="button" onClick={() => setTick((value) => value + 1)}>
          父组件重渲染
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => setMounted(false)}
          disabled={!mounted}
        >
          卸载两个 Probe
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => setMounted(true)}
          disabled={mounted}
        >
          重新挂载
        </button>
      </div>

      {mounted ? (
        <div className="probes">
          <Probe name="A" />
          <Probe name="B" />
        </div>
      ) : (
        <p className="lead">两个 Probe 已卸载；最后一个订阅释放时应看到 disconnect +1。</p>
      )}

      <pre className="log">last bridge request: {current.last}</pre>
    </main>
  );
}

const lull = await connectLullWidget();
const bridge: WidgetMediaBridge = {
  request: (method, params) => {
    statsStore.bump(method);
    return (lull as LullWidgetClient).request(method as never, params as never);
  },
  onMediaEvent: lull.onMediaEvent,
};
const media = createWidgetMediaClient(bridge);

createRoot(document.getElementById("root")!).render(
  <LullMediaProvider client={media}>
    <App />
  </LullMediaProvider>,
);
