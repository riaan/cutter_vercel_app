// STL import check — run with:  node tests/stl-import.mjs
// Builds a cutter, writes it out as STL, reads that STL back with the importer and verifies
// that the recovered drawing and settings build the very same solid again. This is what
// "open an STL you made before and carry on with it" rests on.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clipperSrc = fs.readFileSync(path.join(root, 'vendor/clipper.js'), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', 'window', clipperSrc)(mod, mod.exports, undefined);
globalThis.ClipperLib = mod.exports;

const G = await import(path.join(root, 'js/geometry.js'));
const S = await import(path.join(root, 'js/stlimport.js'));
await G.loadManifold();

const circ = (r, n = 120) => Array.from({ length: n }, (_, i) => ({ x: r * Math.cos((i / n) * 2 * Math.PI), y: r * Math.sin((i / n) * 2 * Math.PI) }));
const star = Array.from({ length: 10 }, (_, i) => { const r = i % 2 ? 17 : 36, a = (i * Math.PI) / 5 - Math.PI / 2; return { x: r * Math.cos(a), y: r * Math.sin(a) }; });
const blob = (r, n, wob) => Array.from({ length: n }, (_, i) => { const a = (i / n) * 2 * Math.PI; const rr = r * (1 + wob * Math.sin(3 * a + 1) + wob * 0.5 * Math.cos(5 * a)); return { x: rr * Math.cos(a), y: rr * Math.sin(a) }; });

// The shape as app.js hands it to the builder: cleaned at the final size.
const clean = (pts) => G.cleanPolygon(pts, 0.002);

const cases = [
  ['ring + 4 connections, all defaults', { outer: clean(circ(40)), inner: clean(circ(20)) }, {}],
  ['ring, no step', { outer: clean(circ(40)), inner: clean(circ(18)) }, { ridge: false }],
  ['ring, no connections', { outer: clean(circ(40)), inner: clean(circ(20)) }, { bridgeCount: 0 }],
  ['ring, 7 connections rotated 13°', { outer: clean(circ(40)), inner: clean(circ(20)) }, { bridgeCount: 7, bridgeWidth: 3, bridgeAngle: 13 }],
  ['outer wall only, tall thin blade', clean(star), { height: 24, bladeWidth: 0.6, baseWidth: 4.5, baseHeight: 2.4, ridgeWidth: 1.2, ridgeHeight: 9 }],
  ['star + small hole', { outer: clean(star), inner: clean(circ(8)) }, { bridgeCount: 3, bridgeWidth: 2.5 }],
  ['wobbly blob + hole', { outer: clean(blob(35, 180, 0.22)), inner: clean(blob(12, 90, 0.18)) }, { bridgeCount: 5, bridgeWidth: 2, bridgeAngle: 22 }],
  ['mirrored model', { outer: clean(star), inner: clean(circ(8)) }, { mirror: true, bridgeAngle: 30 }],
];
// a starter shape, the way app.js inserts and builds it
const { PRESETS, PRESET_SIZE_MM } = await import(path.join(root, 'js/presets.js'));
const { flatten, mapPts } = await import(path.join(root, 'js/editor.js'));
for (const key of ['heart', 'gingerbread']) {
  const pts = PRESETS[key].make(), b = G.bounds(flatten(pts));
  const k = (PRESET_SIZE_MM || 60) / Math.max(b.width, b.height);
  cases.push([`starter shape: ${key}`, clean(flatten(mapPts(pts, q => ({ x: q.x * k, y: q.y * k })))), {}]);
}

const P = (params) => ({ ...G.DEFAULT_PARAMS, ...params });
const near = (a, b, tol) => Math.abs(a - b) <= tol;
let failed = 0;

