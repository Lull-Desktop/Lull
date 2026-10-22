/**
 * Vue 3 适配层：`app.use(createLullPlugin(client))` 后使用 composables。
 * 与 React 适配层一样，只依赖插件客户端，不依赖宿主。
 */
import { inject, onUnmounted, ref } from "vue";

export const LULL_WIDGET_KEY = Symbol("lull-widget-client");

export function createLullPlugin(client) {
  return {
    install(app) {
      app.provide(LULL_WIDGET_KEY, client);
    },
  };
}

export function useLull() {
  const client = inject(LULL_WIDGET_KEY);
  if (!client) {
    throw new Error("useLull 必须在 createLullPlugin 之后使用。");
  }
  return client;
}

export function useLullTheme() {
  const client = useLull();
  const theme = ref(client.theme);
  const stop = client.onTheme((next) => {
    theme.value = next;
  });
  onUnmounted(stop);
  return theme;
}

export function useLullViewport() {
  const client = useLull();
  const viewport = ref(client.viewport);
  const stop = client.onViewport((next) => {
    viewport.value = next;
  });
  onUnmounted(stop);
  return viewport;
}

export function useLullVisibility() {
  const client = useLull();
  const visible = ref(client.visible);
  const stop = client.onVisibility((next) => {
    visible.value = next;
  });
  onUnmounted(stop);
  return visible;
}

export function useLullState(key, initial) {
  const client = useLull();
  const value = ref(initial);
  let alive = true;
  client
    .getState(key, initial)
    .then((next) => {
      if (alive) value.value = next;
    })
    .catch(() => {});
  onUnmounted(() => {
    alive = false;
  });
  const save = (next) => {
    value.value = next;
    void client.setState(key, next);
  };
  return [value, save];
}
