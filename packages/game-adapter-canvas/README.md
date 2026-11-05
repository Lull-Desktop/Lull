# `@lull/game-adapter-canvas`

Game SDK 的 Canvas2D 渲染适配器（P4）。把 `@lull/game-sdk/scene` 的只读客户端
接到 `canvas` 上：处理 dpr/backing store、rAF 节流、暂停/恢复与快照重绘。

```ts
import { createCanvasGameRenderer } from "@lull/game-adapter-canvas";
import { connectLullGameRender } from "@lull/game-sdk/scene";

const game = await connectLullGameRender();
if (game) {
  const renderer = createCanvasGameRenderer({
    canvas: document.getElementById("stage") as HTMLCanvasElement,
    game,
    maxFps: 30,
    draw: ({ context, width, height, state }) => {
      // 只读绘制：不提交状态、不发命令。
      context.fillStyle = "#0a1a16";
      context.fillRect(0, 0, width, height);
      // draw state...
    },
  });
  renderer.start();
}
```

- `game` 采用结构化类型：任何带 `render / getSnapshot / onSnapshot / onRenderState / onLifecycle` 的客户端都能接入。
- `suspended/stopped/failed` 自动停帧，`resumed/running/background` 恢复。
- 适配器不写状态、不发命令、不创建窗口；宿主 `cargo tree` 不会有任何引擎依赖。

```bash
pnpm game:adapter        # 构建 dist + .d.ts
pnpm game:adapter:check  # 类型检查
```

许可：Apache-2.0（见仓库根 `SDK-LICENSE.md`）。
