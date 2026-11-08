import { isSceneHostMessage, } from "./protocol.js";
export function createWindowSceneTransport(target) {
    return {
        send(message) {
            target.postMessage(message, "*");
        },
        listen(listener) {
            const onMessage = (event) => {
                // iframe 是 opaque origin，event.origin 为 "null"，只能比较 source。
                if (event.source !== target)
                    return;
                if (!isSceneHostMessage(event.data))
                    return;
                listener(event.data);
            };
            window.addEventListener("message", onMessage);
            return () => window.removeEventListener("message", onMessage);
        },
    };
}
//# sourceMappingURL=transport.js.map