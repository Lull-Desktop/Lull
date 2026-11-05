/**
 * Stability Probe Authority（P3 self-loop + WebGL）。
 *
 * 目的不是好玩，而是把隐藏 WebView2 的稳定性问题变成可提交的数据：
 * - 自己用 requestAnimationFrame 驱动循环（runtime.authority = self-loop）；
 * - 用 WebGL 绘制，监听 webglcontextlost / restored；
 * - 每秒把 frames/longFrames/worstFrameMs/contextLost/heap 提交到宿主；
 * - 每 30s publish 一次 probe.stats 事件，便于看 journal。
 *
 * 正式游戏应使用 @lull/game-sdk；这里直接实现 v1 协议以便零构建运行。
 */
(function () {
  "use strict";

  var PROTOCOL = 1;
  var LONG_FRAME_MS = 50;
  var COMMIT_INTERVAL_MS = 1000;
  var EVENT_INTERVAL_MS = 30000;
  var context = null;
  var ready = false;
  var sequence = 0;
  var pending = new Map();
  var lastCommitAt = 0;
  var lastEventAt = 0;
  var lastFrameAt = null;
  var lastTickAt = 0;
  var tickTimer = null;
  var frames = 0;
  var frameCount = 0;
  var frameSum = 0;
  var longFrames = 0;
  var worstFrameMs = 0;
  var contextLost = 0;
  var contextRestored = 0;
  var firstHeap = null;
  var lastHeap = null;

  function initialState() {
    return {
      simulationMs: 0,
      frames: 0,
      longFrames: 0,
      worstFrameMs: 0,
      avgFrameMs: 0,
      contextLost: 0,
      contextRestored: 0,
      heapUsed: 0,
    };
  }

  var state = initialState();

  var canvas = document.getElementById("stage");
  var logLine = document.getElementById("log");
  var gl = canvas.getContext("webgl", { antialias: false, alpha: false });

  function log(message) {
    if (!logLine) return;
    logLine.textContent += "\n" + message;
    if (logLine.textContent.length > 4000) {
      logLine.textContent = logLine.textContent.slice(-3000);
    }
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

  function readHeap() {
    var memory = performance && performance.memory;
    if (!memory) return null;
    if (firstHeap === null) firstHeap = memory.usedJSHeapSize;
    lastHeap = memory.usedJSHeapSize;
    return lastHeap;
  }

  function resize() {
    var dpr = window.devicePixelRatio || 1;
    var width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    var height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      if (gl) gl.viewport(0, 0, width, height);
    }
  }

  function draw() {
    if (!gl) return;
    var t = state.simulationMs / 3000;
    gl.clearColor(
      0.02 + Math.abs(Math.sin(t)) * 0.1,
      0.08,
      0.07 + Math.abs(Math.cos(t)) * 0.08,
      1,
    );
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  function snapshotForCommit(events) {
    return request("state.commit", {
      authorityId: context.authorityId,
      authorityEpoch: context.authorityEpoch,
      baseRevision: Number(context.revision) || 0,
      simulationTimeMs: Math.round(Number(state.simulationMs) || 0),
      state: state,
      events: events || [],
    }).then(function (result) {
      if (result && result.ok) {
        context.revision = result.revision;
      } else {
        var body = (result && result.error) || {};
        log("commit failed " + JSON.stringify(body));
        // 让 game_runtime_diagnostics 的 lastErrorCode 能看到提交失败原因。
        request("error.report", {
          scope: "commit",
          code: body.code || "commit.failed",
          message: body.message || "state.commit 失败",
        }).catch(function () {});
      }
      return result;
    });
  }

  function commit(force) {
    if (!context) return Promise.resolve();
    if (!ready && !force) return Promise.resolve();
    var now = performance.now();
    if (!force && now - lastCommitAt < COMMIT_INTERVAL_MS) return Promise.resolve();
    lastCommitAt = now;
    readHeap();
    state.frames = frames;
    state.longFrames = longFrames;
    state.worstFrameMs = Math.round(worstFrameMs * 100) / 100;
    state.avgFrameMs =
      frameCount === 0 ? 0 : Math.round((frameSum / frameCount) * 100) / 100;
    state.contextLost = contextLost;
    state.contextRestored = contextRestored;
    state.heapUsed = lastHeap || 0;
    var events = [];
    if (lastEventAt === 0 || now - lastEventAt >= EVENT_INTERVAL_MS) {
      lastEventAt = now;
      events.push({
        type: "probe.stats",
        payload: {
          frames: frames,
          longFrames: longFrames,
          contextLost: contextLost,
          heapUsed: lastHeap || 0,
        },
      });
    }
    return snapshotForCommit(events).catch(function (error) {
      log("commit error " + error.message);
    });
  }

  function frame(timestamp) {
    if (lastFrameAt !== null) {
      var delta = timestamp - lastFrameAt;
      if (delta > 0) {
        frameCount += 1;
        frameSum += delta;
        if (delta > worstFrameMs) worstFrameMs = delta;
        if (delta > LONG_FRAME_MS) longFrames += 1;
      }
    }
    lastFrameAt = timestamp;
    frames += 1;
    resize();
    draw();
    requestAnimationFrame(frame);
  }

  // 模拟推进与提交用 timer 驱动，rAF 只负责渲染/帧统计。
  // 隐藏 WebView2 里 rAF 可能被暂停，此时 frames 会停在 0，但 commits 仍能
  // 通过 timer 暴露"JS 定时器是否还在跑"，这是 P3 报告要区分的两类问题。
  function tick() {
    if (!ready || !context) return;
    var now = performance.now();
    var delta = lastTickAt === 0 ? 1000 : Math.min(now - lastTickAt, 2000);
    lastTickAt = now;
    state.simulationMs = (Number(state.simulationMs) || 0) + delta;
    commit(true);
  }

  function startTicker() {
    if (tickTimer !== null) return;
    lastTickAt = 0;
    tickTimer = setInterval(tick, COMMIT_INTERVAL_MS);
    tick();
  }

  function stopTicker() {
    if (tickTimer !== null) clearInterval(tickTimer);
    tickTimer = null;
  }

  canvas.addEventListener("webglcontextlost", function (event) {
    contextLost += 1;
    event.preventDefault();
    log("webglcontextlost total=" + contextLost);
  });
  canvas.addEventListener("webglcontextrestored", function () {
    contextRestored += 1;
    log("webglcontextrestored total=" + contextRestored);
  });

  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.v !== PROTOCOL) return;

    if (data.type === "init") {
      context = data.context;
      // 首份快照可能是 {}（新实例）；合并默认字段，避免 simulationMs 变 undefined
      // 后 JSON 序列化成 null，触发 game_state_commit 的 u64 反序列化错误。
      state = Object.assign(
        initialState(),
        (data.snapshot && data.snapshot.state) || {},
      );
      log(
        "init epoch=" +
          context.authorityEpoch +
          " revision=" +
          context.revision +
          " mode=self-loop",
      );
      request("ready", {})
        .then(function () {
          ready = true;
          lastFrameAt = null;
          startTicker();
          requestAnimationFrame(frame);
        })
        .catch(function (error) {
          log("ready failed " + error.message);
        });
      return;
    }

    if (data.type === "snapshot" && data.snapshot) {
      context.revision = data.snapshot.revision;
      return;
    }

    if (data.type === "lifecycle") {
      var lifecycle = data.event || {};
      log("lifecycle " + lifecycle.state + (lifecycle.reason ? " (" + lifecycle.reason + ")" : ""));
      if (lifecycle.state === "resumed" && lifecycle.offlineMs) {
        state.simulationMs =
          (Number(state.simulationMs) || 0) +
          Math.min(Number(lifecycle.offlineMs) || 0, 604800000);
      }
      if (lifecycle.state === "stopped" || lifecycle.state === "suspended" || lifecycle.state === "failed") {
        ready = false;
        stopTicker();
        commit(true).catch(function () {});
      }
      if (lifecycle.state === "resumed" && !ready) {
        ready = true;
        startTicker();
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

  log("probe booted: webgl=" + Boolean(gl) + " self-loop");
  post({ v: PROTOCOL, type: "ready" });
})();
