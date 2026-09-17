# Cutter — draw a shape, print a cutter

A single-page web app that turns 2D outlines into a 3D-printable plate of cutters (cookie, clay, fondant…) as a binary STL.
Works on phones, tablets (touch, pen) and desktop browsers. No build step, no backend,
no accounts — everything runs in the browser.

## What it does

- **Several shapes on one plate**: the list at the canvas' top left holds every shape you are
  making. **+** adds one, clicking a row picks the shape you want to work on, the trash button
  takes one off. The shape you pick is the one you draw, move and resize; the others stay on the
  canvas in grey and cannot be picked up by accident. Every shape has its own size, walls, support
  step and connections — changing the height of one leaves the others exactly as they were — and
  the settings panel says whose settings it is showing. The 3D preview and the STL are always the
  whole plate, so what you see is what comes off the printer. Shapes may not touch: while you drag
  one it stops against its neighbour, and a stroke drawn on top of another shape is refused, so two
  cutters never fuse into one piece.
- **Draw** the shape freehand; the outline closes, smooths and repairs itself
  (self-intersections are resolved automatically, tiny slivers dropped).
- **Tool explanation**: the (i) beside the three tool buttons explains the tool in hand — hover it
  (or tap it on touch) and a short line slides out under it
  (tap on touch).
- **Points** tool: tap to place corners one after the other. They are joined by a dashed line
  as you go and the shape is *not* finished until you click the first corner again — it glows
  and pulses once there are three, and a line at the bottom of the canvas says so. Nothing is
  cut and nothing appears in the 3D preview until it is closed. Once it is, corners are added
  by tapping the outline itself (the cursor turns into a +); a tap on the canvas beside or
  inside the shape only lets go of the corner you had selected. Drag corners to move them,
  double-tap one to delete it.
  **Hold the button down as you place a corner and pull away** and it comes out curved instead
  of sharp: the corner stays where you put it and the drag pulls its two curve handles out of
  it, kept exactly opposite and the same length, so the outline runs smoothly through it. Let go
  without moving and you get a plain sharp corner. Shift keeps the pull to 45° steps. It is how
  a smooth outline is drawn in one pass — place, pull, place, pull — and it works the same
  whether you place the corner on the canvas or on the outline of a shape you have already drawn.
  (Dragging a corner that was already there still moves it, as before.) The arrow keys nudge the selected corner by 1 mm
  (5 mm with Shift), and holding Shift while dragging keeps it on one straight line —
  horizontal or vertical for a corner, also diagonal for a curve handle. The bar at the
  canvas' top right shows the exact position of the corner (and of its curve handles),
  which you can type over.
- **Move & resize**: drag the shape, corner/edge handles to resize, top knob to rotate
  (snaps to 15°), two-finger pinch/twist on touch screens. Holding Shift while dragging keeps
  the shape on one straight line through where the drag started, and the arrow keys nudge it
  by 1 mm (5 mm with Shift). A resize normally holds the corner or edge opposite the handle
  still; hold Alt (Option on a Mac) and it holds the middle of the shape instead, so every side
  moves and the shape stays where it is. The bar at the canvas' top right shows where the middle
  of the shape sits, which you can type over.
