// Project round-trip check — run with:  node tests/project-roundtrip.mjs
// Writes a .cutter file in memory, reads it back and verifies that the restored state builds
// a byte-identical mesh. This is what "open it later and get the same cutter" rests on.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clipperSrc = fs.readFileSync(path.join(root, 'vendor/clipper.js'), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', 'window', clipperSrc)(mod, mod.exports, undefined);
globalThis.ClipperLib = mod.exports;

const G = await import(path.join(root, 'js/geometry.js'));
const P = await import(path.join(root, 'js/project.js'));
await G.loadManifold();

const circ = (r, n = 120) => Array.from({ length: n }, (_, i) => ({ x: r * Math.cos(i / n * 2 * Math.PI), y: r * Math.sin(i / n * 2 * Math.PI) }));
const star = Array.from({ length: 10 }, (_, i) => { const r = i % 2 ? 17 : 36, a = i * Math.PI / 5 - Math.PI / 2; return { x: r * Math.cos(a), y: r * Math.sin(a) }; });
// a Bézier-handled contour: the handles must survive the file, or curves reopen as corners
const curved = [
  { x: -30, y: -30, out: { x: 14, y: 0 }, smooth: true },
  { x: 30, y: -30, in: { x: -14, y: 0 }, out: { x: 0, y: 14 }, smooth: true },
  { x: 30, y: 30, in: { x: 0, y: -14 } },
  { x: -30, y: 30 },
];

const cases = [
  ['ring + connections', { outer: circ(40), inner: circ(20) }, {}, { x: false, y: false }],
  ['star, tall blade', { outer: star, inner: [] }, { height: 22, bladeWidth: 0.6, ridge: false }, { x: false, y: false }],
  ['curved outline, mirrored model', { outer: curved, inner: [] }, { mirror: true, bridgeAngle: 30 }, { x: true, y: false }],
  ['both mirrors, no ridge', { outer: circ(25), inner: circ(12) }, { ridge: false, bridgeCount: 6, bridgeWidth: 3 }, { x: true, y: true }],
];

let failed = 0;
for (const [name, shape, params, sym] of cases) {
  const state = {
    shape, sym, active: 'outer', tool: 'move', smoothing: 0.4, lockAspect: true,
    grid: { size: 5, snap: true }, params, bridgeAuto: false, name: 'cutter-test',
  };
  const bytes = P.packProject(state, {
    stl: G.toBinarySTL(G.buildCutter(shape, params).positions, 'cutter-test'),
  });
  const back = await P.unpackProject(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

  const a = G.buildCutter(shape, { ...G.DEFAULT_PARAMS, ...params }).positions;
  const b = G.buildCutter(back.shape, back.params).positions;

  const same = a.length === b.length && a.every((v, i) => v === b[i]);
  const stateKept = back.sym.x === sym.x && back.sym.y === sym.y && back.grid.size === 5 && back.grid.snap === true
    && back.name === 'cutter-test' && back.params.height === (params.height ?? G.DEFAULT_PARAMS.height);
  const handlesKept = name !== 'curved outline, mirrored model'
    || (back.shape.outer[0].out?.x === 14 && back.shape.outer[0].smooth === true && back.shape.outer[1].in?.x === -14);

  const ok = same && stateKept && handlesKept;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? ` (${a.length / 9} triangles, ${(bytes.length / 1024).toFixed(0)} kB file)`
    : `  mesh:${same} settings:${stateKept} handles:${handlesKept}`));
}

// The zip must also be a zip: entry names and the STL come back intact.
const { zipRead } = await import(path.join(root, 'js/zip.js'));
const probe = P.packProject({ shape: { outer: circ(20), inner: [] }, params: {}, name: 'probe' },
  { stl: G.toBinarySTL(G.buildCutter(circ(20), {}).positions, 'probe'), png2d: new Uint8Array([137, 80, 78, 71]) });
const files = await zipRead(probe.buffer.slice(probe.byteOffset, probe.byteOffset + probe.byteLength));
const names = [...files.keys()].join(', ');
const zipOk = files.has('project.json') && files.has('model.stl') && files.has('preview-2d.png')
  && files.get('model.stl').length === G.toBinarySTL(G.buildCutter(circ(20), {}).positions, 'probe').byteLength;
if (!zipOk) failed++;
console.log(`${zipOk ? 'PASS' : 'FAIL'}  zip container (${names})`);

console.log(failed ? `\n${failed} case(s) failed.` : '\nAll project round-trips passed.');
process.exit(failed ? 1 : 0);
