// 3D preview of the cutter using three.js. Z is up, units are millimetres.

import * as THREE from '../vendor/three.module.js';
import { OrbitControls } from '../vendor/addons/controls/OrbitControls.js';

export class CutterViewer {
  constructor(container, { plastic = 0x86d2bc } = {}) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.touchAction = 'none';

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(90, -120, 80);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.1;
    this.controls.minDistance = 20; this.controls.maxDistance = 1500;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a94a0, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(60, -80, 140); this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5); fill.position.set(-90, 60, 40); this.scene.add(fill);
    const under = new THREE.DirectionalLight(0xffffff, 0.9); under.position.set(30, -50, -120); this.scene.add(under);

    // print bed: 10 mm grid on the XY plane
    this.grid = new THREE.GridHelper(300, 30, 0x3c4452, 0x2e3542);  // muted: the bed is context, not content
    this.grid.rotation.x = Math.PI / 2;
    this.scene.add(this.grid);

    this.material = new THREE.MeshStandardMaterial({ color: plastic, roughness: 0.55, metalness: 0.02, flatShading: false });
    this.edgeMaterial = new THREE.LineBasicMaterial({ color: 0x14202b, transparent: true, opacity: 0.35 });
    this.mesh = null; this.edges = null;

    this._resize();
    this.ro = new ResizeObserver(() => this._resize());
    this.ro.observe(container);
    this._fitted = false;
    this._fitPending = false;
    this._loop();
  }

  _resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%'; this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    // A frame that was asked for while the panel was switched off is honoured now that there is
    // something to frame it in. Cleared first: fit() measures again and would come straight back.
    if (this._fitPending && this._onScreen()) { this._fitPending = false; this.fit(); }
  }

  _onScreen() { return this.container.clientWidth > 0 && this.container.clientHeight > 0; }

  // A PNG of the current view for the project file. The frame is rendered explicitly and read
  // back in the same task, while the drawing buffer is still intact — the renderer does not
  // preserve it across frames. Returns null if the capture fails; the project saves without it.
  snapshot(w = 1000, h = 750) {
    const canvas = this.renderer.domElement;
    const prevW = this.container.clientWidth, prevH = this.container.clientHeight;
    try {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
      this.renderer.render(this.scene, this.camera);
      const url = canvas.toDataURL('image/png');
      const bin = atob(url.slice(url.indexOf(',') + 1));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return null;
    } finally {
      this.renderer.setSize(Math.max(1, prevW), Math.max(1, prevH), false);
      canvas.style.width = '100%'; canvas.style.height = '100%';
      this.camera.aspect = Math.max(1, prevW) / Math.max(1, prevH); this.camera.updateProjectionMatrix();
    }
  }

  _loop() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(() => this._loop());
  }

  // positions: Float32Array triangle soup in model mm; recentres on X/Y.
  setMesh(positions, bounds) {
    this.clearMesh();
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.translate(-bounds.cx, -bounds.cy, 0);
    geom.setAttribute('normal', new THREE.BufferAttribute(smoothNormals(geom.attributes.position.array, 32), 3));
    this.mesh = new THREE.Mesh(geom, this.material);
    this.scene.add(this.mesh);
    this.edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 25), this.edgeMaterial);
    this.scene.add(this.edges);
    this.bounds = bounds;
    // Fit the camera on first use and whenever the cutter changes size a lot.
    const extent = Math.max(bounds.width, bounds.height, bounds.maxZ);
    if (!this._fitted || extent > this._fitExtent * 1.3 || extent < this._fitExtent * 0.7) {
      this.fit(); this._fitted = true; this._fitExtent = extent;
    }
  }

  clearMesh() {
    for (const o of [this.mesh, this.edges]) if (o) { this.scene.remove(o); o.geometry.dispose(); }
    this.mesh = this.edges = null;
  }

  _distanceFor(r) {
    const tanV = Math.tan((this.camera.fov / 2) * Math.PI / 180);
    const tanH = tanV * this.camera.aspect;
    return r / Math.min(tanV, tanH) * 1.1;
  }

  fit() {
    if (!this.bounds) return;
    // The distance follows the aspect ratio, so the viewport has to be measured first — and while
    // the 3D panel is switched off there is nothing to measure. Wait for it to come back.
    if (!this._onScreen()) { this._fitPending = true; return; }
    this._resize();
    const b = this.bounds;
    const r = Math.max(b.width, b.height, b.maxZ) * 0.75 + 10;
    const dist = this._distanceFor(r);
    const dir = new THREE.Vector3(0.6, -0.8, 0.55).normalize();
    this.controls.target.set(0, 0, b.maxZ / 2);
    this.camera.position.copy(dir.multiplyScalar(dist)).add(this.controls.target);
    this.controls.update();
  }

  // A quick view from below: the cutting edge (the back of the printed part).
  viewFromBelow() {
    if (!this.bounds) return;
    const r = Math.max(this.bounds.width, this.bounds.height) * 0.75 + 10;
    const dist = this._distanceFor(r);
    this.controls.target.set(0, 0, this.bounds.maxZ / 2);
    this.camera.position.set(0, -0.01, -dist);
    this.controls.update();
  }

  viewTop() {
    if (!this.bounds) return;
    const r = Math.max(this.bounds.width, this.bounds.height) * 0.75 + 10;
    const dist = this._distanceFor(r);
    this.controls.target.set(0, 0, this.bounds.maxZ / 2);
    this.camera.position.set(0, -0.01, dist + this.bounds.maxZ);
    this.controls.update();
  }
}

