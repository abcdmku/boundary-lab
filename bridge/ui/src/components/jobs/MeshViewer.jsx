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

/**
 * Lightweight three.js STL viewer: walls in a neutral matte material, driven
 * surface in the theme's accent color, orbit+zoom, render-on-demand (draw only
 * when the camera actually moved or the container resized) so tens of
 * thousands of triangles cost nothing per frame.
 *
 * The scene outlives the geometry. That split is what makes the live mesh
 * editor usable: new URLs swap the meshes inside a scene whose camera,
 * lighting and orbit state are untouched, so a horn re-meshed on every
 * keystroke appears to deform in place rather than being re-framed from
 * scratch fifty times. The camera is fitted on the FIRST geometry only —
 * afterwards it moves when the user moves it, or when `fitKey` changes (bump
 * it from a "Fit" button).
 */
export function MeshViewer({ wallsUrl, drivenUrl, fitKey = 0 }) {
  const containerRef = useRef(null);
  const sceneRef = useRef(null);

  // --- scene lifetime: created once, torn down on unmount -------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

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

    const ctx = {
      renderer,
      scene,
      camera,
      controls,
      group,
      needsRender: true,
      disposed: false,
      fitted: false,
      invalidate: () => {
        ctx.needsRender = true;
      },
    };
    sceneRef.current = ctx;

    controls.addEventListener("change", ctx.invalidate);
    const ro = new ResizeObserver(ctx.invalidate);
    ro.observe(container);

    let rafId = 0;
    let lastW = 0;
    let lastH = 0;
    const tick = () => {
      if (ctx.disposed) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w > 0 && h > 0 && (w !== lastW || h !== lastH)) {
        lastW = w;
        lastH = h;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        ctx.needsRender = true;
      }
      controls.update(); // integrates damping, dispatches "change" while moving
      if (ctx.needsRender) {
        renderer.render(scene, camera);
        ctx.needsRender = false;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      ctx.disposed = true;
      sceneRef.current = null;
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
  }, []);

  // --- geometry: reloaded whenever the URLs change --------------------------
  useEffect(() => {
    const ctx = sceneRef.current;
    if (!ctx || !wallsUrl) return undefined;

    let cancelled = false;
    const loader = new STLLoader();
    const load = (url) =>
      url
        ? fetch(url)
            .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
            .then((b) => loader.parse(b))
            .catch(() => null)
        : Promise.resolve(null);

    Promise.all([load(wallsUrl), load(drivenUrl)]).then(([wallsGeo, drivenGeo]) => {
      // Both a newer parameter set and an unmount can land here first. Either
      // way this geometry is already stale, so drop it rather than showing it.
      if (cancelled || ctx.disposed) {
        wallsGeo?.dispose();
        drivenGeo?.dispose();
        return;
      }
      if (!wallsGeo && !drivenGeo) return; // keep whatever is on screen

      // Swapped, not cleared-then-filled: the old mesh stays visible for the
      // whole regeneration and is only released once its replacement is ready.
      for (const child of [...ctx.group.children]) {
        ctx.group.remove(child);
        child.geometry?.dispose();
        child.material?.dispose();
      }
      const accent = cssVarToThreeColor("--primary", "#2f6fed");
      if (wallsGeo)
        ctx.group.add(
          new THREE.Mesh(
            wallsGeo,
            new THREE.MeshStandardMaterial({
              color: 0xaeb4bd,
              roughness: 0.88,
              metalness: 0.04,
              side: THREE.DoubleSide,
            }),
          ),
        );
      if (drivenGeo)
        ctx.group.add(
          new THREE.Mesh(
            drivenGeo,
            new THREE.MeshStandardMaterial({
              color: accent,
              roughness: 0.55,
              metalness: 0.04,
              side: THREE.DoubleSide,
            }),
          ),
        );

      if (!ctx.fitted) {
        fitCameraToGroup(ctx.camera, ctx.controls, ctx.group);
        ctx.fitted = true;
      }
      ctx.invalidate();
    });

    return () => {
      cancelled = true;
    };
  }, [wallsUrl, drivenUrl]);

  // --- explicit re-fit, on demand ------------------------------------------
  useEffect(() => {
    const ctx = sceneRef.current;
    if (!ctx || !fitKey || !ctx.group.children.length) return;
    fitCameraToGroup(ctx.camera, ctx.controls, ctx.group);
    ctx.invalidate();
  }, [fitKey]);

  return <div ref={containerRef} className="mesh-canvas-host" />;
}
