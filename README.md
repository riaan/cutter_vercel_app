# Cutter — draw a shape, print a cutter

A single-page web app that turns a 2D outline into a 3D-printable cutter (cookie, clay, fondant…) as a binary STL.
Works on phones, tablets (touch, pen) and desktop browsers. No build step, no backend,
no accounts — everything runs in the browser.

## What it does

- **Draw** the shape freehand; the outline closes, smooths and repairs itself
  (self-intersections are resolved automatically, tiny slivers dropped).
- **Tool explanation**: picking a tool shows a short line at the canvas' top left for five
  seconds; it then slides away into an (i) that brings it back on hover (tap on touch).
- **Points** tool: tap to place corners, drag them, tap a line to insert a corner,
  double-tap a corner to delete it.
- **Move & resize**: drag the shape, corner/edge handles to resize, top knob to rotate
  (snaps to 15°), two-finger pinch/twist on touch screens.
- **Upload SVG**: any SVG with paths or basic shapes. A dialog asks for the size (prefilled
  from the SVG's physical units, or 80 mm wide). Multiple shapes are merged; a hole becomes the inner wall.
- **Starter shapes**: circle, heart, star, rounded square, flower, gingerbread man, tree.
- **Inner wall**: switch *Editing* to "Inner wall" and draw a hole (or upload an SVG that has one).
  The area between the walls is what gets cut. Bars at base level connect the inner wall to
  the outer wall so it keeps its position; count, thickness (auto = 10% of the width) and
  rotation are adjustable.
- **Points tool**: select a corner to delete it (button, Delete key, right-click/long-press
  menu) or give it Bézier curve handles. Handles can be kept in sync (smooth curve) or moved
  independently (sharp corner).
- **Symmetry**: *Mirror left–right* and/or *top–bottom*. Only one side (or one quarter) is
  editable; strokes and corners magnet to the mirror line and the other side follows live.
  Switching a mirror on or off reshapes what is already drawn, so it asks first (and it can be undone).
- **Which wall the buttons act on**: *Editing* decides. They only appear once the wall you are
  editing has a shape. On the outer wall, *Clear* and the two
  *Flip* buttons act on the whole drawing, inner wall included, and *Center* moves everything to
  the middle of the canvas. On the inner wall they act on the inner wall alone; *Center* is off
  and *Align* takes its place — nine spots (corners, sides, middle) to line the inner wall up
  against the outer shape.
- **Grid & snapping**: at the canvas' bottom left, next to the scale bar. Grid size 1–20 mm; with
  *Snap* on, corners, moves and resizes land on grid lines.
- **Guides**: add vertical/horizontal guide lines, drag their tabs at the canvas edge; shapes and
  corners snap to them. Double-tap a tab to remove a guide.
- **Zoom & pan the canvas**: the button at the top right of the drawing shows the current zoom
  and opens a menu with zoom in/out, presets (50 / 100 / 200 %) and *Reset*. Range is 25–800 %;
  100 % means the whole shape fits. Zooming from the menu re-centres the view on the shape, so it
  never ends up off screen; scrolling over the canvas zooms towards the cursor instead. Pan by
  dragging with the **right mouse button** (or the middle one), or turn on the *hand* button and
  drag normally — on touch, two fingers pinch and pan. Panning never moves the shape itself.
  Keyboard: `+` / `-` zoom, `0` reset, `H` toggles panning.
- **Exact size**: width/height inputs in mm with a proportion lock.
- **Cutter walls**: cutter height, blade thickness, base (flange) width/thickness,
  optional support step — with a live cross-section diagram.
- **Live 3D preview** (drag to orbit, pinch/scroll to zoom), footprint size, volume and
  an estimated PLA weight. *Top* matches the drawing; *Back* looks at the cutting edge.
- **Download STL**: a watertight single-body mesh centred on the print bed. The solid is
  built with a CSG kernel (Manifold), so slicers report no open or non-manifold edges. By default the top
  view of the model equals the drawing; turn on *Mirror the model* when the cut piece must
  match the drawing exactly (a cutter is used upside-down, so letters would otherwise come out mirrored).

## Run locally

Requires Node.js 18+ (any recent version). No dependencies to install.

```bash
node dev-server.js        # or: npm run dev
# open http://localhost:3000
```

Any static server works too, e.g. `python3 -m http.server 3000`.
(Opening `index.html` directly from the file system will not work — ES modules need http.)

## Deploy to Vercel (free tier)

Option A — CLI:

```bash
npm i -g vercel
vercel            # accept defaults; framework "Other", no build command, output "."
vercel --prod
```

Option B — dashboard: push this folder to a GitHub/GitLab repo, then "Add New Project" in
Vercel, import the repo, leave Framework Preset = Other and Build Command empty. Deploy.

`vercel.json` only adds long cache headers for the `vendor/` libraries.

## For AI coding agents

Read `AGENTS.md` first — it holds the architecture, conventions, decisions and the verification
steps. `CLAUDE.md`, `GEMINI.md`, `.cursor/rules` and `.github/copilot-instructions.md` just point to it.

## Project layout

```
index.html          page + settings panel
styles.css          layout & theme (responsive: desktop / tablet / phone)
js/app.js           wiring: UI, live regeneration, STL download
js/editor.js        2D canvas editor (draw / points / move & resize, undo, gestures)
js/geometry.js      polygon clean-up, offsetting, mesh building, STL writer
js/svgimport.js     SVG → outline (uses the browser's own path engine)
js/viewer.js        three.js preview
js/presets.js       starter shapes
vendor/             three.js (+ OrbitControls), clipper-lib and manifold-3d (WebAssembly), vendored
tests/mesh-check.mjs mesh integrity test: node tests/mesh-check.mjs 100
dev-server.js       zero-dependency static server for local testing
```

## Smoothing and resolution

*Sketch smoothing* affects freehand strokes when you lift the pen: the stroke is simplified
(Ramer–Douglas–Peucker) and rounded (Chaikin corner cutting). Left = keep every wobble and
sharp corner, right = a smooth curve. *Round corners* applies the same rounding to the
selected wall on demand — imports and point-drawn shapes too — with strength from the slider.

Outlines are kept at high resolution: SVGs are sampled every 0.05 mm of their native size,
and shapes are only simplified at the final size with a 0.002 mm tolerance (below printer
resolution), so curves stay round even when a small SVG is scaled up a lot.

## Printing tips

Print with the wide base on the bed, no supports. PLA or PETG, 0.2 mm layers.
The default 0.4 mm blade is a single line for a 0.4 mm nozzle; the 0.8 mm step behind it
prints as two lines. Use a blade thickness that matches your nozzle.

## Credits

three.js (MIT), clipper-lib (Boost Software License) and manifold-3d (Apache 2.0), all in `vendor/`.