// Per-corner normals averaged over neighbouring faces that are within `angleDeg` of each
// other, so gently curved walls shade smoothly while steps and caps keep hard edges.
function smoothNormals(pos, angleDeg) {
  const nTri = pos.length / 9;
  const faceN = new Float32Array(nTri * 3);
  const byVertex = new Map();
  const key = (i) => `${pos[i].toFixed(4)},${pos[i + 1].toFixed(4)},${pos[i + 2].toFixed(4)}`;
  for (let t = 0; t < nTri; t++) {
    const i = t * 9;
    const ux = pos[i + 3] - pos[i], uy = pos[i + 4] - pos[i + 1], uz = pos[i + 5] - pos[i + 2];
    const vx = pos[i + 6] - pos[i], vy = pos[i + 7] - pos[i + 1], vz = pos[i + 8] - pos[i + 2];
    faceN[t * 3] = uy * vz - uz * vy; faceN[t * 3 + 1] = uz * vx - ux * vz; faceN[t * 3 + 2] = ux * vy - uy * vx; // area-weighted
    for (let c = 0; c < 3; c++) {
      const k = key(i + c * 3);
      let list = byVertex.get(k); if (!list) { list = []; byVertex.set(k, list); }
      list.push(t);
    }
  }
  const cosLimit = Math.cos((angleDeg * Math.PI) / 180);
  const out = new Float32Array(pos.length);
  const unit = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
  for (let t = 0; t < nTri; t++) {
    const [fx, fy, fz] = unit(faceN[t * 3], faceN[t * 3 + 1], faceN[t * 3 + 2]);
    for (let c = 0; c < 3; c++) {
      const i = t * 9 + c * 3;
      let nx = 0, ny = 0, nz = 0;
      for (const g of byVertex.get(key(i))) {
        const [gx, gy, gz] = unit(faceN[g * 3], faceN[g * 3 + 1], faceN[g * 3 + 2]);
        if (fx * gx + fy * gy + fz * gz >= cosLimit) { nx += faceN[g * 3]; ny += faceN[g * 3 + 1]; nz += faceN[g * 3 + 2]; }
      }
      const n = unit(nx, ny, nz);
      out[i] = n[0]; out[i + 1] = n[1]; out[i + 2] = n[2];
    }
  }
  return out;
}
