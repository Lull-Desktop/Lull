/**
 * P1 自检包：只依赖 @lull/widget-sdk，验证官方来源、默认授权、状态 KV 与主题下发。
 * 正式发布前删除。
 */
import { connectLullWidget } from "@lull/widget-sdk";
import "./style.css";

const root = document.querySelector<HTMLElement>("#root");
if (!root) throw new Error("缺少 #root");

const status = document.createElement("p");
status.dataset.state = "pending";
status.textContent = "正在连接宿主…";
root.append(status);

void (async () => {
  try {
    const lull = await connectLullWidget();
    status.dataset.state = "ready";
    status.textContent = `已连接：${lull.id} · hostApi ${String(lull.hostApi)}`;

    const counter = document.createElement("button");
    counter.type = "button";
    const render = async (): Promise<void> => {
      const count = await lull.getState<number>("count", 0);
      counter.textContent = `计数 ${String(count)}`;
    };
    counter.addEventListener("click", () => {
      void (async () => {
        const count = await lull.getState<number>("count", 0);
        await lull.setState("count", count + 1);
        await render();
      })();
    });
    root.append(counter);
    await render();

    // P2 布局自检：fit=content 时按内容高度请求宿主贴高；越界会被宿主夹取。
    const fit = (): void => {
      void lull
        .requestResize({
          height: Math.ceil(root.getBoundingClientRect().height),
        })
        .catch(() => {});
    };
    new ResizeObserver(fit).observe(root);
    fit();

    lull.onTheme((theme) => {
      root.dataset.theme = theme?.id ?? "default";
    });
  } catch (error) {
    status.dataset.state = "error";
    status.textContent = `连接失败：${error instanceof Error ? error.message : String(error)}`;
  }
})();
