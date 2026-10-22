/**
 * React 适配层：把插件客户端放进 Context，并提供状态/主题/视口 hooks。
 * 宿主与插件之间仍然只走 postMessage；这里没有 Tauri 依赖。
 * 使用 createElement 而不是 JSX，消费者不需要额外配置 JSX 转换。
 */
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
} from "react";

const LullContext = createContext(null);

export function LullProvider({ client, children }) {
  return createElement(
    LullContext.Provider,
    { value: client },
    children,
  );
}

export function useLull() {
  const client = useContext(LullContext);
  if (!client) {
    throw new Error("useLull 必须在 <LullProvider> 内使用。");
  }
  return client;
}

export function useLullTheme() {
  const client = useLull();
  const [theme, setTheme] = useState(() => client.theme);
  useEffect(() => client.onTheme(setTheme), [client]);
  return theme;
}

export function useLullViewport() {
  const client = useLull();
  const [viewport, setViewport] = useState(() => client.viewport);
  useEffect(() => client.onViewport(setViewport), [client]);
  return viewport;
}

export function useLullVisibility() {
  const client = useLull();
  const [visible, setVisible] = useState(() => client.visible);
  useEffect(() => client.onVisibility(setVisible), [client]);
  return visible;
}

/**
 * 命名空间状态：先按 initial 渲染，挂载后从宿主 KV 读取；写入异步落盘。
 * initial 只是首次渲染与缺失时的回退，不要在每次渲染时创建新对象。
 */
export function useLullState(key, initial) {
  const client = useLull();
  const [value, setValue] = useState(initial);

  useEffect(() => {
    let alive = true;
    client
      .getState(key, initial)
      .then((next) => {
        if (alive) setValue(next);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // initial 只是回退值：key/client 变化才重新读取。
  }, [client, key]);

  const save = (next) => {
    setValue(next);
    void client.setState(key, next);
  };
  return [value, save];
}
