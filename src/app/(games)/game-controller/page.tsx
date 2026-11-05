/**
 * 包内控制器窗口的页面入口：路由固定为 `/game-controller`。
 *
 * 由 Rust 的 `game::controller` 以 `visible(false)` 创建；窗口 label 为
 * `game-controller-<hash>-<controllerId>`，页面只挂宿主壳，不渲染宿主 UI。
 */
import { GameControllerShell } from "@/games/controller/game-controller-shell";

export default function GameControllerPage() {
  return <GameControllerShell />;
}
