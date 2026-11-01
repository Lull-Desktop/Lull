import { describe, expect, test, vi } from "vitest";

import { createWidgetTransport } from "./widget.js";

describe("createWidgetTransport", () => {
  test("routes calls through the widget bridge and forwards media events", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    let listener: ((event: unknown) => void) | null = null;
    const bridge = {
      request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "media.disconnect") return { disconnected: true };
        return {
          protocol: 1,
          requestId: "r",
          ok: true,
          revision: 1,
          result: { ok: true },
        };
      }),
      onMediaEvent: (next: (event: unknown) => void) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
    };

    const transport = createWidgetTransport(bridge);
    const response = await transport.call({
      protocol: 1,
      requestId: "1",
      namespace: "noise",
      method: "getSession",
      args: {},
    });
    expect(response.ok).toBe(true);
    expect(calls[0]?.method).toBe("media.call");

    await transport.connect?.({ topics: ["noise.session.changed"] });
    expect(calls[1]?.method).toBe("media.connect");

    const events: unknown[] = [];
    const stop = transport.subscribe?.((event) => events.push(event));
    const mediaListener = listener as ((event: unknown) => void) | null;
    mediaListener?.({ topic: "noise.session.changed" });
    expect(events).toHaveLength(1);
    stop?.();
    expect(listener).toBeNull();

    await transport.disconnect?.();
    expect(calls[2]?.method).toBe("media.disconnect");
  });
});
