// Starter shapes, all roughly 70 mm across, in mm with y down.
//
// Each one is the outline it has always been, but described the way the Points tool describes
// a shape: a handful of anchors carrying Bézier handles (`in`/`out`, offsets from the anchor)
// instead of a hundred-odd sampled points. A circle is four points, not ninety-six, so a
// starter shape can actually be edited after it is inserted.
// Where a shape used to be sampled from a formula, the curve is fitted to that same formula;
// the worst deviation from the old outline is noted with the shape, and is far below the
// 0.4 mm blade width.

const TAU = Math.PI * 2;
const K = 0.5522847498;              // handle length / radius for a quarter circle
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];   // right, down, left, up

// An anchor with its handles as offsets; either may be left out, which keeps that side
// straight. `smooth` marks the two as collinear — the point bar's "Sync handles".
function node(x, y, inH, outH, smooth = true) {
  const p = { x, y, smooth };
  if (inH) p.in = { x: inH[0], y: inH[1] };
  if (outH) p.out = { x: outH[0], y: outH[1] };
  return p;
}
const corner = (x, y, inH = null, outH = null) => node(x, y, inH, outH, false);

// An anchor at angle `a` on a circle, with its handles along the tangent there.
const onArc = (cx, cy, r, a, hIn, hOut) => node(
  cx + r * Math.cos(a), cy + r * Math.sin(a),
  hIn ? [Math.sin(a) * hIn, -Math.cos(a) * hIn] : null,
  hOut ? [-Math.sin(a) * hOut, Math.cos(a) * hOut] : null,
);

// A circular arc as `n` cubics — two of them hold a half circle to within 0.003 mm.
// The first anchor has no incoming handle and the last none outgoing, so whatever comes
// before or after joins with a straight line, exactly as the old sampled outlines did.
function arcPts(cx, cy, r, a0, a1, n = 2) {
  const step = (a1 - a0) / n, h = Math.abs(r * (4 / 3) * Math.tan(step / 4));
  return Array.from({ length: n + 1 }, (_, i) =>
    onArc(cx, cy, r, a0 + step * i, i > 0 ? h : 0, i < n ? h : 0));
}

// Two arcs that meet where the outline closes leave the same point twice; fold the second
// one into the first, so the seam is one smooth anchor instead of a zero-length segment.
function closeLoop(pts) {
  const first = pts[0], last = pts[pts.length - 1];
  if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-9) {
    if (last.in) { first.in = last.in; first.smooth = true; }
    pts.pop();
  }
  return pts;
}

// Mirror a run of anchors across x = 0, reversed so it continues the same walk.
const mirrored = (pts) => pts.slice().reverse().map(p => node(
  -p.x, p.y,
  p.out ? [-p.out.x, p.out.y] : null,
  p.in ? [-p.in.x, p.in.y] : null,
  p.smooth,
));

// Quarter turns clockwise on screen: (x, y) → (−y, x).
function turn(p, k) {
  let { x, y } = p;
  for (let i = 0; i < k; i++) { const t = x; x = -y; y = t; }
  return { x, y };
}

const circle = (cx, cy, r) => DIRS.map(([dx, dy], i) => {
  const [tx, ty] = DIRS[(i + 1) % 4];             // the tangent is a quarter turn ahead
  return node(cx + r * dx, cy + r * dy, [-tx * K * r, -ty * K * r], [tx * K * r, ty * K * r]);
});

// The heart, fitted to  x = 33.6 sin³t,  y = −2.1 (13 cos t − 5 cos 2t − 2 cos 3t − cos 4t).
// This is the right-hand half, walked from the notch down to the point at the bottom. Both
// ends sit on x = 0 and carry symmetric handles, so mirroring the rest closes the outline.
// Worst deviation from the old 140-point outline: 0.11 mm.
const HEART_HALF = [
  corner(0, -10.5, [0, -1.99], [0, -1.99]),                  // the notch, a cusp
  node(2.466, -17.162, [-1.035, 1.61], [9.28, -14.438]),
  node(33.6, -8.4, [0, -16.041], [0, 16.371]),               // widest point
  node(1.676, 31.381, [7.84, -13.215], [-0.586, 0.987]),
  corner(0, 35.7, [0, -1.201], [0, -1.201]),                 // the point at the bottom
];