for (const [label, shape, params] of cases) {
  const want = P(params);
  const built = G.buildCutter(shape, want);
  const stl = G.toBinarySTL(built.positions, 'case');

  let all, read, rebuilt, problems = [];
  try {
    all = S.importSTL(stl);
    if (all.parts.length !== 1) throw new Error(`${all.parts.length} solids found in a one-cutter file`);
    read = all.parts[0];
    rebuilt = G.buildCutter(read.shape, read.params);
  } catch (e) {
    console.log(`FAIL  ${label}: ${e.message}`);
    failed++; continue;
  }

  // 1. the solid: same volume, same footprint, same height
  if (!near(rebuilt.volumeMm3, built.volumeMm3, built.volumeMm3 * 0.002)) {
    problems.push(`volume ${rebuilt.volumeMm3.toFixed(1)} vs ${built.volumeMm3.toFixed(1)} mm³`);
  }
  for (const k of ['width', 'height', 'height3d']) {
    if (!near(rebuilt.footprint[k], built.footprint[k], 0.02)) problems.push(`${k} ${rebuilt.footprint[k].toFixed(3)} vs ${built.footprint[k].toFixed(3)}`);
  }

  // 2. the settings, for the cutters whose drawing is not mirrored (a mirrored one comes back
  //    as the mirrored drawing with Mirror off — the same solid, told a different way)
  if (!want.mirror) {
    for (const k of ['height', 'bladeWidth', 'baseWidth', 'baseHeight', 'ridgeWidth', 'ridgeHeight']) {
      if (want.ridge === false && k.startsWith('ridge')) continue;
      if (!near(read.params[k], want[k], 0.011)) problems.push(`${k} ${read.params[k]} vs ${want[k]}`);
    }
    if (read.params.ridge !== want.ridge) problems.push(`ridge ${read.params.ridge} vs ${want.ridge}`);
    if (shape.inner) {
      if (read.params.bridgeCount !== want.bridgeCount) problems.push(`bars ${read.params.bridgeCount} vs ${want.bridgeCount}`);
      if (want.bridgeCount > 0) {
        if (!near(read.params.bridgeWidth, want.bridgeWidth, 0.02)) problems.push(`bar width ${read.params.bridgeWidth} vs ${want.bridgeWidth}`);
        if (!near(read.params.bridgeAngle, want.bridgeAngle, 0.3)) problems.push(`bar angle ${read.params.bridgeAngle} vs ${want.bridgeAngle}`);
      }
    }
  }

  // 3. the drawing itself: the same outline, point for point. An STL is written centred, so the
  //    drawing comes back centred too — both are measured from the middle of the outer wall.
  const src = { outer: shape.outer || shape, inner: shape.inner || [] };
  const oc = G.bounds(src.outer), rc = G.bounds(read.shape.outer);
  const flip = want.mirror ? -1 : 1; // a mirrored model comes back as the drawing it mirrors
  for (const wall of ['outer', 'inner']) {
    const a = src[wall] || [], b = read.shape[wall];
    if (a.length < 3) continue;
    if (b.length !== a.length) { problems.push(`${wall} ${b.length} points vs ${a.length}`); continue; }
    let worst = 0;
    for (const p of a) {
      const px = p.x - oc.cx, py = flip * (p.y - oc.cy);
      let d = Infinity;
      for (const q of b) d = Math.min(d, Math.hypot(q.x - rc.cx - px, q.y - rc.cy - py));
      worst = Math.max(worst, d);
    }
    if (worst > 0.005) problems.push(`${wall} outline off by ${worst.toFixed(4)} mm`);
  }

  if (problems.length) { failed++; console.log(`FAIL  ${label}\n      ${problems.join('\n      ')}`); }
  else console.log(`PASS  ${label} (${read.tiers} tiers, ${read.points} points, ${read.size.width.toFixed(1)} × ${read.size.height.toFixed(1)} mm)`);
}

