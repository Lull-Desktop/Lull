/** Vue 3 适配层：plugin + composables 的最小行为测试。 */

import { describe, expect, test } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createLullWidgetClient } from "./client.js";
import { createInitMessage, createMemoryTransport } from "./testing.js";
import { createLullPlugin, useLullState, useLullTheme } from "./vue.js";

describe("vue adapter", () => {
  test("useLullState 读取宿主值并可回写，useLullTheme 跟随主题", async () => {
    const transport = createMemoryTransport();
    const client = createLullWidgetClient(createInitMessage(), { transport });

    const App = defineComponent({
      setup() {
        const [count] = useLullState("count", 0);
        const theme = useLullTheme();
        return () =>
          h("div", [
            h("span", { id: "count" }, String(count.value)),
            h("span", { id: "theme" }, theme.value?.id ?? "none"),
          ]);
      },
    });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(App);
    app.use(createLullPlugin(client));
    app.mount(host);
    await nextTick();

    const read = transport.lastRequest();
    if (!read) throw new Error("没有发出读取请求");
    expect(read.method).toBe("state.get");
    transport.respond(read.id, { value: 5 });
    // 状态回填走 promise 微任务：先放行一个宏任务让 then 执行，再 flush 渲染队列。
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    expect(host.querySelector("#count")?.textContent).toBe("5");
    expect(host.querySelector("#theme")?.textContent).toBe("bamboo");

    transport.receive({
      v: 1,
      type: "theme",
      theme: {
        id: "mist",
        colors: {
          a: "#000",
          b: "#111",
          c: "#222",
          accentLight: "#333",
          accentDark: "#444",
          onAccentLight: "#555",
          onAccentDark: "#666",
        },
      },
    });
    await nextTick();

    expect(host.querySelector("#theme")?.textContent).toBe("mist");
    app.unmount();
    host.remove();
  });
});
