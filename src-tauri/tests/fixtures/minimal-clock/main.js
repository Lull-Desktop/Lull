/**
 * 极简时钟：不依赖 @lull/widget-sdk，不需要任何宿主能力。
 * 页面对着时间自己走；只在秒数变化时更新文本，避免每秒重排整块布局。
 */
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

const timeEl = document.getElementById("time");
const secondsEl = document.getElementById("seconds");
const dateEl = document.getElementById("date");

const pad = (value) => String(value).padStart(2, "0");

let lastSecond = -1;

function render() {
  const now = new Date();
  if (now.getSeconds() === lastSecond) {
    requestAnimationFrame(render);
    return;
  }
  lastSecond = now.getSeconds();

  timeEl.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  secondsEl.textContent = pad(now.getSeconds());
  dateEl.textContent =
    `${now.getFullYear()}年${pad(now.getMonth() + 1)}月${pad(now.getDate())}日 ` +
    `星期${WEEKDAYS[now.getDay()]}`;

  // 秒数跳变时的轻微闪动，纯装饰
  secondsEl.classList.add("tick");
  setTimeout(() => secondsEl.classList.remove("tick"), 180);

  requestAnimationFrame(render);
}

render();
