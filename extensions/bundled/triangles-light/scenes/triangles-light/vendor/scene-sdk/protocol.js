/**
 * Lull Scene Host 线上协议 v1。
 *
 * 与宿主 `src/scenes/scene-bridge.ts` 逐字段对应；改字段必须同时改宿主与
 * `client.test.ts` 的契约断言，否则已发布的场景包会静默失效。
 */
export const SCENE_PROTOCOL = 1;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isRect(value) {
    return (isRecord(value) &&
        typeof value.x === "number" &&
        typeof value.y === "number" &&
        typeof value.w === "number" &&
        typeof value.h === "number");
}
/** 只做协议层校验；未知字段忽略，方便宿主向前兼容地追加信息。 */
export function isScenePointer(value) {
    return (isRecord(value) &&
        typeof value.x === "number" &&
        Number.isFinite(value.x) &&
        typeof value.y === "number" &&
        Number.isFinite(value.y) &&
        typeof value.inside === "boolean" &&
        typeof value.moving === "boolean");
}
/** 只做协议层校验；未知字段忽略，方便宿主向前兼容地追加信息。 */
export function isSceneFrame(value) {
    if (!isRecord(value))
        return false;
    if (value.mode !== "mirror" &&
        value.mode !== "independent" &&
        value.mode !== "span") {
        return false;
    }
    if (value.layout !== "viewport" && value.layout !== "canvas")
        return false;
    if (!isRecord(value.sync) || typeof value.sync.enabled !== "boolean") {
        return false;
    }
    if (!isRecord(value.viewport))
        return false;
    if (typeof value.viewport.w !== "number" ||
        typeof value.viewport.h !== "number" ||
        typeof value.viewport.dpr !== "number") {
        return false;
    }
    if (value.canvas !== null && !isRect(value.canvas))
        return false;
    if (value.view !== null && !isRect(value.view))
        return false;
    if (typeof value.dpr !== "number")
        return false;
    if (!isRecord(value.params))
        return false;
    if (typeof value.reducedMotion !== "boolean")
        return false;
    return true;
}
export function isSceneHostMessage(value) {
    if (!isRecord(value) || value.v !== SCENE_PROTOCOL)
        return false;
    if (value.type === "init") {
        return (value.protocol === SCENE_PROTOCOL &&
            typeof value.hostApi === "number" &&
            typeof value.id === "string" &&
            typeof value.visible === "boolean" &&
            isSceneFrame(value.frame));
    }
    if (value.type === "frame")
        return isSceneFrame(value.frame);
    if (value.type === "pointer")
        return isScenePointer(value.pointer);
    if (value.type === "visibility")
        return typeof value.visible === "boolean";
    return false;
}
//# sourceMappingURL=protocol.js.map