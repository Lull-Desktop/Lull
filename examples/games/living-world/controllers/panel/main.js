/**
 * Living World 包内控制器（零构建示例）。
 *
 * 与 authority 一样直接实现宿主壳的 v1 协议：发 `ready` 等 `init`，之后用
 * `command.send` 发命令、接收 `snapshot` / `event` / `lifecycle`。窗口 token
 * 只存在于宿主壳与 Rust 之间，这个页面永远拿不到它。
 */
(function () {
  "use strict";

  var PROTOCOL = 1;
  var context = null;
  var state = createInitialState();
  var sequence = 0;
  var pending = new Map();
  var logLine = document.getElementById("log");

  function createInitialState() {
    return { simulationMs: 0, water: 0, bloom: 0, plants: [] };
  }

  function adoptState(next) {
    var merged = createInitialState();
    if (!next || typeof next !== "object") return merged;
    ["simulationMs", "water", "bloom"].forEach(function (key) {
      var value = next[key];
      if (typeof value === "number" && Number.isFinite(value)) merged[key] = value;
    });
    if (Array.isArray(next.plants)) merged.plants = next.plants;
    return merged;
  }

  function post(message) {
    parent.postMessage(message, "*");
  }

  function request(method, params) {
    var id = ++sequence;
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject });
      post({ v: PROTOCOL, type: "request", id: id, method: method, params: params || {} });
      setTimeout(function () {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(method + " timeout"));
      }, 8000);
    });
  }

  function log(message) {
    if (!logLine) return;
    logLine.textContent += (logLine.textContent ? "\n" : "") + message;
    logLine.scrollTop = logLine.scrollHeight;
  }

  function render() {
    var water = document.getElementById("water");
    var plants = document.getElementById("plants");
    var bloom = document.getElementById("bloom");
    if (water) water.textContent = String(Math.round(state.water));
    if (plants) plants.textContent = String(state.plants.length);
    if (bloom) bloom.textContent = Math.round(state.bloom * 100) + "%";
  }

  function setStatus(text) {
    var status = document.getElementById("status");
    if (status) status.textContent = text;
  }

  function sendCommand(type, payload) {
    var requestId =
      "cmd-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    request("command.send", { requestId: requestId, type: type, payload: payload })
      .then(function (result) {
        if (result && result.ok === false) {
          log(type + " 被拒绝：" + (result.error || "unknown"));
          return;
        }
        log(type + " → " + JSON.stringify((result && result.result) || {}));
      })
      .catch(function (error) {
        log(type + " 失败：" + (error && error.message ? error.message : String(error)));
      });
  }

  document.getElementById("seed").addEventListener("click", function () {
    sendCommand("plant.seed", { seedId: "seed-" + Date.now() });
  });
  document.getElementById("water-btn").addEventListener("click", function () {
    sendCommand("plant.water", {});
  });

  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.v !== PROTOCOL) return;

    if (data.type === "init") {
      context = data.context;
      if (data.snapshot && data.snapshot.state) {
        state = adoptState(data.snapshot.state);
      }
      render();
      setStatus("已连接 · " + context.gameId + " · " + context.controllerId);
      log("init revision " + context.revision);
      return;
    }

    if (data.type === "init-error") {
      setStatus("不可用：" + ((data.error && data.error.message) || "未知错误"));
      log("init-error " + JSON.stringify(data.error || {}));
      return;
    }

    if (data.type === "snapshot" && data.snapshot) {
      state = adoptState(data.snapshot.state);
      if (context) context.revision = data.snapshot.revision;
      render();
      return;
    }

    if (data.type === "event" && data.event) {
      log("事件 " + data.event.type);
      return;
    }

    if (data.type === "lifecycle" && data.event) {
      log("lifecycle " + data.event.state);
      if (data.event.state === "stopped" || data.event.state === "failed") {
        setStatus("游戏已停止");
        context = null;
      }
      return;
    }

    if (data.type === "response") {
      var entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      if (data.ok) entry.resolve(data.result);
      else entry.reject(new Error((data.error && data.error.message) || "host error"));
    }
  });

  post({ v: PROTOCOL, type: "ready" });
})();
