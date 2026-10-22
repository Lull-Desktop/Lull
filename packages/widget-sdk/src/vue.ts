/**
 * Vue 3 适配层：`app.use(createLullPlugin(client))` 后使用 composables。
 * 与 React 适配层一样，只依赖插件客户端，不依赖宿主。
 */
import {
  type App,
  type InjectionKey,
  inject,
  onUnmounted,
  type Plugin,
  type Ref,
  ref,
} from "vue";
import type { LullWidgetClient } from "./client.js";
import type { WidgetTheme, WidgetViewport } from "./protocol.js";

export const LULL_WIDGET_KEY: InjectionKey<LullWidgetClient> =
  Symbol("lull-widget-client");

export function createLullPlugin(client: LullWidgetClient): Plugin {
  return {
    install(app: App) {
      app.provide(LULL_WIDGET_KEY, client);
    },
  };
}

export function useLull(): LullWidgetClient {
  const client = inject(LULL_WIDGET_KEY);
  if (!client) {
    throw new Error("useLull 必须在 createLullPlugin 之后使用。");
  }
  return client;
}

export function useLullTheme(): Ref<WidgetTheme | null> {
  const client = useLull();
  const theme = ref<WidgetTheme | null>(
    client.theme,
  ) as Ref<WidgetTheme | null>;
  const stop = client.onTheme((next) => {
    theme.value = next;
  });
  onUnmounted(() => {
    stop();
  });
  return theme;
}

export function useLullViewport(): Ref<WidgetViewport> {
  const client = useLull();
  const viewport = ref<WidgetViewport>(client.viewport) as Ref<WidgetViewport>;
  const stop = client.onViewport((next) => {
    viewport.value = next;
  });
  onUnmounted(() => {
    stop();
  });
  return viewport;
}

export function useLullVisibility(): Ref<boolean> {
  const client = useLull();
  const visible = ref<boolean>(client.visible);
  const stop = client.onVisibility((next) => {
    visible.value = next;
  });
  onUnmounted(() => {
    stop();
  });
  return visible;
}

/**
 * 命名空间状态：先按 `initial` 渲染，再异步读取宿主 KV。
 * 返回 `[ref, save]`，与 `useLullState`（React）语义一致。
 */
export function useLullState<T>(
  key: string,
  initial: T,
): [Ref<T>, (next: T) => void] {
  const client = useLull();
  const value = ref(initial) as Ref<T>;
  let alive = true;

  client
    .getState<T>(key, initial)
    .then((next) => {
      if (alive) value.value = next;
    })
    .catch(() => {
      // 读取失败保持 initial。
    });

  onUnmounted(() => {
    alive = false;
  });

  const save = (next: T): void => {
    value.value = next;
    void client.setState(key, next);
  };

  return [value, save];
}