// An ASCII STL must read the same as the binary one.
{
  const built = G.buildCutter({ outer: clean(circ(30)), inner: clean(circ(14)) }, P({}));
  const p = built.positions;
  let txt = 'solid cutter\n';
  for (let i = 0; i < p.length; i += 9) {
    txt += 'facet normal 0 0 0\n outer loop\n';
    for (let c = 0; c < 9; c += 3) txt += `  vertex ${p[i + c]} ${p[i + c + 1]} ${p[i + c + 2]}\n`;
    txt += ' endloop\nendfacet\n';
  }
  txt += 'endsolid cutter\n';
  const bytes = new TextEncoder().encode(txt);
  let ok = false, why = '';
  try {
    const read = S.importSTL(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)).parts[0];
    ok = read.params.bridgeCount === 4 && Math.abs(read.size.width - 60) < 0.05 && Math.abs(read.params.height - 15) < 0.02;
    why = `${read.size.width.toFixed(2)} mm wide, ${read.params.height} mm tall, ${read.params.bridgeCount} bars`;
  } catch (e) { why = e.message; }
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ASCII STL (${why})`);
}

// Junk must be refused with a sentence, not a stack trace.
{
  const junk = new Uint8Array(500).buffer;
  let msg = '';
  try { S.importSTL(junk); } catch (e) { msg = e.message; }
  const ok = /STL|cutter|model/i.test(msg);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  empty file refused ("${msg}")`);
}

