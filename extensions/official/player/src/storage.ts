/**
 * 播放器偏好的同步缓存：组件在渲染期读取，实际落盘由宿主 KV 异步完成。
 * 独立成纯模块，方便 Vitest 不加载 Widget SDK / virtual messages。
 */
const cache = new Map<string, string | null>();
let writer: ((key: string, value: string) => void) | null = null;

export function installStorageWriter(
  next: ((key: string, value: string) => void) | null,
): void {
  writer = next;
}

export function seedStorage(key: string, value: string | null): void {
  cache.set(key, value);
}

export function readStorage(key: string): string | null {
  return cache.get(key) ?? null;
}

export function writeStorage(key: string, value: string): void {
  cache.set(key, value);
  writer?.(key, value);
}

/** 单测清理；生产代码不调用。 */
export function resetStorageForTests(): void {
  cache.clear();
  writer = null;
}
