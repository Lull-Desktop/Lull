/**
 * Ambient Embers 包内控制器（零构建示例）。
 *
 * 与 living-world/controllers/panel 一样直接实现宿主壳的 v1 协议：
 * 发 `ready` 等 `init`，之后用 `command.send` 发命令、接收 `snapshot` /
 * `event` / `lifecycle`。窗口 token 只存在于宿主壳与 Rust 之间，这个页面
 * 永远拿不到它；UI 随游戏包一起分发。
 */
(function () {
  "use strict";

  var PROTOCOL = 1;
  var COMMAND_TIMEOUT_MS = 8000;
  var MAX_LOG_LINES = 24;

  var context = null;
  var state = createInitialState();
  var sequence = 0;
  var pending = new Map();
  var busy = false;
  var connected = false;

  var statusEl = document.getElementById("status");
  var intensityEl = document.getElementById("intensity");
  var phaseEl = document.getElementById("phase");
  var embersEl = document.getElementById("embers");
  var revisionEl = document.getElementById("revision");
  var pulseButton = document.getElementById("pulse");
  var reseedButton = document.getElementById("reseed");
  var logEl = document.getElementById("log");
  var errorEl = document.getElementById("error");

  function createInitialState() {
    return {
      simulationMs: 0,
      phase: 0,
      intensity: 0.5,
      pulse: 0,
      seed: 0,
      embers: [],
      lastSettledMs: 0,
    };
  }

  function adoptState(next) {
    var merged = createInitialState();
    if (!next || typeof next !== "object") return merged;
    [
      "simulationMs",
      "phase",
      "intensity",
      "pulse",
      "seed",
      "lastSettledMs",
    ].forEach(function (key) {
      var value = next[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        merged[key] = value;
      }
    });
    if (Array.isArray(next.embers)) merged.embers = next.embers;
    return merged;
  }

  function errorText(value) {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      if (typeof value.message === "string") return value.message;
      if (typeof value.code === "string") return value.code;
      try {
        return JSON.stringify(value);
      } catch (error) {
        return "未知错误";
      }
    }
    return value == null ? "未知错误" : String(value);
  }

  function summarize(value) {
    var text;
    try {
      text = JSON.stringify(value);
    } catch (error) {
      text = String(value);
    }
    if (typeof text !== "string") return "";
    return text.length > 120 ? text.slice(0, 117) + "..." : text;
  }

  function post(message) {
    parent.postMessage(message, "*");
  }

  function request(method, params) {
    var id = ++sequence;
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject });
      post({
        v: PROTOCOL,
        type: "request",
        id: id,
        method: method,
        params: params || {},
      });
      window.setTimeout(function () {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(method + " timeout"));
      }, COMMAND_TIMEOUT_MS);
    });
  }

  function log(message) {
    if (!logEl) return;
    var item = document.createElement("li");
    item.textContent = message;
    logEl.prepend(item);
    while (logEl.childElementCount > MAX_LOG_LINES) {
      if (logEl.lastElementChild) logEl.lastElementChild.remove();
    }
  }

  function clamp01(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
  }

  function render() {
    if (intensityEl) {
      intensityEl.textContent = Math.round(clamp01(state.intensity) * 100) + "%";
    }
    if (phaseEl) phaseEl.textContent = Math.round(state.phase) + "s";
    if (embersEl) embersEl.textContent = String(state.embers.length);
    if (revisionEl) {
      revisionEl.textContent = context ? String(context.revision) : "--";
    }
  }

  function setStatus(text, kind) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.setAttribute("data-state", kind);
  }

  function updateButtons() {
    var enabled = connected && !busy;
    if (pulseButton) pulseButton.disabled = !enabled;
    if (reseedButton) reseedButton.disabled = !enabled;
  }

  function sendCommand(type, payload) {
    if (!context || !connected || busy) return;
    busy = true;
    updateButtons();
    if (errorEl) errorEl.textContent = "";
    var requestId =
      "ctrl-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    request("command.send", {
      requestId: requestId,
      type: type,
      payload: payload || {},
    })
      .then(
        function (result) {
          if (!result || result.ok !== true) {
            var detail = result && result.error ? result.error : "命令被拒绝";
            if (errorEl) errorEl.textContent = errorText(detail);
            log(type + " 被拒绝");
            return;
          }
          log(type + " 已接受");
          if (result.result !== undefined) {
            log("↳ " + summarize(result.result));
          }
        },
        function (error) {
          if (errorEl) errorEl.textContent = errorText(error);
          log(type + " 失败");
        },
      )
      .then(function () {
        busy = false;
        updateButtons();
      });
  }

  if (pulseButton) {
    pulseButton.addEventListener("click", function () {
      sendCommand("embers.pulse", { source: "controller" });
    });
  }
  if (reseedButton) {
    reseedButton.addEventListener("click", function () {
      sendCommand("embers.reseed");
    });
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.v !== PROTOCOL) return;

    if (data.type === "init") {
      context = data.context || null;
      if (!context) {
        connected = false;
        setStatus("上下文无效", "error");
        if (errorEl) errorEl.textContent = "缺少宿主注入的控制器上下文";
        updateButtons();
        return;
      }
      connected = true;
      var snapshot = data.snapshot;
      if (snapshot && snapshot.state) state = adoptState(snapshot.state);
      if (snapshot && typeof snapshot.revision === "number") {
        context.revision = snapshot.revision;
      }
      render();
      setStatus("已连接", "ready");
      log("已连接 · " + context.controllerId);
      updateButtons();
      return;
    }

    if (data.type === "init-error") {
      connected = false;
      context = null;
      setStatus("不可用", "error");
      if (errorEl) errorEl.textContent = errorText(data.error);
      log("初始化失败");
      updateButtons();
      return;
    }

    if (data.type === "snapshot" && data.snapshot) {
      state = adoptState(data.snapshot.state);
      if (context && typeof data.snapshot.revision === "number") {
        context.revision = data.snapshot.revision;
      }
      render();
      return;
    }

    if (data.type === "event" && data.event) {
      log("事件 · " + (data.event.type || "unknown"));
      return;
    }

    if (data.type === "lifecycle" && data.event) {
      var lifecycle = data.event;
      var status = lifecycle.state || "unknown";
      log("生命周期 · " + status);
      if (status === "stopped" || status === "failed") {
        connected = false;
        context = null;
        setStatus(status === "failed" ? "已失败" : "已停止", "error");
        updateButtons();
        return;
      }
      if (status === "suspended") {
        setStatus("已暂停", "ready");
        return;
      }
      if (status === "hidden" || status === "background") {
        setStatus("后台运行", "ready");
        return;
      }
      setStatus(status === "resumed" ? "已连接" : "运行中", "ready");
      return;
    }

    if (data.type === "response") {
      var entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      if (data.ok) entry.resolve(data.result);
      else entry.reject(new Error(errorText(data.error)));
    }
  });

  render();
  updateButtons();
  post({ v: PROTOCOL, type: "ready" });
})();
