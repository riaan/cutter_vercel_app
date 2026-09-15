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
  double-tap a corner to delete it. The arrow keys nudge the selected corner by 1 mm
  (5 mm with Shift), and holding Shift while dragging keeps it on one straight line —
  horizontal or vertical for a corner, also diagonal for a curve handle. The bar at the
  canvas' top right shows the exact position of the corner (and of its curve handles),
  which you can type over.
- **Move & resize**: drag the shape, corner/edge handles to resize, top knob to rotate
  (snaps to 15°), two-finger pinch/twist on touch screens.
- **Upload**: an SVG with paths or basic shapes, or an STL of a cutter. For an SVG a dialog asks
  for the size (prefilled from the SVG's physical units, or 80 mm wide); multiple shapes are
  merged and a hole becomes the inner wall. An STL is read back as a whole cutter — see
  *Opening an STL* below.
- **Starter shapes**: twenty-two outlines, picked from a grid of previews so you can see each
  one before you insert it. Round ones (circle, oval, egg, teardrop, leaf, pebble), arches and
  bands (half circle, arch, rounded bar, rainbow, moon, shield), straight-sided ones (rounded
  square, rounded triangle, hexagon, diamond, trapezoid) and figures (star, heart, flower,
  gingerbread man, Christmas tree). Picking one asks how big it should be, prefilled at 30 mm —
  earring size — which you can type over; the size boxes under the canvas can still change it later.
  They arrive as a handful of points with curve handles (a leaf is two points, a circle four),
  so you can reshape one with the *Points* tool instead of pushing hundreds of dots around.
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
- **Show or hide the panels**: the three switches at the top — *Canvas*, *3D*, *Settings* — turn
  each panel off and on. What is left takes over the space, so you can draw across the full width
  or look at nothing but the cutter. At least one of the canvas and the 3D preview stays on:
  the switch of the last one left is greyed out. Everything is on again when you reload.
- **Exact size**: width/height inputs in mm with a proportion lock.
- **Cutter walls**: cutter height, blade thickness, base (flange) width/thickness,
  optional support step — with a live cross-section diagram.
- **Live 3D preview** (drag to orbit, pinch/scroll to zoom), footprint size, volume and
  an estimated PLA weight. *Top* matches the drawing; *Back* looks at the cutting edge.
- **Cut piece preview**: *Cut piece* (next to the 3D view buttons) opens a popup with the piece
  the cutter leaves behind, painted in a clay colour you pick from the swatches or from the
  browser's own colour picker. It is shown the way the piece comes out: the right way up, but
  mirrored left–right when the cutter is not mirrored — so a shape that will come out
  back-to-front says so, with a button that mirrors the cutter for you. The colour is only for looking at; it is not part of the cutter and
  is not saved.
- **Download STL**: a watertight single-body mesh centred on the print bed. The solid is
  built with a CSG kernel (Manifold), so slicers report no open or non-manifold edges. By default the top
  view of the model equals the drawing; turn on *Mirror the model* when the cut piece must
  match the drawing exactly (a cutter is used upside-down, so letters would otherwise come out mirrored).
- **Save / open a project**: *Save project* writes a `.cutter` file holding the drawing and
  every setting; open it later and you get exactly the same cutter back. It is a plain zip —
  rename it to `.zip` and you will find `project.json`, the `model.stl` as downloaded, and a
  picture of the drawing and of the 3D view. Only `project.json` is read back; the mesh is
  rebuilt from it.
- **Opening an STL**: an STL of a cutter — one of yours from before project files existed, or one
  made elsewhere — can be opened with *Open project* or with *Upload*, and comes back as a
  drawing with its settings. A cutter is a stack of straight-walled tiers, so a horizontal cut
  through the model hands the outline straight back: the cut line is read halfway up the blade,
  the heights come from the tiers, the wall widths from how far each tier stands out from the cut
  line, and the connection bars from what crosses the channel at base level. You get the same
  cutter, and can now change it. Two things an STL cannot hold: curve handles (the outline comes
  back as the points it was flattened to) and symmetry (the whole outline comes back, not a half
  to mirror). Anything that is not a cutter — a solid with no blade — gives its outline at the
  top and leaves the wall settings alone, and says so.

## Run locally

Requires Node.js 18+ (any recent version). No dependencies to install.

```bash
node dev-server.js        # or: npm run dev
# open http://localhost:3002
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
js/app.js           wiring: UI, live regeneration, STL download, save/open project, STL import
js/editor.js        2D canvas editor (draw / points / move & resize, undo, gestures)
js/geometry.js      polygon clean-up, offsetting, mesh building, STL writer
js/svgimport.js     SVG → outline (uses the browser's own path engine)
js/stlimport.js     STL → the outline and the settings that built it (slices the mesh)
js/viewer.js        three.js preview
js/presets.js       starter shapes
js/project.js       .cutter project file: what is saved, and reading it back
js/zip.js           tiny zip reader/writer for the project file
vendor/             three.js (+ OrbitControls), clipper-lib and manifold-3d (WebAssembly), vendored
tests/mesh-check.mjs mesh integrity test: node tests/mesh-check.mjs 100
tests/project-roundtrip.mjs  save → open → same mesh: node tests/project-roundtrip.mjs
tests/stl-import.mjs  STL → drawing → same solid: node tests/stl-import.mjs 40
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
