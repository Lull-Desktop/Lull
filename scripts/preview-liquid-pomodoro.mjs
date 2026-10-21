/**
 * 用无头 Chrome 给液态番茄钟拍预览图（不进入 Tauri）。
 * 仅在开发时手动运行：node scripts/preview-liquid-pomodoro.mjs
 * 页面本身是透明浮窗，这里垫一层模拟桌面的森林光斑，便于检查玻璃质感。
 */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const APP_URL =
  process.env.PREVIEW_URL ?? "http://127.0.0.1:3000/pomodoro";
const OUT_DIR = path.resolve("docs");
const PROFILE_DIR = path.resolve(".chrome-preview-pomodoro");
const DEBUG_PORT = 9333;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForJson(url, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // Chrome 还没监听调试端口。
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function createCdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
      return;
    }
    const waiting = listeners.get(message.method);
    if (!waiting?.length) return;
    const [entry, ...rest] = waiting;
    listeners.set(message.method, rest);
    entry.resolve(message.params);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      nextId += 1;
      pending.set(nextId, { resolve, reject });
      socket.send(JSON.stringify({ id: nextId, method, params }));
    });

  const waitEvent = (method, timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const entry = {
        resolve: (params) => {
          clearTimeout(timer);
          resolve(params);
        },
      };
      const list = listeners.get(method) ?? [];
      listeners.set(method, [...list, entry]);
    });

  return { socket, send, waitEvent };
}

