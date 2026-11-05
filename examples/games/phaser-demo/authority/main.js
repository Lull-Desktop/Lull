/**
 * Ambient Embers Authority（零构建示例）。
 *
 * 三个引擎示例共用同一份权威逻辑：只由宿主 tick 驱动，不自己开定时器，
 * 直接实现 docs/game-runtime.md 的 v1 协议（正式游戏建议使用 @lull/game-sdk）。
 *
 * 状态只描述"世界参数"（火星布局、相位、亮度），
 * 具体动画由 replica 在本地按相位插值，因此 1s tick 也不会看起来卡顿。
 */
(function () {
  "use strict";

  var PROTOCOL = 1;
  var EMBER_COUNT = 18;
  var context = null;
  var state = createInitialState();
  var sequence = 0;
  var pending = new Map();
  var logLine = document.getElementById("log");

  function log(message) {
    if (!logLine) return;
    logLine.textContent += "\n" + message;
  }

  /** 稳定的伪随机：同一 seed 永远得到同一布局。 */
  function seeded(index) {
    var value = Math.sin(index * 127.1 + 311.7) * 43758.5453;
    return value - Math.floor(value);
  }

  function layout(seed) {
    var embers = [];
    for (var index = 0; index < EMBER_COUNT; index += 1) {
      var offset = seed * 977 + index;
      embers.push({
        id: "ember-" + index,
        x: Math.round((0.08 + seeded(offset * 3 + 1) * 0.84) * 1000) / 1000,
        y: Math.round((0.12 + seeded(offset * 7 + 2) * 0.76) * 1000) / 1000,
        size: Math.round((0.4 + seeded(offset * 5 + 3) * 0.6) * 1000) / 1000,
        hue: Math.round(seeded(offset * 11 + 4) * 360),
      });
    }
    return embers;
  }

  function createInitialState() {
    return {
      simulationMs: 0,
      phase: 0,
      intensity: 0.5,
      pulse: 0,
      seed: 0,
      embers: layout(0),
      lastSettledMs: 0,
    };
  }

  /**
   * 首份快照可能是 `{}`（新实例）；直接覆盖会让 tick 读到 undefined.embers。
   * 用默认值兜底，并只接受类型正确的字段。
   */
  function adoptState(next) {
    var merged = createInitialState();
    if (!next || typeof next !== "object") return merged;
    ["simulationMs", "phase", "intensity", "pulse", "seed", "lastSettledMs"].forEach(
      function (key) {
        var value = next[key];
        if (typeof value === "number" && Number.isFinite(value)) merged[key] = value;
      },
    );
    if (Array.isArray(next.embers) && next.embers.length > 0) {
      merged.embers = next.embers;
    }
    return merged;
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
      setTimeout(function () {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(method + " timeout"));
      }, 8000);
    });
  }

  function commitOnce(events) {
    return request("state.commit", {
      authorityId: context.authorityId,
      authorityEpoch: context.authorityEpoch,
      baseRevision: Number(context.revision) || 0,
      simulationTimeMs: state.simulationMs,
      state: state,
      events: events || [],
    }).then(function (result) {
      if (result && result.ok) {
        context.revision = result.revision;
        log("commit r" + result.revision);
      } else {
        log("commit failed " + JSON.stringify(result && result.error));
      }
      return result;
    });
  }

  /**
   * 串行提交：宿主按 baseRevision 严格递增，tick 与命令并发提交会互相冲突。
   * 队列保证同一时刻只有一个 commit 在飞，命令结果也能及时回传。
   */
  var commitQueue = Promise.resolve();

  function commit(events) {
    if (!context) return Promise.resolve();
    var run = function () {
      return commitOnce(events);
    };
    var next = commitQueue.then(run, run);
    commitQueue = next.catch(function () {});
    return next;
  }

  function advance(deltaMs) {
    if (!(deltaMs > 0)) return;
    if (!Array.isArray(state.embers)) state.embers = createInitialState().embers;
    state.simulationMs += deltaMs;
    state.phase = state.simulationMs / 1000;
    // 脉冲是衰减的叠加项，不会盖掉基础节律；不受 tick 频率影响。
    state.pulse = Math.max(0, state.pulse - deltaMs / 20000);
    state.intensity = Math.min(
      1,
      0.45 + 0.25 * Math.sin(state.simulationMs / 45000) + state.pulse,
    );
  }

  function pulse() {
    state.pulse = Math.min(0.9, state.pulse + 0.45);
    state.intensity = Math.min(1, state.intensity + 0.35);
    return { intensity: state.intensity };
  }

  function reseed() {
    state.seed = (Number(state.seed) || 0) + 1;
    state.embers = layout(state.seed);
    return { seed: state.seed, embers: state.embers.length };
  }

  function handleCommand(command) {
    var type = (command && command.type) || "";
    var result;
    var eventType;
    if (type === "embers.pulse") {
      result = pulse();
      eventType = "embers.pulsed";
    } else if (type === "embers.reseed") {
      result = reseed();
      eventType = "embers.reseeded";
    } else {
      result = { rejected: "unknown-command" };
      eventType = "world.settled";
    }
    // 立即回执：命令“已接受”不等待提交；持久化由随后的 tick/提交完成。
    // 宿主按实际提交的 revision 校验，结果里的 revision 只是提示。
    request("command.result", {
      requestId: command.requestId,
      ok: !result.rejected,
      result: result,
    }).then(
      function () {},
      function (error) {
        log("result failed " + (error && error.message));
      },
    );
    commit([{ type: eventType, payload: { command: type, result: result } }]).catch(
      function (error) {
        log("commit error " + error.message);
      },
    );
  }

  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.v !== PROTOCOL) return;

    if (data.type === "init") {
      context = data.context;
      if (data.snapshot && data.snapshot.state) {
        state = adoptState(data.snapshot.state);
      }
      log("init epoch=" + context.authorityEpoch + " revision=" + context.revision);
      request("ready", {}).catch(function (error) {
        log("ready failed " + error.message);
      });
      return;
    }

    if (data.type === "snapshot" && data.snapshot && data.snapshot.state) {
      state = adoptState(data.snapshot.state);
      context.revision = data.snapshot.revision;
      return;
    }

    if (data.type === "tick") {
      advance(Number(data.tick.deltaMs) || 0);
      commit().catch(function (error) {
        log("tick commit error " + error.message);
      });
      return;
    }

    if (data.type === "command") {
      handleCommand(data.command);
      return;
    }

    if (data.type === "lifecycle") {
      var lifecycle = data.event || {};
      log("lifecycle " + lifecycle.state);
      if (lifecycle.state === "resumed" && lifecycle.offlineMs) {
        advance(Math.min(Number(lifecycle.offlineMs) || 0, 7 * 24 * 3600 * 1000));
        state.lastSettledMs = state.simulationMs;
        commit([{ type: "world.settled", payload: { reason: "offline" } }]).catch(
          function () {},
        );
      }
      if (lifecycle.state === "stopped") {
        commit().catch(function () {});
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