- **Import**: an SVG with paths or basic shapes, or an STL of a cutter. For an SVG a dialog asks
  for the size of the whole drawing (prefilled from the SVG's physical units, or 80 mm wide); each
  separate outline becomes a shape of its own, laid out the way the file lays them out, and a hole
  inside one becomes that shape's inner wall. An STL is read back as whole cutters — see
  *Opening an STL* below.
- **Starter shapes**: twenty-two outlines, picked from a grid of previews so you can see each
  one before you insert it. Round ones (circle, oval, egg, teardrop, leaf, pebble), arches and
  bands (half circle, arch, rounded bar, rainbow, moon, shield), straight-sided ones (rounded
  square, rounded triangle, hexagon, diamond, trapezoid) and figures (star, heart, flower,
  gingerbread man, Christmas tree). Picking one asks how big it should be, prefilled at 30 mm —
  earring size — which you can type over; the size boxes under the canvas can still change it later.
  They arrive as a handful of points with curve handles (a leaf is two points, a circle four),
  so you can reshape one with the *Points* tool instead of pushing hundreds of dots around.
- **Inner wall**: switch *Editing* to "Inner wall" and draw a hole (or import an SVG that has one).
  The area between the walls is what gets cut. Bars at base level connect the inner wall to
  the outer wall so it keeps its position; count, thickness (auto = 10% of the width) and
  rotation are adjustable.
- **Points tool**: select a corner to delete it (button, Delete key, right-click/long-press
  menu) or give it Bézier curve handles. Handles can be kept in sync (smooth curve) or moved
  independently (sharp corner).
- **Symmetry**: *Mirror left–right* and/or *top–bottom*, for the shape you are editing. A
  mirrored half is closed by its mirror lines, so there is nothing to click shut: with *Points*
  every tap keeps adding a corner to the half. The mirror
  lines run through the middle of that shape, so it works wherever the shape sits on the plate and
  the shape can still be moved. Only one side (or one quarter) is editable; strokes and corners
  magnet to the mirror line and the other side follows live. Switching a mirror on or off reshapes
  what is already drawn, so it asks first (and it can be undone).
- **Which wall the buttons act on**: *Editing* decides. They only appear once the wall you are
  editing has a shape. On the outer wall, *Clear* and the two
  *Flip* buttons act on the shape you are editing, inner wall included, and *Center* moves the
  whole drawing to the middle of the canvas — every shape together, so they keep their places
  relative to each other. On the inner wall they act on the inner wall alone; *Center* is off
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
- **Exact size**: width/height inputs in mm with a proportion lock, for the shape you are editing.
- **Cutter walls**: cutter height, blade thickness, base (flange) width/thickness,
  optional support step — with a live cross-section diagram.
- **Live 3D preview** (drag to orbit, pinch/scroll to zoom), footprint size, volume and
  an estimated PLA weight. *Top* matches the drawing; *Back* looks at the cutting edge.
- **Cut piece preview**: *Cut piece* (next to the 3D view buttons) opens a popup with the pieces
  the plate leaves behind, painted in a clay colour you pick from the swatches or from the
  browser's own colour picker. It is shown the way the piece comes out: the right way up, but
  mirrored left–right when the cutter is not mirrored — so a shape that will come out
  back-to-front says so, with a button that mirrors the cutter for you. The colour is only for looking at; it is not part of the cutter and
  is not saved.
- **Download STL**: every shape on the plate, watertight, in the places you drew them, centred on
  the print bed. The solid is
  built with a CSG kernel (Manifold), so slicers report no open or non-manifold edges. By default the top
  view of the model equals the drawing; turn on *Mirror the model* when the cut piece must
  match the drawing exactly (a cutter is used upside-down, so letters would otherwise come out
  mirrored). Mirroring turns the whole plate over, so it is one setting for all the shapes.
- **Save / open a project**: *Save project* writes a `.cutter` file holding every shape and all
  its settings; open it later and you get exactly the same plate back. It is a plain zip —
  rename it to `.zip` and you will find `project.json`, the `model.stl` as downloaded, and a
  picture of the drawing and of the 3D view. Only `project.json` is read back; the mesh is
  rebuilt from it.
- **Opening an STL**: an STL of a cutter — one of yours from before project files existed, or one
  made elsewhere — can be opened with *Open project* or with *Import*, and comes back as a drawing
  with its settings. A file holding several cutters comes back as several shapes, each with the
  settings measured off it. A cutter is a stack of straight-walled tiers, so a horizontal cut
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
js/app.js           wiring: UI, shapes list, live regeneration, STL download, save/open, STL import
js/editor.js        2D canvas editor: the shape layers, draw / points / move & resize, undo, gestures
js/geometry.js      polygon clean-up, offsetting, mesh building, STL writer
js/svgimport.js     SVG → one outline (+ hole) per shape (uses the browser's own path engine)
js/stlimport.js     STL → one shape per solid, with the settings that built it (slices the mesh)
js/viewer.js        three.js preview
js/presets.js       starter shapes
js/project.js       .cutter project file: every shape and its settings, and reading them back
js/zip.js           tiny zip reader/writer for the project file
vendor/             three.js (+ OrbitControls), clipper-lib and manifold-3d (WebAssembly), vendored
tests/mesh-check.mjs mesh integrity test: node tests/mesh-check.mjs 100
tests/project-roundtrip.mjs  save → open → same mesh: node tests/project-roundtrip.mjs
tests/stl-import.mjs  STL → drawing → same solid: node tests/stl-import.mjs 40
dev-server.js       zero-dependency static server for local testing
```

## Smoothing and resolution

*Sketch smoothing* belongs to the pen and to nothing else: when you lift it the stroke is
simplified (Ramer–Douglas–Peucker) and rounded (Chaikin corner cutting). Left = keep every wobble
and sharp corner, right = a smooth curve. It is in *Canvas setup*, and only while **Draw** is the
tool in hand — under *Points* and *Move* there is no stroke for it to act on.

**Rounding a shape you have already drawn** is the wave button in the toolbar, just left of
*Canvas*. It is a mode, and it works from all three tools, on the outer or the inner wall of
whichever shape is selected:

1. Press it and a slider comes up at the bottom of the canvas, starting at how round the wall
   already is.
2. Drag it and the corners bend with it — on the canvas and in the 3D preview — so you can see
   what you are choosing. Nothing else can be edited while the slider is up.
3. **Apply** keeps it (one undo step) or **Cancel** puts the shape back exactly as it was.
   Either one closes the mode. Enter and Esc do the same.

A shape made of a handful of corners keeps every one of them: each gets Bézier curve handles
reaching the distance the slider says towards its neighbours, so a square becomes a rounded
square you can still edit corner by corner, and sliding back to 0 makes the corners sharp again.
(A curve bulges past its corner, so the shape grows a little as you slide — the size boxes put it
back.) A traced outline — a sketch, an import, anything past about fifty points — has no corners
to speak of, so its corners are cut back as a line instead, the way a freehand stroke is.

Outlines are kept at high resolution: SVGs are sampled every 0.05 mm of their native size,
and shapes are only simplified at the final size with a 0.002 mm tolerance (below printer
resolution), so curves stay round even when a small SVG is scaled up a lot.

## Printing tips

Print with the wide base on the bed, no supports. PLA or PETG, 0.2 mm layers.
The default 0.4 mm blade is a single line for a 0.4 mm nozzle; the 0.8 mm step behind it
prints as two lines. Use a blade thickness that matches your nozzle.

## Credits

three.js (MIT), clipper-lib (Boost Software License) and manifold-3d (Apache 2.0), all in `vendor/`.
