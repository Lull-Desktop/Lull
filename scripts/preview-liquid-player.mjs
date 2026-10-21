/**
 * 用无头 Chrome 给液态黑胶播放器拍预览图（不进入 Tauri）。
 * 仅在开发时手动运行：node scripts/preview-liquid-player.mjs
 * 页面本身是透明浮窗，这里在 body 后面垫一层虚拟黄昏山景，
 * 便于检查玻璃质感、四边 10px 渐隐和窗口收放。
 */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const APP_URL = process.env.PREVIEW_URL ?? "http://127.0.0.1:3000/player";
const OUT_DIR = path.resolve("docs");
const PROFILE_DIR = path.join(tmpdir(), "lull-player-preview");
const DEBUG_PORT = 9334;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForJson(url, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // Chrome 还没开始监听调试端口。
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

/** 虚拟桌面壁纸：黄昏、山脊、薄雾与低位阳光。仅在截图浏览器里存在。 */
function backdropSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="sky" x1="0.1" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#081525"/>
      <stop offset="0.42" stop-color="#193a5c"/>
      <stop offset="0.66" stop-color="#6f667a"/>
      <stop offset="0.82" stop-color="#d49178"/>
      <stop offset="1" stop-color="#f2c49b"/>
    </linearGradient>
    <radialGradient id="sun" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#ffe4b5" stop-opacity="0.85"/>
      <stop offset="0.5" stop-color="#ffc98a" stop-opacity="0.3"/>
      <stop offset="1" stop-color="#ffc98a" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="far" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#55708a"/>
      <stop offset="1" stop-color="#334c66"/>
    </linearGradient>
    <linearGradient id="mid" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a4058"/>
      <stop offset="1" stop-color="#162a3e"/>
    </linearGradient>
    <linearGradient id="near" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#111f30"/>
      <stop offset="1" stop-color="#050b13"/>
    </linearGradient>
    <filter id="soft"><feGaussianBlur stdDeviation="26"/></filter>
  </defs>
  <rect width="1600" height="1000" fill="url(#sky)"/>
  <ellipse cx="1180" cy="660" rx="350" ry="250" fill="url(#sun)"/>
  <g filter="url(#soft)" opacity="0.6">
    <ellipse cx="340" cy="370" rx="520" ry="95" fill="#56738e" opacity="0.25"/>
    <ellipse cx="1060" cy="300" rx="460" ry="72" fill="#9d8f98" opacity="0.25"/>
    <ellipse cx="810" cy="520" rx="600" ry="60" fill="#e2a782" opacity="0.18"/>
  </g>
  <circle cx="1180" cy="650" r="48" fill="#ffe6bb" opacity="0.7"/>
  <path d="M0 610 L120 540 L230 585 L355 470 L470 555 L590 505 L710 585 L830 500 L950 575 L1050 520 L1180 600 L1290 535 L1420 600 L1530 550 L1600 600 L1600 1000 L0 1000 Z" fill="url(#far)" opacity="0.6"/>
  <path d="M0 690 L150 615 L285 678 L420 580 L560 672 L690 620 L820 700 L960 610 L1100 692 L1240 625 L1390 700 L1510 640 L1600 690 L1600 1000 L0 1000 Z" fill="url(#mid)" opacity="0.82"/>
  <path d="M0 790 L180 720 L360 780 L540 700 L720 790 L900 725 L1090 800 L1270 730 L1450 800 L1600 750 L1600 1000 L0 1000 Z" fill="url(#near)"/>
  <path d="M0 880 C220 840 420 900 640 860 C880 816 1120 890 1360 845 C1460 828 1540 846 1600 836 L1600 1000 L0 1000 Z" fill="#04080d" opacity="0.85"/>
</svg>`;
}

/** 三秒 220Hz 的 WAV，用来验证本地文件导入、元数据与播放链路。 */
function makeTestWav(seconds = 3, sampleRate = 8000) {
  const samples = Math.floor(seconds * sampleRate);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.sin((2 * Math.PI * 220 * index) / sampleRate) * 0.18;
    buffer.writeInt16LE(Math.round(value * 32767), 44 + index * 2);
  }
  return buffer;
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
      "--force-color-profile=srgb",
      "--autoplay-policy=no-user-gesture-required",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let cdp;
  try {
    await waitForJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    const page = await (
      await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, {
        method: "PUT",
      })
    ).json();
    cdp = await createCdp(page.webSocketDebuggerUrl);
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

    const waitFor = async (expression, timeoutMs = 10000) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (await evaluate(expression)) return;
        await sleep(80);
      }
      throw new Error(`Timed out waiting for: ${expression}`);
    };

    const setViewport = async (width, height = 552) => {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 2,
        mobile: false,
      });
    };

    await setViewport(880);
    await navigate(APP_URL);
    await waitFor(
      `document.documentElement.classList.contains("lull-transparent-window")`,
    );
    await waitFor(
      `Boolean(document.querySelector('[class*="orbTitle"]')?.textContent)`,
    );
    console.log(
      "backgrounds",
      await evaluate(`(() => {
        const root = document.querySelector('[class*="root"]');
        return {
          html: getComputedStyle(document.documentElement).backgroundColor,
          body: getComputedStyle(document.body).backgroundColor,
          root: root ? getComputedStyle(root).backgroundColor : "missing",
          rootAfter: root ? getComputedStyle(root, "::after").content : "missing",
          ambientLayer: Boolean(document.querySelector('[class*="ambient"]'))
        };
      })()`),
    );

    // 壁纸垫在 root 后面：root 四边 10px 渐隐后能透出同一张壁纸，不会露白边。
    const backdrop = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(backdropSvg())}`;
    await evaluate(`(() => {
      const root = document.querySelector('[class*="root"]');
      if (!root) return false;
      root.style.zIndex = "1";
      const layer = document.createElement("div");
      layer.id = "lull-player-backdrop";
      layer.style.cssText = "position:fixed;inset:0;z-index:0;pointer-events:none;background-size:cover;background-position:center;";
      layer.style.backgroundImage = "url(" + ${JSON.stringify(`"${backdrop}"`)} + ")";
      document.body.insertBefore(layer, document.body.firstChild);
      const vignette = document.createElement("div");
      vignette.style.cssText = "position:fixed;inset:0;z-index:0;pointer-events:none;background:radial-gradient(ellipse 76% 78% at 48% 42%, transparent 42%, rgba(2,7,14,.4) 100%);";
      document.body.insertBefore(vignette, layer.nextSibling);
      return true;
    })()`);

    await evaluate(
      `document.fonts ? document.fonts.ready.then(() => true) : Promise.resolve(true)`,
    );
    await sleep(1000);

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

    const clickButton = async (labelStart) => {
      const clicked = await evaluate(`(() => {
        const target = [...document.querySelectorAll("button")].find((button) => {
          const name = button.getAttribute("aria-label") || "";
          return name.startsWith(${JSON.stringify(labelStart)});
        });
        if (!target) return false;
        target.click();
        return true;
      })()`);
      if (!clicked) throw new Error(`button not found: ${labelStart}`);
    };

    // 播放状态：频响涟漪、封面暖光和进度环能量点同时出现。
    await clickButton("播放：");
    await waitFor(
      `document.querySelector('[class*="root"]').dataset.playing === "true"`,
    );
    await sleep(700);

    // 真实鼠标事件拖到约 60%，让预览停在参考稿的 02:3x 进度。
    const ringPoint = await evaluate(`(() => {
      const svg = document.querySelector('svg[class*="ring"]');
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const radius = (rect.width / 2) * 0.9368;
      const ratio = 0.605;
      const angle = ratio * Math.PI * 2 - Math.PI / 2;
      return {
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      };
    })()`);
    if (ringPoint) {
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: ringPoint.x,
        y: ringPoint.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: ringPoint.x,
        y: ringPoint.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
    }
    await sleep(1000);
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 12,
      y: 12,
      button: "none",
      buttons: 0,
    });
    await evaluate(
      `document.activeElement instanceof HTMLElement ? document.activeElement.blur() : false`,
    );
    await sleep(250);
    await shot("liquid-player-preview.png");

    // 曲库左停靠：抽屉雾化退场，播放器与曲库一起 materialize 到左侧。
    // 先把换边动画暂停并定格在 300ms 抓一张中间帧，再等仪式结束后抓稳定态。
    await evaluate(
      `[...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "曲库改从左侧弹出")?.click()`,
    );
    await waitFor(
      `document.querySelector(".liquid-player-root")?.dataset.dockSwitching === "true"`,
      5000,
    );
    await evaluate(`(() => {
      for (const animation of document.getAnimations()) {
        const name = animation.animationName || "";
        if (!/materialize|veilWash/i.test(name)) continue;
        try {
          animation.pause();
          animation.currentTime = 300;
        } catch {
          // 已结束的动画无法定格，忽略即可。
        }
      }
      return true;
    })()`);
    await shot("liquid-player-switch.png");
    await evaluate(`document.getAnimations().forEach((animation) => animation.play())`);
    await waitFor(
      `document.querySelector(".liquid-player-root")?.dataset.dockSwitching === "false"`,
      5000,
    );
    await shot("liquid-player-left.png");
    await evaluate(
      `[...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "曲库改从右侧弹出")?.click()`,
    );
    await waitFor(
      `document.querySelector(".liquid-player-root")?.dataset.dockSwitching === "false"`,
      5000,
    );

    // 本地来源空态。
    await evaluate(
      `[...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent.includes("本地"))?.click()`,
    );
    await sleep(650);
    await shot("liquid-player-local.png");

    const orbBefore = await evaluate(`(() => {
      const rect = document.querySelector('[class*="orbFloat"]')?.getBoundingClientRect();
      return rect ? { x: Math.round(rect.x), y: Math.round(rect.y) } : null;
    })()`);

    // 收起抽屉：浏览器用视口宽度模拟 Tauri 的 880 → 530 收窗。
    await evaluate(
      `[...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "曲库")?.click()`,
    );
    await sleep(760);
    await setViewport(530);
    await sleep(450);
    const orbAfter = await evaluate(`(() => {
      const rect = document.querySelector('[class*="orbFloat"]')?.getBoundingClientRect();
      return rect ? { x: Math.round(rect.x), y: Math.round(rect.y) } : null;
    })()`);
    console.log("orb fixed during drawer toggle", { orbBefore, orbAfter });
    await shot("liquid-player-closed.png");

    // 模拟小屏可用高度：确认页面被锁死在视口内，不出现原生滚动条。
    await setViewport(530, 525);
    await sleep(350);
    console.log(
      "overflow@530x525",
      await evaluate(`({
        scrollHeight: document.documentElement.scrollHeight,
        bodyHeight: document.body.scrollHeight,
        innerHeight: window.innerHeight,
        rootHeight: Math.round(document.querySelector('[class*="root"]').getBoundingClientRect().height)
      })`),
    );
    await setViewport(530);
    await sleep(250);

    // 本地文件链路验证：展开抽屉，塞入一段 3 秒 WAV。
    await setViewport(880);
    await sleep(350);
    await evaluate(
      `[...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "曲库")?.click()`,
    );
    await sleep(720);
    const wavBase64 = makeTestWav().toString("base64");
    const added = await evaluate(`(() => {
      try {
        const bytes = Uint8Array.from(atob(${JSON.stringify(wavBase64)}), (char) => char.charCodeAt(0));
        const file = new File([bytes], "Aurora Lane - Test Tone.wav", { type: "audio/wav" });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        const input = document.querySelector('input[type="file"]');
        if (!input) return "no-input";
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return "ok";
      } catch (error) {
        return String(error);
      }
    })()`);
    console.log("local import", added);
    await waitFor(
      `[...document.querySelectorAll("button")].some((button) => (button.getAttribute("aria-label") || "").startsWith("Test Tone"))`,
      8000,
    );
    await sleep(900);
    await evaluate(
      `[...document.querySelectorAll("button")].find((button) => (button.getAttribute("aria-label") || "").startsWith("Test Tone"))?.click()`,
    );
    await waitFor(
      `document.querySelector('[class*="root"]').dataset.playing === "true"`,
      8000,
    );
    await sleep(900);
    console.log(
      "local state",
      await evaluate(`({
        time: document.querySelector('[role="slider"][aria-label="播放进度"]')?.getAttribute("aria-valuetext"),
        track: document.querySelector('[class*="orbTitle"]')?.textContent,
        duration: document.querySelector('[class*="orbArtist"]')?.textContent
      })`),
    );
    await shot("liquid-player-local-track.png");

    console.log("viewport", { open: 880, compact: 530, height: 552 });
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
