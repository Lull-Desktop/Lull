/**
 * 队列显示解析：队列 ID 是宿主持久化的权威顺序，不能因为曲库分页缺少元数据
 * 就丢弃条目。缺少元数据的旧曲目用 placeholder 占位，数量与顺序保持不变。
 */
import type { TrackSummary } from "./types.js";

export function unknownQueueTrack(id: string): TrackSummary {
  return {
    id,
    title: "未知曲目",
    artists: [],
    source: "local",
    available: false,
    hasCover: false,
    favorite: false,
  };
}

export function queueTracksFor(
  ids: readonly string[],
  byId: ReadonlyMap<string, TrackSummary>,
): TrackSummary[] {
  return ids.map((id) => byId.get(id) ?? unknownQueueTrack(id));
}
