/**
 * 动态消息查询：给「运行时才知道键名」的场景用（IPC 错误码、清单里的 error keys）。
 *
 * 普通界面文案一律直接 `m.some_key()`：编译期校验、可 tree-shake。
 * 这个文件是唯一的动态入口，别在组件里手写 key 字符串。
 *
 * 代价：`import * as messages` 会把全部消息拉进引用方的 bundle，
 * 所以只让 `errors.ts` 这类「错误码 → 文案」的地方用它，页面组件不要用。
 */
import * as messages from "@/paraglide/messages";

type MessageFunction = (inputs?: Record<string, string>) => string;

const registry = messages as unknown as Record<string, unknown>;

/** 按键名取消息；键不存在或不是消息函数时返回 null（调用方决定如何兜底）。 */
export function messageOrNull(
  key: string,
  inputs?: Record<string, string>,
): string | null {
  const fn = registry[key];
  if (typeof fn !== "function") return null;
  try {
    return (fn as MessageFunction)(inputs);
  } catch (error) {
    console.error(`[i18n] 消息 ${key} 渲染失败`, error);
    return null;
  }
}

/** 按键名取消息；缺失时原样返回键名，便于在界面上一眼定位漏翻译。 */
export function message(key: string, inputs?: Record<string, string>): string {
  return messageOrNull(key, inputs) ?? key;
}

export function hasMessage(key: string): boolean {
  return typeof registry[key] === "function";
}
