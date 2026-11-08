export class LullSceneError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "LullSceneError";
        this.code = code;
    }
}
//# sourceMappingURL=errors.js.map