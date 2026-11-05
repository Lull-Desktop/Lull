"use client";

/**
 * 壁纸内容切换提示：旧游戏仍在运行时，让用户选择停止、后台继续或取消。
 *
 * 与通用确认弹窗不同，这里是三选一：停止和后台继续都会继续执行壁纸切换，
 * 只有取消会中止。放在独立组件里，避免把三态语义塞进 `useConfirmDialog`。
 */
import { Dialog } from "radix-ui";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";

export type GameSwitchChoice = "stop" | "background" | "cancel";

type Props = {
  /** 非空时弹窗打开；值为正在运行的旧游戏名。 */
  gameName: string | null;
  busy: boolean;
  onChoose: (choice: GameSwitchChoice) => void;
};

export function GameSwitchDialog({ gameName, busy, onChoose }: Props) {
  if (!gameName) return null;

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onChoose("cancel");
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/30" />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="wallpaper-game-switch"
          className="fixed top-1/2 left-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-paper-deep/60 bg-card p-5 shadow-xl focus:outline-none"
        >
          <Dialog.Title className="text-base font-medium text-ink">
            {m.wallpaper_game_switch_title()}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-ink-soft">
            {m.wallpaper_game_switch_description({ name: gameName })}
          </Dialog.Description>
          <p className="mt-2 text-xs text-muted-foreground">
            {m.wallpaper_game_switch_hint()}
          </p>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => onChoose("cancel")}
            >
              {m.dialog_cancel()}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onChoose("background")}
            >
              {m.wallpaper_game_switch_background()}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => onChoose("stop")}
            >
              {m.wallpaper_game_switch_stop()}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
