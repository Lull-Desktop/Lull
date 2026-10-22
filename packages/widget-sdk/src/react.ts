/**
 * React 适配层：把客户端放进 Context，并提供状态/主题/视口 hooks。
 *
 * 用 `createElement` 而不是 JSX，消费者不需要额外配置 JSX 转换；
 * 本模块只在 `@lull/widget-sdk/react` 子路径里引用 `react`。
 */
import {
  createContext,
  createElement,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { LullWidgetClient } from "./client.js";
import type { WidgetTheme, WidgetViewport } from "./protocol.js";

const LullContext = createContext<LullWidgetClient | null>(null);

export interface LullProviderProps {
  client: LullWidgetClient;
  children?: ReactNode;
}

export function LullProvider({
  client,
  children,
}: LullProviderProps): ReactElement {
  return createElement(LullContext.Provider, { value: client }, children);
}

export function useLull(): LullWidgetClient {
  const client = useContext(LullContext);
  if (!client) {
    throw new Error("useLull 必须在 <LullProvider> 内使用。");
  }
  return client;
}

export function useLullTheme(): WidgetTheme | null {
  const client = useLull();
  const [theme, setTheme] = useState<WidgetTheme | null>(() => client.theme);
  useEffect(() => client.onTheme(setTheme), [client]);
  return theme;
}

export function useLullViewport(): WidgetViewport {
  const client = useLull();
  const [viewport, setViewport] = useState<WidgetViewport>(
    () => client.viewport,
  );
  useEffect(() => client.onViewport(setViewport), [client]);
  return viewport;
}

export function useLullVisibility(): boolean {
  const client = useLull();
  const [visible, setVisible] = useState<boolean>(() => client.visible);
  useEffect(() => client.onVisibility(setVisible), [client]);
  return visible;
}

/**
 * 命名空间状态：先按 `initial` 渲染，挂载后从宿主 KV 读取；写入异步落盘。
 * `initial` 只是首次渲染与缺失时的回退，不要在每次渲染时创建新对象。
 */
export function useLullState<T>(
  key: string,
  initial: T,
): [T, (next: T) => void] {
  const client = useLull();
  const [value, setValue] = useState<T>(initial);
  // initial 只是回退值：放进 ref，既避免 effect 依赖抖动，也不在每次渲染重读。
  const fallback = useRef(initial);

  useEffect(() => {
    let alive = true;
    client
      .getState<T>(key, fallback.current)
      .then((next) => {
        if (alive) setValue(next);
      })
      .catch(() => {
        // 读取失败保持 initial：插件不该因为宿主暂时不可用而白屏。
      });
    return () => {
      alive = false;
    };
  }, [client, key]);

  const save = (next: T): void => {
    setValue(next);
    void client.setState(key, next);
  };

  return [value, save];
}
