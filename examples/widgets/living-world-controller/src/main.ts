/**
 * Living World 控制器示例（P1/P2 遗留示例补齐）。
 *
 * 只通过 `@lull/widget-sdk` 与 `@lull/game-sdk/widget` 工作：
 * - 不直接调用 Tauri IPC；
 * - 不包含 Authority 逻辑，所有写操作都变成 game command；
 * - 事件只用于刷新 UI，不改变权威状态。
 */
import { connectLullGameWidget } from "@lull/game-sdk/widget";
import { connectLullWidget } from "@lull/widget-sdk";

const GAME_ID = "community.living-world";

type LivingState = {
  water?: number;
  plants?: { id: string; growth: number; water: number }[];
};

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少页面元素 #${id}`);
  return node as T;
}

const status = element<HTMLSpanElement>("status");
const waterEl = element<HTMLElement>("water");
const plantsEl = element<HTMLElement>("plants");
const revisionEl = element<HTMLElement>("revision");
const plantButton = element<HTMLButtonElement>("plant");
const waterButton = element<HTMLButtonElement>("water");
const logEl = element<HTMLUListElement>("log");
const errorEl = element<HTMLParagraphElement>("error");

let busy = false;

function setBusy(value: boolean): void {
  busy = value;
  plantButton.disabled = value;
  waterButton.disabled = value;
}

function errorText(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  if (typeof reason === "object" && reason !== null && "message" in reason) {
    return String((reason as { message: unknown }).message);
  }
  return "未知错误";
}

function log(message: string): void {
  const item = document.createElement("li");
  item.textContent = message;
  logEl.prepend(item);
  while (logEl.children.length > 8) logEl.lastElementChild?.remove();
}

function render(
  state: LivingState | null | undefined,
  revision?: number,
): void {
  const plants = state?.plants ?? [];
  waterEl.textContent =
    typeof state?.water === "number" ? state.water.toFixed(1) : "--";
  plantsEl.textContent = String(plants.length);
  if (typeof revision === "number") revisionEl.textContent = String(revision);
}

async function main(): Promise<void> {
  const widget = await connectLullWidget();
  const game = await connectLullGameWidget(widget, { gameId: GAME_ID });

  const active = Boolean(game.context.instanceId);
  status.textContent = active ? "已连接" : "游戏未运行";
  render(
    game.snapshot?.state as LivingState | undefined,
    game.snapshot?.revision,
  );
  if (!active) {
    log("等待游戏启动：在设置页「游戏」中启动 Living World");
  }

  game.onSnapshot((snapshot) => {
    render(snapshot.state as LivingState, snapshot.revision);
  });
  game.onEvent("*", (event) => {
    const payload = event.payload as { command?: string } | undefined;
    log(
      payload?.command ? `${event.type} · ${payload.command}` : `${event.type}`,
    );
  });
  game.onLifecycle((event) => {
    status.textContent =
      event.state === "stopped"
        ? "游戏已停止"
        : event.state === "resumed"
          ? "已恢复"
          : event.state;
    log(`lifecycle · ${event.state}`);
  });

  plantButton.addEventListener("click", () => {
    if (busy) return;
    setBusy(true);
    errorEl.textContent = "";
    void game
      .command("plant.seed", { seedId: `seed-${Date.now()}` })
      .then((result) => {
        if (!result.ok) throw new Error(result.error ?? "命令失败");
        log("已种下");
      })
      .catch((reason: unknown) => {
        errorEl.textContent = errorText(reason);
      })
      .finally(() => {
        setBusy(false);
      });
  });

  waterButton.addEventListener("click", () => {
    if (busy) return;
    setBusy(true);
    errorEl.textContent = "";
    void game
      .command("plant.water")
      .then((result) => {
        if (!result.ok) throw new Error(result.error ?? "命令失败");
        log("已浇水");
      })
      .catch((reason: unknown) => {
        errorEl.textContent = errorText(reason);
      })
      .finally(() => {
        setBusy(false);
      });
  });

  window.addEventListener("pagehide", () => {
    game.destroy();
    widget.destroy();
  });
}

void main().catch((reason: unknown) => {
  status.textContent = "连接失败";
  errorEl.textContent = errorText(reason);
});
