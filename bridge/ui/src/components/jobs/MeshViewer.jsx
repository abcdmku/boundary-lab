import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

// Reads a CSS custom property through an actual canvas 2D fill so any CSS
// color syntax the browser accepts (oklch(), color-mix(), whatever t3's
// tokens use) resolves to sRGB bytes — no dependency on three.js's own
// (more limited) CSS color-string parser.
function cssVarToThreeColor(name, fallbackHex) {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
  } catch {
    return new THREE.Color(fallbackHex);
  }
}

function fitCameraToGroup(camera, controls, group) {
  const box = new THREE.Box3().setFromObject(group);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const dist = (maxDim / 2 / Math.tan((camera.fov * Math.PI) / 180 / 2)) * 1.6;
  camera.near = maxDim / 100;
  camera.far = maxDim * 50;
  camera.position.set(center.x + dist * 0.6, center.y + dist * 0.5, center.z + dist * 0.6);
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

// Lightweight three.js STL viewer: walls in a neutral matte material,
// driven surface in the theme's accent color, auto-fit camera, orbit+zoom.
// Render-on-demand (draw only when the camera actually moved or the
// container resized) keeps it performant at tens of thousands of
// triangles with zero per-frame allocation.
export function MeshViewer({ wallsUrl, drivenUrl }) {
  const containerRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !wallsUrl) return undefined;

    const canvas = document.createElement("canvas");
    container.append(canvas); // sized by .mesh-canvas-host canvas rules

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 1, 10000);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a40, 1.15));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.85);
    dirLight.position.set(1, 1.4, 1);
    scene.add(dirLight);

    const group = new THREE.Group();
    scene.add(group);

    let needsRender = true;
    let disposed = false;
    let rafId = 0;
    controls.addEventListener("change", () => {
      needsRender = true;
    });

    const ro = new ResizeObserver(() => {
      needsRender = true;
    });
    ro.observe(container);

    let lastW = 0;
    let lastH = 0;
    const tick = () => {
      if (disposed) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w > 0 && h > 0 && (w !== lastW || h !== lastH)) {
        lastW = w;
        lastH = h;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        needsRender = true;
      }
      controls.update(); // integrates damping, dispatches "change" while moving
      if (needsRender) {
        renderer.render(scene, camera);
        needsRender = false;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    const loader = new STLLoader();
    const accent = cssVarToThreeColor("--primary", "#2f6fed");
    Promise.all([
      fetch(wallsUrl)
        .then((r) => r.arrayBuffer())
        .then((b) => loader.parse(b))
        .catch(() => null),
      drivenUrl
        ? fetch(drivenUrl)
            .then((r) => r.arrayBuffer())
            .then((b) => loader.parse(b))
            .catch(() => null)
        : Promise.resolve(null),
    ]).then(([wallsGeo, drivenGeo]) => {
      if (disposed) return;
      if (wallsGeo) {
        const mat = new THREE.MeshStandardMaterial({
          color: 0xaeb4bd,
          roughness: 0.88,
          metalness: 0.04,
          side: THREE.DoubleSide,
        });
        group.add(new THREE.Mesh(wallsGeo, mat));
      }
      if (drivenGeo) {
        const mat = new THREE.MeshStandardMaterial({
          color: accent,
          roughness: 0.55,
          metalness: 0.04,
          side: THREE.DoubleSide,
        });
        group.add(new THREE.Mesh(drivenGeo, mat));
      }
      fitCameraToGroup(camera, controls, group);
      needsRender = true;
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      ro.disconnect();
      controls.dispose();
      scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      });
      renderer.dispose();
      canvas.remove();
    };
  }, [wallsUrl, drivenUrl]);

  return <div ref={containerRef} className="mesh-canvas-host" />;
}
