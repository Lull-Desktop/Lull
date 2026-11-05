/**
 * 隐藏游戏权威窗口的页面入口：路由固定为 `/game-authority`。
 *
 * 由 Rust 的 `game_lifecycle` 以 `visible(false)` 创建；页面只挂宿主壳，
 * 不渲染顶栏、菜单或任何宿主 UI。窗口 label 为 `game-authority-<hex>`。
 */
import { GameAuthorityShell } from "@/games/authority/game-authority-shell";

export default function GameAuthorityPage() {
  return <GameAuthorityShell />;
}