async function main() {
  await rm(PROFILE_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
    await waitForJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    const page = await (
      await fetch(
        `http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`,
        { method: "PUT" },
      )
    ).json();
    const cdp = await createCdp(page.webSocketDebuggerUrl);
    const { send, waitEvent } = cdp;

    await send("Page.enable");
    await send("Runtime.enable");

    const evaluate = async (expression) => {
      const response = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (response.exceptionDetails) {
        throw new Error(
          response.exceptionDetails.exception?.description ??
            response.exceptionDetails.text,
        );
      }
      return response.result?.value;
    };

    const navigate = async (url) => {
      const loaded = waitEvent("Page.loadEventFired");
      await send("Page.navigate", { url });
      await loaded;
    };

    const waitFor = async (expression, timeoutMs = 8000) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (await evaluate(expression)) return;
        await sleep(80);
      }
      throw new Error(`Timed out waiting for: ${expression}`);
    };

    await send("Emulation.setDeviceMetricsOverride", {
      width: 600,
      height: 690,
      deviceScaleFactor: 2,
      mobile: false,
    });

    await navigate(APP_URL);
    await sleep(1000);

    // 种入两枚已完成珍珠，让预览接近参考图里的「前两颗点亮」状态。
    await evaluate(`localStorage.setItem("lull:pomodoro:v1", JSON.stringify({
      focusMinutes: 25,
      shortBreakMinutes: 5,
      longBreakMinutes: 15,
      autoStart: false,
      sound: false,
      completedFocus: 2
    }))`);
    await navigate(APP_URL);
    await waitFor(
      `document.documentElement.classList.contains("lull-transparent-window")`,
    );
    await waitFor(
      `document.querySelector('[class*="beadsCount"]')?.textContent.trim().startsWith("02")`,
    );

    // 模拟桌面壁纸：深林、雾与暖色光斑。只在截图浏览器里存在。
    await evaluate(`(() => {
      const root = document.querySelector('[class*="root"]');
      if (root) root.style.zIndex = "2";
      const layer = document.createElement("div");
      layer.id = "lull-preview-bg";
      layer.style.cssText = "position:fixed;inset:0;z-index:0;pointer-events:none;";
      const bg = document.createElement("div");
      bg.style.cssText = "position:absolute;inset:0;background:" + [
        "radial-gradient(ellipse 80% 60% at 20% 8%, rgba(96, 140, 96, .5), transparent 62%)",
        "radial-gradient(ellipse 70% 55% at 86% 78%, rgba(28, 92, 98, .55), transparent 66%)",
        "radial-gradient(ellipse 60% 40% at 48% 110%, rgba(8, 38, 32, .8), transparent 72%)",
        "linear-gradient(158deg, #0e231a 0%, #0a1c23 46%, #06131b 100%)"
      ].join(",");
      const haze = document.createElement("div");
      haze.style.cssText = "position:absolute;inset:0;filter:blur(34px);background:" + [
        "radial-gradient(circle at 78% 16%, rgba(255, 232, 172, .3) 0 7%, transparent 19%)",
        "radial-gradient(circle at 88% 27%, rgba(255, 222, 158, .22) 0 4%, transparent 13%)",
        "radial-gradient(circle at 68% 9%, rgba(255, 245, 205, .18) 0 9%, transparent 23%)",
        "radial-gradient(ellipse 70% 30% at 50% 0%, rgba(188, 224, 174, .18), transparent 70%)"
      ].join(",");
      const vignette = document.createElement("div");
      vignette.style.cssText = "position:absolute;inset:0;background:radial-gradient(ellipse 62% 58% at 50% 46%, transparent 38%, rgba(2, 10, 8, .5) 100%)";
      layer.append(bg, haze, vignette);
      document.body.insertBefore(layer, document.body.firstChild);
      window.__previewNow = Date.now.bind(Date);
      window.__previewOffset = 0;
      Date.now = () => window.__previewNow() + window.__previewOffset;
      window.__advance = (ms) => { window.__previewOffset += ms; };
    })()`);

    await sleep(400);
    const measured = await evaluate(
      `Math.ceil(document.querySelector('[class*="root"]').getBoundingClientRect().height)`,
    );
    const height = Math.max(620, measured);
    await send("Emulation.setDeviceMetricsOverride", {
      width: 600,
      height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await sleep(400);
    await evaluate(
      `document.fonts ? document.fonts.ready.then(() => true) : Promise.resolve(true)`,
    );
    await sleep(900);

    const shot = async (name) => {
      const result = await send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      const file = path.join(OUT_DIR, name);
      await writeFile(file, Buffer.from(result.data, "base64"));
      console.log("wrote", file);
    };

    const clickButton = async (label, exact = false) => {
      const clicked = await evaluate(`(() => {
        const target = [...document.querySelectorAll("button")].find((button) => {
          const name = button.getAttribute("aria-label") || button.textContent.trim();
          return ${exact ? `name === ${JSON.stringify(label)}` : `name.startsWith(${JSON.stringify(label)})`};
        });
        if (!target) return false;
        target.click();
        return true;
      })()`);
      if (!clicked) throw new Error(`button not found: ${label}`);
    };

    const waitCeremony = async (name, timeout = 8000) => {
      await waitFor(
        `document.querySelector('[class*="root"]').dataset.ceremony === ${JSON.stringify(name)}`,
        timeout,
      );
    };

    await shot("pomodoro-preview-focus.png");

    // 外圈滚轮逐格调到 10 分钟：截一张刻度盘浮出的状态，确认弧条与手柄压在液体前方。
    for (let i = 0; i < 15; i += 1) {
      await evaluate(
        `document.querySelector('[class*="orbStage"]').dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true }))`,
      );
      await sleep(40);
    }
    await sleep(220);
    await shot("pomodoro-preview-dial.png");
    for (let i = 0; i < 15; i += 1) {
      await evaluate(
        `document.querySelector('[class*="orbStage"]').dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }))`,
      );
      await sleep(40);
    }
    await sleep(1500);

    // 启动计时：点击主按钮后液面开始连续下降。
    await clickButton("开始专注", true);
    await sleep(1500);
    await shot("pomodoro-preview-running.png");

    // 把时间快进 17 分钟：≈08:00，液面约三分之一。
    await evaluate(`window.__advance(${17 * 60 * 1000})`);
    await sleep(900);
    await shot("pomodoro-preview-drained.png");

    // 快进到 0：抓四拍仪式的脉冲 / 涟漪 / 蜕变。
    await evaluate(`window.__advance(${8 * 60 * 1000})`);
    await waitCeremony("pulse");
    await sleep(230);
    await shot("pomodoro-preview-pulse.png");

    await waitCeremony("ripple");
    await sleep(430);
    await shot("pomodoro-preview-ripple.png");

    await waitCeremony("transform");
    await sleep(620);
    await shot("pomodoro-preview-transform.png");
    await sleep(1600);
    await shot("pomodoro-preview-break.png");

    // 设置浮层。
    await evaluate(
      `document.querySelector('[class*="settingsAnchor"]').click()`,
    );
    await sleep(500);
    await shot("pomodoro-preview-settings.png");

    console.log("viewport", { width: 600, height });
    cdp.socket.close();
  } finally {
    chrome.kill();
    await sleep(500);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
