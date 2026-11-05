/**
 * Stability Probe 指标墙（零构建只读 Replica 场景）。
 *
 * 用来验证 P3 的 mirror/span：两块显示器绑定同一个 scene，场景只读
 * `game.*` 消息，把 self-loop 的 frames / longFrames / contextLost / heap
 * 和 replica 的 displayId 画出来。
 */
(function () {
  "use strict";

  var PROTOCOL = 1;
  var canvas = document.getElementById("stage");
  var ctx = canvas.getContext("2d");
  var state = null;
  var context = null;
  var revision = 0;
  var eventFlash = 0;
  var lifecycle = "waiting";
  var unavailable = false;

  function post(message) {
    parent.postMessage(message, "*");
  }

  function resize() {
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
    canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function metric(label, value, x, y, width) {
    ctx.fillStyle = "rgba(127, 214, 255, 0.10)";
    ctx.fillRect(x, y, width, 64);
    ctx.strokeStyle = "rgba(127, 214, 255, 0.28)";
    ctx.strokeRect(x + 0.5, y + 0.5, width - 1, 63);
    ctx.fillStyle = "rgba(160, 198, 214, 0.72)";
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText(label, x + 14, y + 22);
    ctx.fillStyle = "#d8f2ff";
    ctx.font = "24px ui-monospace, Consolas, monospace";
    ctx.fillText(String(value), x + 14, y + 50);
  }

  function draw() {
    var width = window.innerWidth;
    var height = window.innerHeight;
    var gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "#07141c");
    gradient.addColorStop(1, "#04090d");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = "rgba(127, 214, 255, 0.85)";
    ctx.font = "600 18px system-ui, sans-serif";
    ctx.fillText("STABILITY PROBE", 28, 42);
    ctx.fillStyle = "rgba(160, 198, 214, 0.7)";
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText(
      "self-loop · " +
        (context && context.render
          ? context.render.displayId + " · " + context.render.mode
          : "等待宿主连接") +
        " · revision " +
        revision +
        " · " +
        lifecycle,
      28,
      64,
    );

    if (!state) {
      ctx.fillStyle = "rgba(160, 198, 214, 0.8)";
      ctx.font = "14px system-ui, sans-serif";
      ctx.fillText(
        unavailable
          ? "游戏未运行：在设置页「游戏」启动 community.stability-probe"
          : context
            ? "已连接，等待首份快照…"
            : "等待游戏实例与首份快照…",
        28,
        112,
      );
      requestAnimationFrame(draw);
      return;
    }

    var margin = 28;
    var gap = 12;
    var cardWidth = Math.max(120, (width - margin * 2 - gap * 2) / 3);
    var top = 100;
    metric("frames", state.frames || 0, margin, top, cardWidth);
    metric(
      "avg frame ms",
      state.avgFrameMs ? state.avgFrameMs.toFixed(2) : "0",
      margin + cardWidth + gap,
      top,
      cardWidth,
    );
    metric(
      "worst frame ms",
      state.worstFrameMs ? state.worstFrameMs.toFixed(1) : "0",
      margin + (cardWidth + gap) * 2,
      top,
      cardWidth,
    );

    var second = top + 80;
    metric("long frames", state.longFrames || 0, margin, second, cardWidth);
    metric(
      "context lost",
      state.contextLost || 0,
      margin + cardWidth + gap,
      second,
      cardWidth,
    );
    metric(
      "heap MiB",
      state.heapUsed ? (state.heapUsed / 1024 / 1024).toFixed(1) : "—",
      margin + (cardWidth + gap) * 2,
      second,
      cardWidth,
    );

    ctx.fillStyle = "rgba(160, 198, 214, 0.65)";
    ctx.font = "12px ui-monospace, Consolas, monospace";
    ctx.fillText(
      "sim " +
        Math.round((state.simulationMs || 0) / 1000) +
        "s · ctx restored " +
        (state.contextRestored || 0) +
        " · r" +
        revision,
      margin,
      second + 92,
    );

    if (eventFlash > 0) {
      ctx.fillStyle = "rgba(127, 214, 255, " + eventFlash * 0.12 + ")";
      ctx.fillRect(0, 0, width, height);
    }

    if (lifecycle === "suspended" || lifecycle === "failed") {
      ctx.fillStyle = "rgba(3, 7, 10, 0.56)";
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "rgba(216, 242, 255, 0.9)";
      ctx.font = "16px system-ui, sans-serif";
      ctx.fillText(
        lifecycle === "failed" ? "游戏不可用" : "游戏已暂停",
        28,
        100,
      );
    }

    requestAnimationFrame(draw);
  }

  window.addEventListener("resize", resize);

  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.v !== PROTOCOL) return;

    if (data.type === "game.init") {
      context = data.context;
      revision = Number(data.context.revision) || 0;
      state = data.snapshot && data.snapshot.state;
      unavailable = false;
      lifecycle = "running";
      if (!data.snapshot) {
        // 快照可能晚于 init 到达；宿主会回应 game.snapshot。
        post({ v: PROTOCOL, type: "game.requestSnapshot" });
      }
      return;
    }
    if (data.type === "game.snapshot") {
      state = data.snapshot.state;
      revision = Number(data.snapshot.revision) || revision;
      return;
    }
    if (data.type === "game.event") {
      eventFlash = 1;
      return;
    }
    if (data.type === "game.lifecycle") {
      lifecycle = (data.event && data.event.state) || lifecycle;
      return;
    }
    if (data.type === "game.unavailable") {
      unavailable = true;
      lifecycle = "waiting";
    }
  });

  resize();
  draw();

  post({ v: PROTOCOL, type: "game.ready" });

  setInterval(function () {
    if (eventFlash > 0) eventFlash = Math.max(0, eventFlash - 0.1);
  }, 80);
})();
