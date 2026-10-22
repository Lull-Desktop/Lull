/** React 适配层：Provider + hooks 的最小行为测试。 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { createLullWidgetClient } from "./client.js";
import { LullProvider, useLull, useLullState, useLullTheme } from "./react.js";
import { createInitMessage, createMemoryTransport } from "./testing.js";

function Harness() {
  const client = useLull();
  const [count, setCount] = useLullState("count", 0);
  const theme = useLullTheme();
  return (
    <div>
      <span data-testid="id">{client.id}</span>
      <span data-testid="theme">{theme?.id ?? "none"}</span>
      <button type="button" onClick={() => setCount(count + 1)}>
        {count}
      </button>
    </div>
  );
}

describe("react adapter", () => {
  test("useLullState 先渲染 initial，再回填宿主值并回写", async () => {
    const transport = createMemoryTransport();
    const client = createLullWidgetClient(createInitMessage(), { transport });

    render(
      <LullProvider client={client}>
        <Harness />
      </LullProvider>,
    );

    expect(screen.getByTestId("id").textContent).toBe("community-test");
    expect(screen.getByTestId("theme").textContent).toBe("bamboo");
    expect(screen.getByRole("button").textContent).toBe("0");

    const read = transport.lastRequest();
    if (!read) throw new Error("没有发出读取请求");
    expect(read.method).toBe("state.get");
    transport.respond(read.id, { value: 7 });
    expect(await screen.findByText("7")).toBeDefined();

    fireEvent.click(screen.getByRole("button"));
    const write = transport.lastRequest();
    if (!write) throw new Error("没有发出写入请求");
    expect(write).toMatchObject({
      method: "state.set",
      params: { key: "count", value: 8 },
    });
  });

  test("主题变化通过 context 传到组件", async () => {
    const transport = createMemoryTransport();
    const client = createLullWidgetClient(createInitMessage(), { transport });

    render(
      <LullProvider client={client}>
        <Harness />
      </LullProvider>,
    );

    transport.receive({
      v: 1,
      type: "theme",
      theme: {
        id: "dusk",
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

    expect(await screen.findByText("dusk")).toBeDefined();
  });
});
