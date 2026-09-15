// Starter shapes, all roughly 70 mm across, in mm with y down.

const ring = (n, fn) => Array.from({ length: n }, (_, i) => fn((i / n) * Math.PI * 2));

export const PRESETS = {
  circle: { label: 'Circle', make: () => ring(96, t => ({ x: 35 * Math.cos(t), y: 35 * Math.sin(t) })) },
  heart: {
    label: 'Heart',
    make: () => ring(140, t => ({
      x: 16 * Math.sin(t) ** 3 * 2.1,
      y: -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) * 2.1,
    })),
  },
  star: {
    label: 'Star',
    make: () => ring(10, (t) => {
      const i = Math.round(t / (Math.PI / 5));
      const r = i % 2 === 0 ? 36 : 17;
      return { x: r * Math.cos(t - Math.PI / 2), y: r * Math.sin(t - Math.PI / 2) };
    }),
  },
  roundedSquare: {
    label: 'Rounded square',
    make: () => {
      const s = 32, r = 9, pts = [];
      const corners = [[s - r, -(s - r)], [s - r, s - r], [-(s - r), s - r], [-(s - r), -(s - r)]];
      corners.forEach(([cx, cy], k) => {
        for (let i = 0; i <= 12; i++) {
          const a = -Math.PI / 2 + k * Math.PI / 2 + (i / 12) * Math.PI / 2;
          pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
        }
      });
      return pts;
    },
  },
  flower: {
    label: 'Flower',
    make: () => ring(180, t => { const r = 26 + 9 * Math.cos(6 * t); return { x: r * Math.cos(t), y: r * Math.sin(t) }; }),
  },
  gingerbread: {
    label: 'Gingerbread man',
    make: () => {
      // union of circles/capsules approximated as one outline: head, body, arms, legs
      const pts = [];
      const arc = (cx, cy, r, a0, a1, n = 18) => { for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); } };
      // walk clockwise (y down) starting at top of head
      arc(0, -24, 13, -Math.PI / 2, Math.PI * 0.35);             // head right side
      arc(21, -4, 7, -Math.PI * 0.6, Math.PI * 0.45);             // right arm
      pts.push({ x: 12, y: 8 });
      arc(11, 26, 7.5, -Math.PI * 0.15, Math.PI * 0.85);          // right leg
      pts.push({ x: 0, y: 20 });
      arc(-11, 26, 7.5, Math.PI * 0.15, Math.PI * 1.15);          // left leg
      pts.push({ x: -12, y: 8 });
      arc(-21, -4, 7, Math.PI * 0.55, Math.PI * 1.6);             // left arm
      arc(0, -24, 13, Math.PI * 0.65, Math.PI * 1.5);             // head left side
      return pts;
    },
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
