/**
 * Living World Authority（零构建示例）。
 *
 * 这里直接实现 docs/game-runtime.md 里"宿主壳 ↔ 游戏 iframe"的 v1 协议，
 * 用于在没有打包工具的情况下跑通 P1 闭环。正式游戏应使用 @lull/game-sdk。
 *
 * Ambient Game 约定：
 * - 只由宿主 tick 与命令驱动，不自己开定时器推进模拟；
 * - 不设置失败惩罚，植物不会因为用户不操作而死亡；
 * - 离线时间由生命周期事件 offlineMs 结算。
 */
(function () {
  "use strict";

  var PROTOCOL = 1;
  var context = null;
  var state = createInitialState();
  var sequence = 0;
  var pending = new Map();
  var logLine = document.getElementById("log");

  function log(message) {
    if (!logLine) return;
    logLine.textContent += "\n" + message;
  }

  function createInitialState() {
    return {
      simulationMs: 0,
      water: 12,
      bloom: 0,
      plants: [],
      lastSettledMs: 0,
    };
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

  function commit(events) {
    if (!context) return Promise.resolve();
    var revision = Number(context.revision) || 0;
    return request("state.commit", {
      authorityId: context.authorityId,
      authorityEpoch: context.authorityEpoch,
      baseRevision: revision,
      simulationTimeMs: state.simulationMs,
      state: state,
      events: events || [],
    }).then(function (result) {
      if (result && result.ok) {
        context.revision = result.revision;
        log("commit r" + result.revision);
      } else {
        log("commit failed: " + JSON.stringify(result && result.error));
      }
      return result;
    });
  }

  function advance(deltaMs) {
    if (!(deltaMs > 0)) return;
    state.simulationMs += deltaMs;
    var growth = deltaMs / 60000;
    for (var i = 0; i < state.plants.length; i += 1) {
      var plant = state.plants[i];
      plant.growth = Math.min(1, plant.growth + growth);
      plant.water = Math.max(0, plant.water - deltaMs / 120000);
    }
    state.bloom = Math.min(1, state.bloom + growth / 4);
  }

  function plantSeed(payload) {
    var seedId = String((payload && payload.seedId) || "seed-" + Date.now());
    if (state.plants.some(function (plant) { return plant.id === seedId; })) {
      return { seedId: seedId, duplicate: true };
    }
    if (state.water < 1) return { seedId: seedId, rejected: "no-water" };
    state.water -= 1;
    state.plants.push({
      id: seedId,
      growth: 0,
      water: 0.5,
      position: (payload && payload.position) || { x: 0.5, y: 0.5 },
    });
    return { seedId: seedId, plants: state.plants.length };
  }

  function waterPlants() {
    state.water = Math.min(30, state.water + 4);
    for (var i = 0; i < state.plants.length; i += 1) {
      state.plants[i].water = Math.min(1, state.plants[i].water + 0.2);
    }
    return { water: state.water };
  }

  function handleCommand(command) {
    var result;
    if (command.type === "plant.seed") {
      result = plantSeed(command.payload);
    } else if (command.type === "plant.water") {
      result = waterPlants();
    } else {
      result = { rejected: "unknown-command" };
    }
    commit([{ type: "world.changed", payload: { command: command.type, result: result } }])
      .catch(function (error) { log("commit error " + error.message); })
      .finally(function () {
        request("command.result", {
          requestId: command.requestId,
          ok: !result.rejected,
          result: result,
        }).catch(function () {});
      });
  }

  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.v !== PROTOCOL) return;

    if (data.type === "init") {
      context = data.context;
      if (data.snapshot && data.snapshot.state) {
        state = data.snapshot.state;
      }
      log("init epoch=" + context.authorityEpoch + " revision=" + context.revision);
      request("ready", {}).catch(function (error) { log("ready failed " + error.message); });
      return;
    }

    if (data.type === "snapshot" && data.snapshot && data.snapshot.state) {
      state = data.snapshot.state;
      context.revision = data.snapshot.revision;
      log("snapshot r" + data.snapshot.revision);
      return;
    }

    if (data.type === "tick") {
      advance(Number(data.tick.deltaMs) || 0);
      commit().catch(function (error) { log("tick commit error " + error.message); });
      return;
    }

    if (data.type === "lifecycle") {
      var event = data.event || {};
      log("lifecycle " + event.state + (event.reason ? " (" + event.reason + ")" : ""));
      if (event.state === "resumed" && event.offlineMs) {
        advance(Math.min(Number(event.offlineMs) || 0, 7 * 24 * 3600 * 1000));
        commit([{ type: "task.completed", payload: { reason: "offline" } }]).catch(function () {});
      }
      if (event.state === "stopped") {
        commit().catch(function () {});
      }
      return;
    }

    if (data.type === "command") {
      handleCommand(data.command);
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