// A solid that is not a cutter has no blade to find: the outline is taken and the walls are left
// alone, with a sentence saying so.
{
  const box = [];
  const quad = (a, b, c, d) => box.push(...a, ...b, ...c, ...a, ...c, ...d);
  const [X, Y, Z] = [20, 15, 10];
  quad([-X, -Y, 0], [X, -Y, 0], [X, Y, 0], [-X, Y, 0]);
  quad([-X, -Y, Z], [X, -Y, Z], [X, Y, Z], [-X, Y, Z]);
  quad([-X, -Y, 0], [X, -Y, 0], [X, -Y, Z], [-X, -Y, Z]);
  quad([-X, Y, 0], [X, Y, 0], [X, Y, Z], [-X, Y, Z]);
  quad([-X, -Y, 0], [-X, Y, 0], [-X, Y, Z], [-X, -Y, Z]);
  quad([X, -Y, 0], [X, Y, 0], [X, Y, Z], [X, -Y, Z]);
  const stl = G.toBinarySTL(new Float32Array(box), 'box');
  let ok = false, why = '';
  try {
    const whole = S.importSTL(stl), read = whole.parts[0];
    ok = read.outlineOnly && whole.notes.length > 0 && Math.abs(read.size.width - 40) < 0.01
      && Math.abs(read.size.height - 30) < 0.01 && read.params.bladeWidth === G.DEFAULT_PARAMS.bladeWidth;
    why = `${read.size.width.toFixed(1)} × ${read.size.height.toFixed(1)} mm outline, ${whole.notes.length} note(s)`;
  } catch (e) { why = e.message; }
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  a plain solid falls back to its outline (${why})`);
}

// A plate of several cutters: every one of them comes back, in its place, with the settings it
// was built from. This is what makes an STL of a whole plate as good as a project file.
{
  const at = (pts, dx, dy) => pts.map(p => ({ x: p.x + dx, y: p.y + dy }));
  const plate = [
    { shape: { outer: clean(at(circ(20), -45, 0)), inner: clean(at(circ(10), -45, 0)) }, params: P({ height: 12, bridgeCount: 3, bridgeWidth: 2.5 }) },
    { shape: { outer: clean(at(star, 45, 0)), inner: null }, params: P({ height: 22, bladeWidth: 0.7, ridge: false, baseWidth: 4 }) },
  ];
  const built = G.buildAll(plate);
  const problems = [];
  let read;
  try {
    read = S.importSTL(G.toBinarySTL(built.positions, 'plate'));
  } catch (e) { problems.push(e.message); }
  if (read) {
    if (read.parts.length !== 2) problems.push(`${read.parts.length} shapes instead of 2`);
    else {
      // The importer hands them back biggest first; match each one to the source by its width.
      const byWidth = [...read.parts].sort((a, b) => a.size.width - b.size.width);
      const want = [...plate].sort((a, b) => G.bounds(a.shape.outer).width - G.bounds(b.shape.outer).width);
      for (let i = 0; i < 2; i++) {
        for (const k of ['height', 'bladeWidth', 'baseWidth', 'baseHeight']) {
          if (Math.abs(byWidth[i].params[k] - want[i].params[k]) > 0.011) {
            problems.push(`shape ${i + 1}: ${k} ${byWidth[i].params[k]} vs ${want[i].params[k]}`);
          }
        }
        if (byWidth[i].params.ridge !== want[i].params.ridge) problems.push(`shape ${i + 1}: ridge`);
      }
      // and the whole plate rebuilds to the same solid, shapes in the same places
      const again = G.buildAll(read.parts.map(p => ({ shape: p.shape, params: p.params })));
      const off = Math.abs(again.volumeMm3 - built.volumeMm3) / built.volumeMm3;
      if (off > 0.004) problems.push(`volume off by ${(off * 100).toFixed(2)}%`);
      for (const k of ['width', 'height']) {
        if (Math.abs(again.footprint[k] - built.footprint[k]) > 0.05) {
          problems.push(`plate ${k} ${again.footprint[k].toFixed(2)} vs ${built.footprint[k].toFixed(2)}`);
        }
      }
    }
  }
  if (problems.length) { failed++; console.log(`FAIL  a plate of two cutters\n      ${problems.join('\n      ')}`); }
  else console.log(`PASS  a plate of two cutters (${read.parts.length} shapes, ${read.size.width.toFixed(1)} × ${read.size.height.toFixed(1)} mm)`);
}

// optional random stress: node tests/stl-import.mjs 40
const N = parseInt(process.argv[2] || '0', 10);
if (N > 0) {
  let seed = 4711; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let bad = 0, skipped = 0;
  for (let k = 0; k < N; k++) {
    const outer = clean(blob(28 + rnd() * 25, 60 + Math.floor(rnd() * 200), rnd() * 0.25));
    const inner = rnd() < 0.7 ? clean(blob(7 + rnd() * 8, 40 + Math.floor(rnd() * 120), rnd() * 0.2)) : null;
    const params = P({
      height: 10 + rnd() * 15, bladeWidth: 0.4 + rnd() * 0.5, baseWidth: 2 + rnd() * 3, baseHeight: 1 + rnd() * 3,
      ridge: rnd() < 0.7, ridgeWidth: 0.6 + rnd(), ridgeHeight: 2 + rnd() * 5,
      bridgeCount: Math.floor(rnd() * 7), bridgeWidth: 1.5 + rnd() * 3, bridgeAngle: rnd() * 60, mirror: rnd() < 0.5,
    });
    let a, b;
    try { a = G.buildCutter({ outer, inner }, params); } catch { skipped++; continue; }
    try {
      const read = S.importSTL(G.toBinarySTL(a.positions, 'r')).parts[0];
      b = G.buildCutter(read.shape, read.params);
    } catch (e) { bad++; console.log(`  random ${k}: ${e.message}`); continue; }
    // Measured widths and heights are reported to 0.01 mm, which is what the settings panel can
    // hold. Real settings are typed in tenths and come back exactly; these random ones are real
    // numbers, so half a hundredth on each of five dimensions can move the volume a little.
    const off = Math.abs(b.volumeMm3 - a.volumeMm3) / a.volumeMm3;
    if (off > 0.01) { bad++; console.log(`  random ${k}: volume off by ${(off * 100).toFixed(2)}%`, JSON.stringify(params)); }
  }
  console.log(`random: ${N} cases, ${bad} that did not come back the same, ${skipped} rejected before export`);
  if (bad) failed++;
}

console.log(failed ? `\n${failed} case(s) failed.` : '\nAll STL imports came back the same cutter.');
process.exit(failed ? 1 : 0);
