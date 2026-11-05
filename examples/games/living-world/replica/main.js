/**
 * Living World · 森林（游戏包内置渲染副本，零构建）。
 *
 * 同一个游戏包同时包含 authority（逻辑/提交）与 replica（本页，只读渲染）。
 * 直接实现 docs/game-runtime.md 的 game.* 消息，正式游戏建议使用
 * `@lull/game-sdk/scene`；只读：没有 commitState / command / publishEvent。
 */
(function () {
  "use strict";

  var PROTOCOL = 1;
  var canvas = document.getElementById("stage");
  var ctx = canvas.getContext("2d");
  var state = null;
  var eventFlash = 0;
  var lastLifecycle = "idle";

  function post(message) {
    parent.postMessage(message, "*");
  }

  function resize() {
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
    canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw() {
    var width = window.innerWidth;
    var height = window.innerHeight;
    var gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "#0a1a16");
    gradient.addColorStop(0.6, "#0f2a21");
    gradient.addColorStop(1, "#07110f");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    var plants = (state && state.plants) || [];
    for (var index = 0; index < plants.length; index += 1) {
      var plant = plants[index];
      var x = width * (plant.position && plant.position.x ? plant.position.x : (index + 0.5) / Math.max(1, plants.length));
      var baseY = height * 0.78;
      var heightPx = 40 + plant.growth * height * 0.42;
      var sway = Math.sin(Date.now() / 1400 + index) * 6;
      ctx.strokeStyle = "rgba(143, 216, 176, 0.9)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, baseY);
      ctx.quadraticCurveTo(x + sway, baseY - heightPx * 0.6, x + sway * 1.6, baseY - heightPx);
      ctx.stroke();
      ctx.fillStyle = "rgba(143, 216, 176, 0.75)";
      ctx.beginPath();
      ctx.arc(x + sway * 1.6, baseY - heightPx, 8 + plant.growth * 14, 0, Math.PI * 2);
      ctx.fill();
    }

    if (state) {
      var water = Math.max(0, Math.min(30, state.water || 0));
      ctx.fillStyle = "rgba(143, 216, 176, 0.25)";
      ctx.fillRect(0, 0, width, 4);
      ctx.fillStyle = "rgba(143, 216, 176, 0.85)";
      ctx.fillRect(0, 0, (width * water) / 30, 4);
    }

    if (eventFlash > 0) {
      ctx.fillStyle = "rgba(143, 216, 176, " + eventFlash * 0.18 + ")";
      ctx.fillRect(0, 0, width, height);
    }

    if (lastLifecycle === "suspended" || lastLifecycle === "failed") {
      ctx.fillStyle = "rgba(5, 10, 16, 0.55)";
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "rgba(207, 232, 223, 0.8)";
      ctx.font = "13px system-ui, sans-serif";
      ctx.fillText(lastLifecycle === "failed" ? "游戏不可用" : "游戏已暂停", 20, 28);
    }

    requestAnimationFrame(draw);
  }

  window.addEventListener("resize", resize);

  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.v !== PROTOCOL) return;

    if (data.type === "game.init") {
      state = data.snapshot && data.snapshot.state;
      lastLifecycle = "running";
      if (!state) post({ v: PROTOCOL, type: "game.requestSnapshot" });
      return;
    }
    if (data.type === "game.snapshot") {
      state = data.snapshot.state;
      return;
    }
    if (data.type === "game.event") {
      eventFlash = 1;
      return;
    }
    if (data.type === "game.lifecycle") {
      lastLifecycle = (data.event && data.event.state) || lastLifecycle;
      return;
    }
    if (data.type === "game.unavailable") {
      lastLifecycle = "idle";
    }
  });

  resize();
  draw();

  // 告诉宿主 replica 已就绪；未绑定/未运行时宿主回 game.unavailable。
  post({ v: PROTOCOL, type: "game.ready" });

  setInterval(function () {
    if (eventFlash > 0) eventFlash = Math.max(0, eventFlash - 0.08);
  }, 80);
})();
