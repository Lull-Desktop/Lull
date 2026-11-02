/**
 * 应用内确认 / 输入弹窗。
 *
 * 替代 `window.confirm` / `window.prompt`：原生弹窗在桌面应用里会顶着
 * 「localhost:3000 显示」的标题、不跟随主题，也无法统一危险操作的样式。
 *
 * 用法：
 * ```tsx
 * const { confirm, ask, dialog } = useConfirmDialog();
 * ...
 * void confirm({ title, description, danger: true }).then((ok) => { ... });
 * ...
 * return <>{...}{dialog}</>;
 * ```
 */
"use client";

import { Dialog } from "radix-ui";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";

export type ConfirmDialogRequest = {
  title: string;
  description?: ReactNode;
  /** 确认按钮文案；缺省「确定」。 */
  confirmLabel?: string;
  /** 取消按钮文案；缺省「取消」。 */
  cancelLabel?: string;
  /** 删除/覆盖类操作用危险色。 */
  danger?: boolean;
  /** 传入后变为输入弹窗，确认后返回输入值。 */
  input?: {
    label?: string;
    defaultValue?: string;
    placeholder?: string;
    ariaLabel?: string;
  };
};

type DialogState = ConfirmDialogRequest & {
  kind: "confirm" | "prompt";
  value: string;
};

type Settle = (value: boolean | string | null) => void;

export function useConfirmDialog(): {
  confirm: (request: ConfirmDialogRequest) => Promise<boolean>;
  ask: (
    request: ConfirmDialogRequest & {
      input: NonNullable<ConfirmDialogRequest["input"]>;
    },
  ) => Promise<string | null>;
  dialog: ReactNode;
} {
  const [state, setState] = useState<DialogState | null>(null);
  const settleRef = useRef<Settle | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const confirm = useCallback(
    (request: ConfirmDialogRequest): Promise<boolean> =>
      new Promise((resolve) => {
        settleRef.current = (value) => resolve(value === true);
        setState({ ...request, kind: "confirm", value: "" });
      }),
    [],
  );

  const ask = useCallback(
    (
      request: ConfirmDialogRequest & {
        input: NonNullable<ConfirmDialogRequest["input"]>;
      },
    ): Promise<string | null> =>
      new Promise((resolve) => {
        settleRef.current = (value) =>
          resolve(typeof value === "string" ? value : null);
        setState({
          ...request,
          kind: "prompt",
          value: request.input.defaultValue ?? "",
        });
      }),
    [],
  );

  const settle = useCallback((value: boolean | string | null) => {
    const resolve = settleRef.current;
    settleRef.current = null;
    setState(null);
    resolve?.(value);
  }, []);

  const submit = (): void => {
    if (!state) return;
    if (state.kind === "confirm") {
      settle(true);
      return;
    }
    if (state.value.trim().length === 0) return;
    settle(state.value);
  };

  const dialog = state ? (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) settle(state.kind === "confirm" ? false : null);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/30" />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            if (!inputRef.current) return;
            event.preventDefault();
            inputRef.current.focus();
            inputRef.current.select();
          }}
          className="fixed top-1/2 left-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-paper-deep/60 bg-card p-5 shadow-xl focus:outline-none"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Dialog.Title className="text-base font-medium text-ink">
              {state.title}
            </Dialog.Title>
            {state.description ? (
              <Dialog.Description className="mt-2 text-sm text-ink-soft">
                {state.description}
              </Dialog.Description>
            ) : null}
            {state.kind === "prompt" ? (
              <label className="mt-3 grid gap-1 text-xs text-ink-soft">
                {state.input?.label}
                <input
                  ref={inputRef}
                  value={state.value}
                  aria-label={state.input?.ariaLabel ?? state.input?.label}
                  placeholder={state.input?.placeholder}
                  onChange={(event) =>
                    setState({ ...state, value: event.target.value })
                  }
                  className="rounded-md border border-paper-deep/70 bg-paper-warm px-2 py-1.5 text-sm text-ink outline-none focus:border-bamboo/60"
                />
              </label>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => settle(state.kind === "confirm" ? false : null)}
              >
                {state.cancelLabel ?? m.dialog_cancel()}
              </Button>
              <Button
                type="submit"
                size="sm"
                variant={state.danger ? "destructive" : "default"}
                disabled={state.kind === "prompt" && state.value.trim() === ""}
              >
                {state.confirmLabel ?? m.dialog_confirm()}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  ) : null;

  return { confirm, ask, dialog };
}
