// Turns an SVG file into a single closed outline in millimetres.
// Strategy: render the SVG off-screen, sample every geometry element with the
// browser's own path engine (so curves, arcs and transforms are all handled),
// split into loops, union them, and keep the largest region.

import { unionPolygons, cleanPolygon, bounds, isInside, signedArea } from './geometry.js';

const PX_PER_MM = 96 / 25.4;

function unitToMm(value) {
  const m = /^\s*([+-]?\d*\.?\d+(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(value || '');
  if (!m) return null;
  const v = parseFloat(m[1]);
  switch (m[2].toLowerCase()) {
    case 'mm': return v;
    case 'cm': return v * 10;
    case 'in': return v * 25.4;
    case 'pt': return v * 25.4 / 72;
    case 'pc': return v * 25.4 / 6;
    case '': case 'px': return v / PX_PER_MM;
    default: return null;
  }
}

export async function importSVG(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg') throw new Error('This file is not an SVG.');

  // Work out the physical scale: user units -> mm.
  let vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const wAttr = root.getAttribute('width'), hAttr = root.getAttribute('height');
  const wMm = unitToMm(wAttr), hMm = unitToMm(hAttr);
  let hasPhysical = /mm|cm|in|pt|pc/i.test((wAttr || '') + (hAttr || ''));
  if (vb.length !== 4 || vb.some(isNaN)) vb = [0, 0, wMm ? wMm * PX_PER_MM : 100, hMm ? hMm * PX_PER_MM : 100];
  const userToMm = hasPhysical && wMm ? wMm / vb[2] : 1 / PX_PER_MM;

  // Mount off-screen at 1 user unit = 1 css px so CTMs are in user units.
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-100000px;top:0;width:1px;height:1px;overflow:hidden;';
  const svg = document.importNode(root, true);
  svg.setAttribute('width', vb[2]); svg.setAttribute('height', vb[3]);
  svg.setAttribute('viewBox', vb.join(' '));
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.cssText = `width:${vb[2]}px;height:${vb[3]}px;display:block;`;
  host.appendChild(svg); document.body.appendChild(host);

  try {
    const rootCTM = svg.getScreenCTM();
    if (!rootCTM) throw new Error('Could not read the SVG.');
    const inv = rootCTM.inverse();
    const loops = [];
    const els = svg.querySelectorAll('path, polygon, polyline, rect, circle, ellipse');
    for (const el of els) {
      if (el.closest('defs, clipPath, mask, marker, pattern, symbol')) continue;
      if (typeof el.getTotalLength !== 'function') continue;
      let len; try { len = el.getTotalLength(); } catch { continue; }
      if (!len || !isFinite(len)) continue;
      const m = inv.multiply(el.getScreenCTM());
      // Sample densely (0.05 mm at native size, max 6000 samples) — the shape may be scaled up a lot later.
      const step = Math.max(len / 6000, 0.05 / userToMm);
      const pt = svg.createSVGPoint();
      let cur = [], prev = null;
      for (let d = 0; d <= len + 1e-6; d += step) {
        const p = el.getPointAtLength(Math.min(d, len));
        pt.x = p.x; pt.y = p.y;
        const q = pt.matrixTransform(m);
        const mm = { x: q.x * userToMm, y: q.y * userToMm };
        if (prev && Math.hypot(mm.x - prev.x, mm.y - prev.y) > step * userToMm * 4) { // jump = new subpath
          if (cur.length >= 3) loops.push(cur); cur = [];
        }
        cur.push(mm); prev = mm;
      }
      if (cur.length >= 3) loops.push(cur);
    }
    if (!loops.length) throw new Error('No shapes found in this SVG. Save it with paths or basic shapes (no text).');

    const cleaned = loops.map(l => cleanPolygon(l, 0.0005)).filter(Boolean)
      .sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
    if (!cleaned.length) throw new Error('The SVG shapes have no area — they need to be closed outlines.');
    // Largest loop is the outline. Loops inside it are holes (the largest becomes the
    // inner wall); loops outside it are merged into the outline.
    const largest = cleaned[0];
    const holes = [], extra = [];
    for (const l of cleaned.slice(1)) (isInside(l, largest) ? holes : extra).push(l);
    const merged = unionPolygons([largest, ...extra]);
    if (!merged.length) throw new Error('Could not combine the SVG shapes.');
    const outline = cleanPolygon(merged[0], 0.0005);
    const inner = holes.length ? holes[0] : null;
    const b = bounds(outline);
    return {
      points: outline,
      inner,
      pieces: merged.length,
      holes: holes.length,
      physical: hasPhysical,
      size: { width: b.width, height: b.height },
    };
  } finally {
    host.remove();
  }
}
