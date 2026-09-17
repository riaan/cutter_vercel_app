// Saving and opening a project: everything needed to reproduce the exact same cutter later.
//
// The file (.cutter) is a zip holding
//   project.json    the state below — the only part that is read back
//   model.stl       the mesh as downloaded, so the file is printable without opening Cutter
//   preview-2d.png  the drawing
//   preview-3d.png  the 3D view
// The previews and the STL are there for you and your file browser; they are never read back.
// The mesh is rebuilt from project.json, which is what keeps a reopened project identical.
//
// A project holds a list of shapes (layers), each with its own contours, mirror settings and
// wall parameters. A schema-1 file held a single shape with the parameters alongside it; it is
// read back as a plate with one shape on it. Shapes that overlap are one object in the STL, but
// they are written here one by one all the same — opening the file gives the shapes back, not
// the merged lump.

import { DEFAULT_PARAMS } from './geometry.js';
import { zipWrite, zipRead } from './zip.js';

export const PROJECT_FORMAT = 'cutter-project';
export const PROJECT_SCHEMA = 2;
export const PROJECT_EXT = '.cutter';

const num = (v, fallback) => (typeof v === 'number' && isFinite(v) ? v : fallback);

// Keep only what a point may carry: the anchor, its Bézier handles and the smooth flag.
function cleanPoint(p) {
  const q = { x: num(p?.x, 0), y: num(p?.y, 0) };
  for (const k of ['in', 'out']) {
    const h = p?.[k];
    if (h && isFinite(h.x) && isFinite(h.y)) q[k] = { x: h.x, y: h.y };
  }
  if (p?.smooth) q.smooth = true;
  return q;
}
const cleanRing = (pts) => (Array.isArray(pts) ? pts.map(cleanPoint) : []);

const cleanLayer = (l) => ({
  shape: { outer: cleanRing(l?.shape?.outer), inner: cleanRing(l?.shape?.inner) },
  sym: { x: !!l?.sym?.x, y: !!l?.sym?.y },
  symOrigin: { x: num(l?.symOrigin?.x, 0), y: num(l?.symOrigin?.y, 0) },
  params: { ...DEFAULT_PARAMS, ...(l?.params || {}) },
  // Which contours were still being drawn — a line of corners nobody has closed yet. A file
  // saved before this existed has none, and reads back as the finished shapes it held.
  open: { outer: !!l?.open?.outer, inner: !!l?.open?.inner },
  bridgeAuto: !!l?.bridgeAuto,
});

// state → the plain object that is written as project.json.
export function serializeProject(state) {
  const layers = (Array.isArray(state.layers) && state.layers.length ? state.layers : [state]).map(cleanLayer);
  return {
    format: PROJECT_FORMAT,
    schema: PROJECT_SCHEMA,
    app: 'Cutter',
    savedAt: new Date().toISOString(),
    name: state.name || 'cutter',
    shapes: layers,
    index: Math.min(Math.max(0, Math.round(state.index) || 0), layers.length - 1),
    active: state.active === 'inner' ? 'inner' : 'outer',
    tool: ['draw', 'points', 'move'].includes(state.tool) ? state.tool : 'draw',
    smoothing: num(state.smoothing, 0.4),
    lockAspect: state.lockAspect !== false,
    // Whether the shapes on this plate are allowed to run into each other. The shapes are always
    // saved apart, one entry each, so a plate that prints as one merged object still opens as the
    // separate shapes it was drawn from.
    allowOverlap: !!state.allowOverlap,
    grid: { size: num(state.grid?.size, 10), snap: !!state.grid?.snap },
    // Only for the "does it still build the same" check on open — never fed back into geometry.
    stats: state.stats || null,
  };
}

// project.json → state, with everything validated and older files brought up to date.
// Throws with a sentence the user can act on.
export function deserializeProject(data) {
  if (!data || data.format !== PROJECT_FORMAT) throw new Error('That is not a Cutter project file.');
  if (!(data.schema <= PROJECT_SCHEMA)) throw new Error('This project was saved by a newer version of Cutter. Update the page and try again.');
  // Schema 1 kept one shape and its parameters at the top level; it becomes a plate of one.
  const raw = Array.isArray(data.shapes) && data.shapes.length
    ? data.shapes
    : [{ shape: data.shape, sym: data.sym, params: data.params, bridgeAuto: data.bridgeAuto }];
  const layers = raw.map(cleanLayer).filter(l => l.shape.outer.length >= 2);
  if (!layers.length) throw new Error('This project has no shape in it.');
  return {
    name: typeof data.name === 'string' ? data.name : 'cutter',
    layers,
    index: Math.min(Math.max(0, Math.round(data.index) || 0), layers.length - 1),
    active: data.active === 'inner' ? 'inner' : 'outer',
    tool: ['draw', 'points', 'move'].includes(data.tool) ? data.tool : 'move',
    smoothing: num(data.smoothing, 0.4),
    lockAspect: data.lockAspect !== false,
    // null where the file does not say — a file written before the setting existed may still
    // hold shapes that overlap, and then the drawing is what has to decide.
    allowOverlap: typeof data.allowOverlap === 'boolean' ? data.allowOverlap : null,
    grid: { size: num(data.grid?.size, 10), snap: !!data.grid?.snap },
    stats: data.stats || null,
    savedAt: data.savedAt || null,
  };
}

// state (+ optional stl / png previews) → the bytes of a .cutter file.
export function packProject(state, files = {}) {
  const json = JSON.stringify(serializeProject(state), null, 2);
  const entries = [{ name: 'project.json', data: new TextEncoder().encode(json) }];
  if (files.stl) entries.push({ name: 'model.stl', data: new Uint8Array(files.stl) });
  if (files.png2d) entries.push({ name: 'preview-2d.png', data: files.png2d });
  if (files.png3d) entries.push({ name: 'preview-3d.png', data: files.png3d });
  return zipWrite(entries);
}

export async function unpackProject(buffer) {
  const files = await zipRead(buffer);
  const json = files.get('project.json');
  if (!json) throw new Error('That zip is not a Cutter project — no project.json inside.');
  let data;
  try { data = JSON.parse(new TextDecoder().decode(json)); }
  catch { throw new Error('This project file is damaged and cannot be read.'); }
  return deserializeProject(data);
}
