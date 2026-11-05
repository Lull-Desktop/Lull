/**
 * Ambient Embers · Three.js replica（`entry.replica`）。
 *
 * 一个包同时包含 authority 与 replica；本页只读渲染，使用
 * `@lull/game-adapter-three` 驱动 rAF 循环、DPI 与生命周期。
 */
import { createThreeGameAdapter } from "@lull/game-adapter-three";
import { connectLullGameRender } from "@lull/game-sdk/scene";
import * as THREE from "three";

type Ember = { x: number; y: number; size: number; hue: number };

type WorldState = {
  simulationMs?: number;
  phase?: number;
  intensity?: number;
  embers?: Ember[];
};

const MAX_EMBERS = 32;
const SPREAD_X = 8;
const SPREAD_Y = 4.6;

const canvas = document.getElementById("stage") as HTMLCanvasElement | null;
const hint = document.getElementById("hint");

let camera: THREE.PerspectiveCamera | null = null;
let points: THREE.Points | null = null;
let material: THREE.PointsMaterial | null = null;

/** 圆形光点贴图：默认 Points 是方块，这里画一张径向渐变纹理。 */
function emberTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(
      size / 2,
      size / 2,
      0,
      size / 2,
      size / 2,
      size / 2,
    );
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.4, "rgba(255,255,255,0.55)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const game = canvas ? await connectLullGameRender() : null;
if (!game || !canvas) {
  if (hint) hint.textContent = "未连接到 LULL 实例：浏览器预览，仅显示静态背景";
} else {
  const color = new THREE.Color();
  const adapter = createThreeGameAdapter({
    game,
    create: ({ width, height }) => {
      const renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        powerPreference: "low-power",
      });
      renderer.setClearColor(0x000000, 0);

      const scene = new THREE.Scene();
      const perspective = new THREE.PerspectiveCamera(
        55,
        width / height,
        0.1,
        100,
      );
      perspective.position.set(0, 0, 9);

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(MAX_EMBERS * 3), 3),
      );
      geometry.setAttribute(
        "color",
        new THREE.BufferAttribute(new Float32Array(MAX_EMBERS * 3), 3),
      );
      material = new THREE.PointsMaterial({
        size: 0.55,
        map: emberTexture(),
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      });
      points = new THREE.Points(geometry, material);
      scene.add(points);
      camera = perspective;
      return { renderer, scene, camera: perspective };
    },
    applySnapshot: (_engine, snapshot) => {
      const state = snapshot.state as WorldState;
      const geometry = points?.geometry;
      if (!geometry) return;
      const position = geometry.getAttribute(
        "position",
      ) as THREE.BufferAttribute;
      const colorAttribute = geometry.getAttribute(
        "color",
      ) as THREE.BufferAttribute;
      const embers = Array.isArray(state.embers) ? state.embers : [];
      const count = Math.min(embers.length, MAX_EMBERS);
      for (let index = 0; index < count; index += 1) {
        const ember = embers[index] as Ember;
        position.setXYZ(
          index,
          (ember.x - 0.5) * SPREAD_X,
          (0.5 - ember.y) * SPREAD_Y,
          (ember.size - 0.5) * 1.4,
        );
        color.setHSL(
          ember.hue / 360,
          0.55,
          0.45 + (state.intensity ?? 0.5) * 0.25,
        );
        colorAttribute.setXYZ(index, color.r, color.g, color.b);
      }
      geometry.setDrawRange(0, count);
      position.needsUpdate = true;
      colorAttribute.needsUpdate = true;
      if (material) material.opacity = 0.55 + (state.intensity ?? 0.5) * 0.45;
    },
    onFrame: (_engine, timestamp) => {
      if (!camera || !points) return;
      const seconds = timestamp / 1000;
      points.rotation.z = seconds * 0.02;
      points.rotation.y = Math.sin(seconds * 0.1) * 0.16;
      camera.position.x = Math.sin(seconds * 0.07) * 0.7;
      camera.lookAt(0, 0, 0);
      const aspect = canvas.width / Math.max(1, canvas.height);
      if (Math.abs(camera.aspect - aspect) > 0.001) {
        camera.aspect = aspect;
        camera.updateProjectionMatrix();
      }
    },
    maxFps: 30,
    onError: (error) => console.warn("[three-demo]", error),
  });
  await adapter.start();
  if (hint) hint.textContent = "Three.js · 游戏包内置 replica";
  window.addEventListener("beforeunload", () => adapter.destroy());
}
