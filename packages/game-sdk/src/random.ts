/**
 * 确定性随机源：host-tick 模式下游戏逻辑不能依赖 `Math.random()`，
 * 否则存档重放与离线结算会漂移。
 *
 * 使用 mulberry32：32 位状态、实现短、跨平台稳定。种子由游戏自己
 * 持久化到存档里，每次启动用同一 seed 得到同一序列。
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
