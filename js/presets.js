// Starter shapes, drawn at roughly 70 mm across, in mm with y down. They are inserted at
// PRESET_SIZE_MM on their longest side — earring size — and the size dialog that follows the
// tile can override that; the drawings below stay at their own scale so the fitted outlines
// keep the deviations noted with them.
//
// Each one is the outline it has always been, but described the way the Points tool describes
// a shape: a handful of anchors carrying Bézier handles (`in`/`out`, offsets from the anchor)
// instead of a hundred-odd sampled points. A circle is four points, not ninety-six, so a
// starter shape can actually be edited after it is inserted.
// Where a shape used to be sampled from a formula, the curve is fitted to that same formula;
// the worst deviation from the old outline is noted with the shape, and is far below the
// 0.4 mm blade width.

// What a starter shape measures on its longest side when it is inserted. Cutters for earrings
// are the common case and they are small; the size dialog is right there for everything else.
export const PRESET_SIZE_MM = 30;

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
// A sweep given backwards (a1 < a0) gets a negative handle length, which points the tangents
// the way the walk goes — that is what a concave bite like the moon's is made of.
function arcPts(cx, cy, r, a0, a1, n = 2) {
  const step = (a1 - a0) / n, h = r * (4 / 3) * Math.tan(step / 4);
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

// Four anchors on the axes, handles along the tangent: the cheapest round outline there is.
const ellipse = (cx, cy, rx, ry) => DIRS.map(([dx, dy], i) => {
  const [tx, ty] = DIRS[(i + 1) % 4];             // the tangent is a quarter turn ahead
  const h = [tx * K * rx, ty * K * ry];
  return node(cx + rx * dx, cy + ry * dy, [-h[0], -h[1]], h);
});
const circle = (cx, cy, r) => ellipse(cx, cy, r, r);

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

  oval: { label: 'Oval', make: () => ellipse(0, 0, 24, 35) },

  egg: {
    label: 'Egg',
    // An oval with one end narrower: the same four anchors, the widest point pushed below the
    // middle, and handles that reach further towards the round end than towards the point.
    make: () => {
      const rx = 24, top = -35, bot = 35, wide = 6;
      const up = (wide - top) * 0.62, down = (bot - wide) * 0.58;
      return [
        node(0, top, [-15, 0], [15, 0]),
        node(rx, wide, [0, -up], [0, down]),
        node(0, bot, [20, 0], [-20, 0]),
        node(-rx, wide, [0, down], [0, -up]),
      ];
    },
  },

  teardrop: {
    label: 'Teardrop',
    // A circle with a point drawn out of the top of it. The tip is held at about 50°, not the
    // 33° the handles first gave it: a sharper point than that is a sliver of clay that tears
    // off the cut piece, and no blade this side of 0.4 mm can hold it anyway.
    make: () => {
      const r = 22, cy = 13, h = r * (4 / 3) * Math.tan(Math.PI / 8);
      return [
        corner(0, -35, [-6.8, 15], [6.8, 15]),
        node(r, cy, [0, -22], [0, h]),
        node(0, cy + r, [h, 0], [-h, 0]),
        node(-r, cy, [0, h], [0, -22]),
      ];
    },
  },

  leaf: {
    label: 'Leaf',
    // Two anchors and nothing else — a tip at each end, handles bulging out to the sides.
    // The tips come out at 90°, which is blunt enough to print and still reads as a point.
    make: () => [
      corner(0, -35, [-26, 26], [26, 26]),
      corner(0, 35, [26, -26], [-26, -26]),
    ],
  },

  pebble: {
    label: 'Pebble',
    // An outline with no symmetry to it: five anchors at uneven radii, each handle laid along
    // the line between its two neighbours, which is what keeps the curve smooth instead of lumpy.
    make: () => {
      const P = [[-88, 34], [-8, 29], [62, 33], [148, 30], [212, 27]].map(([deg, r]) => {
        const a = deg * Math.PI / 180;
        return { x: r * Math.cos(a), y: r * Math.sin(a) * 1.05 };
      });
      return P.map((p, i) => {
        const a = P[(i + P.length - 1) % P.length], b = P[(i + 1) % P.length];
        const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
        const back = Math.hypot(p.x - a.x, p.y - a.y) * 0.4, fwd = Math.hypot(b.x - p.x, b.y - p.y) * 0.4;
        return node(p.x, p.y, [-dx / L * back, -dy / L * back], [dx / L * fwd, dy / L * fwd]);
      });
    },
  },

  halfCircle: {
    label: 'Half circle',
    // Three anchors: the half circle as two cubics, closed by the straight edge across the top.
    make: () => {
      const r = 33, h = r * (4 / 3) * Math.tan(Math.PI / 8);
      return [corner(r, 0, null, [0, h]), node(0, r, [h, 0], [-h, 0]), corner(-r, 0, [0, h], null)];
    },
  },

  arch: {
    label: 'Arch',
    // Flat bottom, straight sides, a half circle on top.
    make: () => {
      const r = 22, spring = -11, bot = 33, h = r * (4 / 3) * Math.tan(Math.PI / 8);
      return [
        corner(-r, bot),
        corner(-r, spring, null, [0, -h]),
        node(0, spring - r, [-h, 0], [h, 0]),
        corner(r, spring, [0, -h], null),
        corner(r, bot),
      ];
    },
  },

  bar: {
    label: 'Rounded bar',
    // Two straight sides closed by a half circle at each end.
    make: () => {
      const r = 20, side = 15, h = r * (4 / 3) * Math.tan(Math.PI / 8);
      return [
        corner(r, -side, [0, -h], null),
        corner(r, side, null, [0, h]),
        node(0, side + r, [h, 0], [-h, 0]),
        corner(-r, side, [0, h], null),
        corner(-r, -side, null, [0, -h]),
        node(0, -side - r, [-h, 0], [h, 0]),
      ];
    },
  },

  rainbow: {
    label: 'Rainbow',
    // A band: the arc over the top, then the same arc walked back inside it, the two joined
    // by a straight end. The inner sweep runs backwards, which is what the signed arcPts is for.
    make: () => [...arcPts(0, 0, 35, Math.PI, TAU), ...arcPts(0, 0, 17, TAU, Math.PI)],
  },

  moon: {
    label: 'Moon',
    // A circle with a bite taken out of it. The horns are where the two circles cross: one
    // anchor each, carrying the outer arc's tangent on one side and the bite's on the other,
    // which is why they are the one place in here that must not be smooth.
    make: () => {
      const R = 35, r = 31, d = 20;                      // the circle, the bite, how far off-centre
      const x = (d * d + R * R - r * r) / (2 * d), y = Math.sqrt(R * R - x * x);
      const a = Math.atan2(y, x), b = Math.atan2(y, x - d);
      const outer = arcPts(0, 0, R, a, TAU - a, 3);      // the long way round, through 180°
      const bite = arcPts(d, 0, r, TAU - b, b);          // backwards, so it curves inward
      outer[outer.length - 1].out = bite[0].out;
      outer[0].in = bite[bite.length - 1].in;
      outer[0].smooth = outer[outer.length - 1].smooth = false;
      return [...outer, bite[1]];
    },
  },

  shield: {
    label: 'Shield',
    // A tag: straight top edge, rounded top corners, sides drawn down to a point.
    make: () => {
      const w = 24, top = -32, rad = 9, h = K * rad;
      return [
        corner(-w + rad, top, [-h, 0], null),
        corner(w - rad, top, null, [h, 0]),
        node(w, top + rad, [0, -h], [0, 20]),
        node(0, 35, [16, -16], [-16, -16], false),       // the point at the bottom
        node(-w, top + rad, [0, 20], [0, -h]),
      ];
    },
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

  roundedTriangle: {
    label: 'Rounded triangle',
    // Straight sides with a generous fillet at each corner: the two tangent points sit `t`
    // back from the corner and the 120° turn between them is a single cubic.
    make: () => {
      const R = 52, rad = 13, t = rad / Math.tan(Math.PI / 6), h = rad * (4 / 3) * Math.tan(Math.PI / 6);
      const V = [0, 1, 2].map(i => {
        const a = (i / 3) * TAU - Math.PI / 2;
        return { x: R * Math.cos(a), y: R * Math.sin(a) };
      });
      const unit = (from, to) => {
        const dx = to.x - from.x, dy = to.y - from.y, L = Math.hypot(dx, dy);
        return { x: dx / L, y: dy / L };
      };
      const pts = [];
      for (let i = 0; i < 3; i++) {
        const v = V[i], back = unit(v, V[(i + 2) % 3]), on = unit(v, V[(i + 1) % 3]);
        pts.push(corner(v.x + back.x * t, v.y + back.y * t, null, [-back.x * h, -back.y * h]));
        pts.push(corner(v.x + on.x * t, v.y + on.y * t, [-on.x * h, -on.y * h], null));
      }
      return pts;
    },
  },

  hexagon: {
    label: 'Hexagon',
    make: () => Array.from({ length: 6 }, (_, i) => {
      const a = (i / 6) * TAU - Math.PI / 2;
      return { x: 32 * Math.cos(a), y: 35 * Math.sin(a) };
    }),
  },

  diamond: {
    label: 'Diamond',
    make: () => [{ x: 0, y: -35 }, { x: 23, y: 0 }, { x: 0, y: 35 }, { x: -23, y: 0 }],
  },

  trapezoid: {
    label: 'Trapezoid',
    make: () => [{ x: -13, y: -30 }, { x: 13, y: -30 }, { x: 23, y: 30 }, { x: -23, y: 30 }],
  },

  star: {
    label: 'Star',
    make: () => Array.from({ length: 10 }, (_, i) => {
      const a = (i / 10) * TAU - Math.PI / 2, r = i % 2 === 0 ? 36 : 17;
      return { x: r * Math.cos(a), y: r * Math.sin(a) };
    }),
  },

  heart: {
    label: 'Heart',
    make: () => [...HEART_HALF, ...mirrored(HEART_HALF.slice(1, -1))],
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
