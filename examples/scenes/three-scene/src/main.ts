/**
 * Three.js 示例场景：TorusKnot + 星尘 + 参数热更。
 *
 * Setting 改参数 → Scene SDK 的 onFrame → 这里更新材质/相机/粒子数，
 * 不重建 iframe、不重启壁纸。
 *
 * 构建：pnpm scenes:samples:build
 */
import { connectLullScene, type SceneFrame } from "@lull/scene-sdk";
import * as THREE from "three";

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x05070c, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x05070c, 0.08);

const camera = new THREE.PerspectiveCamera(
  55,
  (window.innerWidth || 1280) / (window.innerHeight || 720),
  0.1,
  100,
);
camera.position.set(0, 0, 4.6);
camera.lookAt(0, 0, 0);

scene.add(new THREE.AmbientLight(0x8fb7ff, 0.55));
const keyLight = new THREE.PointLight(0xffffff, 26, 24, 2);
keyLight.position.set(3.5, 4, 5);
scene.add(keyLight);
const rimLight = new THREE.PointLight(0x3fe0c8, 20, 24, 2);
rimLight.position.set(-4, -2.5, -4);
scene.add(rimLight);

const group = new THREE.Group();
scene.add(group);

const material = new THREE.MeshStandardMaterial({
  color: 0x7fd6c8,
  roughness: 0.28,
  metalness: 0.65,
  wireframe: true,
});
const knot = new THREE.Mesh(
  new THREE.TorusKnotGeometry(1, 0.32, 220, 28),
  material,
);
group.add(knot);

const starMaterial = new THREE.PointsMaterial({
  color: 0x9fe8dd,
  size: 0.016,
  transparent: true,
  opacity: 0.72,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});
let stars: THREE.Points | null = null;
let starCount = 0;
let speed = 0.35;
let tilt = THREE.MathUtils.degToRad(18);
let visible = true;
let reduced = false;
let syncEnabled = false;
let syncEpoch = 0;
let phase = 0;
let width = 0;
let height = 0;

function rebuildStars(nextCount: number): void {
  const count = Math.max(300, Math.min(5000, Math.round(nextCount)));
  if (count === starCount) return;
  starCount = count;
  if (stars) {
    group.remove(stars);
    stars.geometry.dispose();
  }
  const positions = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    const radius = 2.4 + Math.random() * 5;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[index * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    positions[index * 3 + 2] = radius * Math.cos(phi);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  stars = new THREE.Points(geometry, starMaterial);
  group.add(stars);
}

function resize(nextWidth: number, nextHeight: number, dpr: number): void {
  const w = Math.max(1, Math.round(nextWidth));
  const h = Math.max(1, Math.round(nextHeight));
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || dpr || 1, 2));
  if (w === width && h === height) return;
  width = w;
  height = h;
  renderer.setSize(w, h, true);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function apply(frame: SceneFrame): void {
  const params = frame.params;
  const nextSpeed = Number(params.speed ?? 0.35);
  speed = Number.isFinite(nextSpeed) ? nextSpeed : 0.35;
  reduced = frame.reducedMotion;
  tilt = THREE.MathUtils.degToRad(Number(params.tilt ?? 18));
  material.color.set(String(params.tint ?? "#7fd6c8"));
  const nextWireframe = params.wireframe !== false;
  if (material.wireframe !== nextWireframe) {
    material.wireframe = nextWireframe;
    material.needsUpdate = true;
  }
  rebuildStars(Number(params.particles ?? 1600));
  resize(frame.viewport.w, frame.viewport.h, frame.viewport.dpr || frame.dpr);

  if (frame.sync.enabled) {
    if (!syncEnabled || syncEpoch !== frame.sync.epochMs) {
      syncEpoch = frame.sync.epochMs;
      phase = (Date.now() - syncEpoch) / 1000;
    }
    syncEnabled = true;
  } else {
    syncEnabled = false;
  }
}

function fallbackFrame(): SceneFrame {
  return {
    mode: "mirror",
    layout: "viewport",
    sync: { enabled: false, epochMs: 0 },
    viewport: {
      w: window.innerWidth || 1280,
      h: window.innerHeight || 720,
      dpr: window.devicePixelRatio || 1,
    },
    canvas: null,
    view: null,
    dpr: window.devicePixelRatio || 1,
    params: {
      speed: 0.35,
      particles: 1600,
      tint: "#7fd6c8",
      wireframe: true,
      tilt: 18,
    },
    reducedMotion:
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false,
    performance: null,
  };
}

apply(fallbackFrame());

let last = performance.now();
function animate(now: number): void {
  requestAnimationFrame(animate);
  const delta = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  if (!visible) return;
  if (!reduced) phase += delta * speed;
  group.rotation.y = phase;
  group.rotation.x = tilt + Math.sin(phase * 0.35) * 0.08;
  if (stars) stars.rotation.y = -phase * 0.18;
  renderer.render(scene, camera);
}
requestAnimationFrame(animate);

try {
  const lull = await connectLullScene();
  lull.onFrame(apply);
  lull.onVisibility((nextVisible) => {
    visible = nextVisible;
  });
  lull.log("Three.js scene ready");
} catch (error) {
  // 直接用浏览器打开时没有宿主桥；保留默认动画便于预览。
  console.error("[three-scene] Scene host unavailable", error);
}

window.addEventListener("pagehide", () => {
  renderer.dispose();
  knot.geometry.dispose();
  material.dispose();
  starMaterial.dispose();
  stars?.geometry.dispose();
});