export const PRESETS = {
  circle: { label: 'Circle', make: () => circle(0, 0, 35) },

  heart: {
    label: 'Heart',
    make: () => [...HEART_HALF, ...mirrored(HEART_HALF.slice(1, -1))],
  },

  star: {
    label: 'Star',
    make: () => Array.from({ length: 10 }, (_, i) => {
      const a = (i / 10) * TAU - Math.PI / 2, r = i % 2 === 0 ? 36 : 17;
      return { x: r * Math.cos(a), y: r * Math.sin(a) };
    }),
  },

  roundedSquare: {
    label: 'Rounded square',
    make: () => {
      const s = 32, r = 9, h = K * r, pts = [];
      for (let k = 0; k < 4; k++) {                // one corner per quarter turn
        const a = turn({ x: s - r, y: -s }, k), b = turn({ x: s, y: -(s - r) }, k);
        const ha = turn({ x: h, y: 0 }, k), hb = turn({ x: 0, y: -h }, k);
        pts.push(corner(a.x, a.y, null, [ha.x, ha.y]));
        pts.push(corner(b.x, b.y, [hb.x, hb.y], null));
      }
      return pts;
    },
  },

  flower: {
    label: 'Flower',
    // Fitted to the rose curve r = 26 + 9 cos 6t: one anchor on every extreme, tips and
    // valleys alike, with the handles across the radius. Worst deviation 0.15 mm.
    make: () => {
      const pts = [];
      for (let i = 0; i < 6; i++) {
        pts.push(onArc(0, 0, 35, (i / 6) * TAU, 7.88, 7.88));          // tip of a petal
        pts.push(onArc(0, 0, 17, ((i + 0.5) / 6) * TAU, 1.98, 1.98));  // valley between two
      }
      return pts;
    },
  },

  gingerbread: {
    label: 'Gingerbread man',
    // Circles for the head, the arms and the legs joined by three corners — the same
    // construction as before, with every arc written as two cubics instead of 18 samples.
    // Walks clockwise (y down) from the top of the head. Worst deviation 0.003 mm.
    make: () => closeLoop([
      ...arcPts(0, -24, 13, -Math.PI / 2, Math.PI * 0.35),        // head, right side
      ...arcPts(21, -4, 7, -Math.PI * 0.6, Math.PI * 0.45),       // right arm
      corner(12, 8),
      ...arcPts(11, 26, 7.5, -Math.PI * 0.15, Math.PI * 0.85),    // right leg
      corner(0, 20),
      ...arcPts(-11, 26, 7.5, Math.PI * 0.15, Math.PI * 1.15),    // left leg
      corner(-12, 8),
      ...arcPts(-21, -4, 7, Math.PI * 0.55, Math.PI * 1.6),       // left arm
      ...arcPts(0, -24, 13, Math.PI * 0.65, Math.PI * 1.5),       // head, left side
    ]),
  },

  tree: {
    label: 'Christmas tree',
    make: () => [
      { x: 0, y: -36 }, { x: 12, y: -18 }, { x: 6, y: -18 }, { x: 19, y: 0 }, { x: 11, y: 0 }, { x: 26, y: 20 },
      { x: 6, y: 20 }, { x: 6, y: 34 }, { x: -6, y: 34 }, { x: -6, y: 20 }, { x: -26, y: 20 }, { x: -11, y: 0 },
      { x: -19, y: 0 }, { x: -6, y: -18 }, { x: -12, y: -18 },
    ],
  },
};
