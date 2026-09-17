# Cutter — instructions for coding agents

This file is the single source of truth for any AI coding agent (Claude, OpenAI/Codex, Gemini,
Cursor, Copilot, …) working on this repository. Read it fully before changing anything.
`CLAUDE.md`, `GEMINI.md` and `.github/copilot-instructions.md` only point here — keep it that way;
do not duplicate content into them.

---

## 1. What this project is

**Cutter** is a single-page web app: the user draws or imports one or more 2D outlines and
downloads a 3D-printable plate of cutters (cookie / clay / fondant cutters) as a binary STL. It runs entirely in the
browser — no build step, no backend, no accounts. It must work on phones and tablets (touch, pen)
as well as desktop browsers, and be usable by non-technical people.

Deployment target: Vercel free tier as a static site (also works on any static host).
Local testing: `node dev-server.js` → http://localhost:3002 (PORT overrides it) (zero dependencies).

Owner's language is Dutch; the UI is English. Keep UI copy short, friendly and non-technical.
Never call it a "cookie cutter" in the UI — it is just a "cutter"; the piece it cuts is the
"cut piece". The view from the cutting edge is called "Back". One drawing on the canvas is a
"shape"; all of them together are the "plate".

## 2. Repository layout

```
index.html           page structure, all controls (ids are referenced from js/app.js)
styles.css           tokens + responsive layout (desktop ≥1181px, tablet ≤1180px, phone ≤760px)
js/app.js            wiring: UI ↔ editor ↔ geometry ↔ viewer; shapes list; SVG dialog;
                     starter-shape picker; point bar/menu; download; save/open project;
                     STL import; drop layer + import question + loader; cut-piece popup
js/project.js        .cutter project file: the saved state, validation, zip packing
js/zip.js            minimal stored-only zip writer + reader (no dependency)
js/editor.js         2D canvas editor (ShapeEditor class) — the shape layers, and everything
                     the user draws/edits
js/geometry.js       math: polygon cleanup/offsets (Clipper), symmetry, solid build (Manifold), STL
js/svgimport.js      SVG → one outline (+ hole) per separate shape, via the browser's path engine
js/stlimport.js      STL → one shape per solid in the file, with the settings that built it
js/viewer.js         three.js preview (CutterViewer class)
js/presets.js        starter shapes (few anchors + Bézier handles, see §6)
vendor/              three.module.js (+ addons/controls/OrbitControls.js), clipper.js,
                     manifold.js + manifold.wasm — vendored; no CDN, no npm at runtime
tests/mesh-check.mjs mesh integrity test (Node) — see §8
tests/project-roundtrip.mjs  save → open → identical mesh (Node) — see §8
tests/stl-import.mjs STL → drawing + settings → the same solid (Node) — see §8
dev-server.js        static server for local testing (sets application/wasm for .wasm)
vercel.json          only cache headers for vendor/
package.json         "type": "module"; script `dev`; NO runtime dependencies
README.md            user-facing documentation — keep in sync with behaviour
```

ES modules with a browser import map (`"three"` → `./vendor/three.module.js`). Source files
import three via the relative path `../vendor/three.module.js` so the same code runs in Node
tests without the import map. Opening `index.html` from the file system does not work (modules
need http); this is documented and expected.

## 3. Architecture and data flow

```
user input ──► ShapeEditor (js/editor.js)
                 layers = [ { id, rev, shape: { outer, inner }, sym, symOrigin, params,
                              open: { outer, inner }, bridgeAuto } ]
                 index  = the layer being edited; this.shape / this.sym / this.symOrigin /
                          this.params / this.points are accessors onto it, so the rest of the
                          editor reads as if there were only ever one shape
                 getShape()   → the effective *active* shape (curves flattened, symmetry applied)
                 buildParts() → every layer, effective, each with its own params
                        │ onChange(activeShape, { selectionOnly })
                        ▼
              app.js: updates size inputs, hint, shapes list, auto connection thickness,
                      2D rings per layer (Clipper offsets), debounced regenerate()
                        │
                        ▼
              geometry.buildAll(parts)  ── Manifold CSG per shape ──► { positions, volume, … }
                        │                                              │
                        ▼                                              ▼
              viewer.setMesh() (three.js)                     toBinarySTL() on download
```

### Coordinate conventions (do not break these)
- **Editor / screen space:** millimetres, origin at canvas centre, **y points down**.
- **Model space (STL, three.js):** millimetres, **y up, z up**. `buildCutter` maps
  `y_model = mirror ? y_screen : -y_screen`. With `mirror` **off (default)** the model's top view
  equals the drawing exactly. `mirror` **on** flips it so the *cut piece* matches the drawing
  (a cutter is used upside-down). Do not invert this again; it was changed on user request.
- Connection-bar angles are given in screen space; `buildCutter` negates the angle when
  `mirror` is off (`angleSign = mirror ? 1 : -1`) so the bars appear where the 2D preview shows them.
- The 3D "Top" button must show the same orientation as the canvas.

### Shape layers
- The drawing is a **plate** of shape layers; each one is a cutter and owns its contours, its
  mirror settings, its `symOrigin`, its own copy of `DEFAULT_PARAMS` and its `bridgeAuto` flag.
  Changing the height of one shape leaves the others alone. `mirror` is the one exception: it
  turns the whole plate over, so `app.js › setMirror()` writes it to every layer at once.
- Every layer carries `rev`, a counter of edits to *that* layer. The display cache, the 2D ring
  cache and the overlap guard are keyed on it, so editing one shape does not throw away the work
  done for the others. `version` still counts edits to the drawing as a whole.
- **Shapes may not touch, unless they are allowed to.** `editor.allowOverlap` (off by default,
  one switch for the whole plate, `#overlapBtn` under the shapes list) is what arms the guard. With it up,
  every move, resize, rotate, point edit and stroke is measured against the other layers' outlines
  grown by both base widths plus `SHAPE_GAP` (0.4 mm, a nozzle width): `_keepOut()` grows them
  once, `_blocked()` intersects. A drag that would cross is simply not applied — the shape stops
  against its neighbour; a stroke drawn on top of another shape is refused with a sentence
  (`onBlock`, toasted by app.js with a pointer at the setting, throttled by `_blockNote`). A whole
  shape handed to `setShape()` (a starter shape, a single-shape SVG) is moved clear of the others
  instead, by `_freeSpot()` — the size was settled in a dialog and throwing it away is worse.
  With `allowOverlap` on, `_blocked()` returns false and none of that happens: shapes go where
  they are put and the builder joins the ones that meet (see *Cutter geometry* below).
  A file that arranges its own shapes too close is loaded as it is — the layout belongs to the
  file, not to us — and `app.js › adoptOverlapFromDrawing()` switches the setting on for it when
  the file cannot state it itself (an SVG, an STL, a project written before the setting existed);
  `warnIfClashing()` then says what that means. A project file that does state it is taken at its
  word.
- **Adding shapes from a file** is `editor.addLayers(list)`: the entries are the ones `setState()`
  takes (a file's layers, seeds and all), or a plain `{ outer, inner }` for an SVG, which then
  starts from the wall settings of the shape you are on. The arrivals keep their own arrangement
  and are moved clear of the plate **as one group** (`_placeGroup()`, `_groupBox()`) — a sheet of
  four charms is added as that sheet, not as four shapes shuffled into the gaps — and only when
  they would land on top of something, so a file whose shapes sit somewhere else keeps the place it
  chose. `app.js › addState()` is what calls it: it forces `params.mirror` to the plate's, because
  mirror turns the whole plate over and is never per shape, and then reads the overlap setting off
  the drawing like any other file.
- Undo covers the whole plate. `_snapshot()` keeps every layer's contours, mirror and `symOrigin`,
  which layer was active and which wall — so adding and deleting a shape are undoable too. Wall
  settings have no undo of their own, so `_restore()` keeps the settings a still-existing layer
  has *now* (matched by `id`) and only restores those of a layer being brought back.
- `setLayer()` reports `onChange(..., { selectionOnly: true })`: stepping to another shape changes
  no solid, so app.js updates the panel and skips the rebuild.

### Shape model
- Points are `{ x, y }`, optionally with Bézier handles `in`/`out` (offsets from the anchor) and
  `smooth` (handles kept collinear). Only the Points tool creates handles. `flatten()` turns a
  control polygon into a polyline (cubic sampling ≤ 0.25 mm). Every transform must go through
  `mapPts()` so handles move with their anchors.
- **An unfinished outline** (`layer.open[wall]`) is a line of corners the Points tool is still
  placing: joined but not closed. `_displayOf()` gives it as `[]` — no fill, no wall bands, no
  size, nothing in `buildParts()`, so no solid and no STL — and `_renderDraft()` draws it as the
  dashed polyline it is, with its first point pulsing (`_closable()`, the one thing on this canvas
  that animates, so `_loop()` keeps painting while it is open). `closeContour()` is what a click
  on that first point does: `_down` arms `drag.closes` and `_up` fires it when the press never
  became a drag (more than 3 px — a real mouse click emits a pointermove, so `moved` alone is too
  strict). Everything that hands a whole contour in — a sketch, a starter shape, an import,
  `setPoints()`, `clear()` — closes it: `setShape()` takes an `open` option that defaults to shut.
  The overlap guard measures it as if it *were* closed (`_guardOutline()`), so the corner that
  would carry it across a neighbour is refused as it goes down, not when it is finally closed.
  The flag is never true in symmetry mode — a half is closed by its mirror lines, so there is
  nothing for the user to close, and `setSymmetry()` clears it (reading the half's raw points, not
  the empty display, so switching symmetry on mid-outline does not throw the corners away).
- **Symmetry mode** belongs to one shape and its mirror lines cross at that layer's own
  `symOrigin` (`sym.x` = left–right mirror line at x = symOrigin.x, editable side to the right;
  `sym.y` = top–bottom mirror line at y = symOrigin.y, editable side above). `symOrigin` is put in
  the middle of the shape when symmetry is switched on, and goes through every transform the shape
  goes through, so a symmetric cutter can sit anywhere on the plate. The stored contour is the
  user's half ("seed"). The effective contour = `symmetrize(closeViaAxes(flatten(seed)), sym,
  symOrigin)`: close the open half along the mirror lines (through symOrigin when both are on),
  clip to the region, mirror, union. Turning symmetry off bakes the full shape; turning it on clips
  the full shape to the region (`clipToRegion`, which rotates the ring so it starts/ends on the
  mirror line). In symmetry mode: no rotation handle, handles on the mirror side hidden, two-finger
  gestures disabled, strokes and corners clamped and magneted to the axis. Moving is *not*
  restricted — the mirror lines travel with the shape.
- **Inner wall**: `shape.inner` is a hole in the cut piece. Editing "Outer wall" transforms both
  contours; editing "Inner wall" transforms only the inner. The Inner wall tab is disabled until an
  outer wall exists. Validation: inner must be completely inside outer (`isInside`).
- `_displayOf(layer)` caches the effective shape on the layer, keyed on its `rev` **and** array
  identity — any code that replaces `this.shape` and then reads `_display()` before `_changed()`
  relies on the second half (a stale cache once produced NaN coordinates). An edit that moves a
  point **in place** changes neither, so `_allowed()` drops `layer._disp` before it measures.

### Cutter geometry (`buildCutter`)
Tiers from the bottom: base (width `baseWidth`, height `baseHeight`), optional support step
(`ridgeWidth`/`ridgeHeight`), blade (`bladeWidth`) up to `height`. Widths are measured outward
from the cut line for the outer wall and inward for the inner wall; widths must shrink going up
(the code clamps and merges equal tiers).

Defaults (user-specified, do not change without asking):
`height 15, bladeWidth 0.4, baseWidth 3, baseHeight 3, ridge on, ridgeWidth 0.8, ridgeHeight 7,
bridgeCount 4, bridgeWidth auto (= 10 % of the outer width rounded to 0.5 mm; typing a value
switches auto off), bridgeAngle 0, mirror off`.

The solid is built with **Manifold** (CSG kernel, WebAssembly). This replaced a hand-built stacked
mesh because slicers (Bambu Studio) reported open edges from T-junctions. The construction rules
that keep the result watertight — **preserve them**:
1. outer wall = union of prisms of *outward* offsets (each upper tier extends `OV = 0.02 mm`
   **down** into the wider tier below) **minus** a prism of the cut line (z −1 … H+1);
2. inner wall = prism of the inner line **minus** union of prisms of *inward* offsets (each lower,
   narrower hole tier extends `OV` **up** into the wider tier above);
3. connection bars are clipped to a region 0.05 mm *inside* the base rings so they overlap the
   walls instead of touching them; bars are added last;
4. every offset is fattened by `FAT = 0.005 mm` (outward: +FAT, inward: −(w−FAT)) so a
   self-touching offset outline overlaps rather than pinches, and every offset result goes
   through `simplify(0.001)` because rounded offsets can emit repeated vertices;
5. volumes may overlap or be apart; they must never merely touch face-to-face — that is the one
   configuration a CSG kernel cannot resolve into a single clean surface.
All Manifold objects are `delete()`d in a `finally` block (WASM memory is not garbage collected).
`loadManifold()` is async and called once at app start; `buildCutter` throws until it resolves.

`buildAll(parts)` builds a whole plate: one `cutterSolid()` per shape, then `overlapGroups()`
works out which of them run into each other and each group is unioned into a single Manifold
before its mesh is taken. Two cutters whose bases overlap are one piece of plastic, and laying
their triangles side by side would leave two surfaces crossing inside the print — the one thing a
slicer cannot make sense of — so the union is decided by the geometry, not by `allowOverlap`: a
plate that came in overlapping is built correctly whether the guard is up or down. The test is the
outer contour grown by that shape's base width plus `MERGE_TOUCH` (0.01 mm, so bases that merely
touch count), bounding boxes first and Clipper only for the pairs that survive it, so a plate where
nothing is near anything costs one `bounds()` per shape. `result.objects` is how many separate
solids came out; fewer than `result.parts.length` means some were joined, which is what the status
line and the download message say. The shapes keep their canvas coordinates, so the plate comes out
arranged the way it is drawn. A shape that will not build is named in the message (`Shape 2: …`) —
but only when there is more than one, or the name would be noise.

`buildCutter(shape, params)` is the same thing for one shape: `cutterSolid()` + `meshOf()`. All
Manifold objects go on a `trash` array the caller empties in a `finally`; anything that builds a
solid takes that array, so nothing leaks when a build throws halfway.

### Project files (`.cutter`)
`Save project` writes a zip (`js/zip.js`, stored, no compression) containing `project.json`,
`model.stl`, `preview-2d.png` and `preview-3d.png`. **Only `project.json` is read back** — the
mesh is rebuilt from it, which is what makes a reopened project identical; the STL and the two
pictures are there for the user's file browser and slicer.

`project.json` (schema 2) carries `shapes`: one entry per layer with its **seed** contours (with
Bézier handles — in symmetry mode the edited half, exactly as stored), its `sym`, its `symOrigin`,
all `DEFAULT_PARAMS`, its `open` flags (an outline left unfinished reopens unfinished, instead of
becoming a closed cutter nobody drew) and its `bridgeAuto` flag. Alongside it: which shape was active (`index`), the
active wall, the tool, smoothing, aspect lock, `allowOverlap`, grid size and snap, the file name
and a stats snapshot of the whole plate. Shapes that overlap are one object in the STL but are
still written one by one, so opening the file gives the shapes back and not the merged lump.
`allowOverlap` reads back as `null` when the file does not carry it at all — `app.js › applyState()`
then reads the answer off the drawing instead of assuming one. The view (zoom/pan) and guides are deliberately **not** saved — they
belong to the sitting, not the cutter. Params are merged over `DEFAULT_PARAMS`, so a file saved
before a new parameter existed still opens, and a **schema-1** file (one shape, parameters at the
top level) opens as a plate with one shape on it. `schema` is checked and a newer file is refused
with a sentence, not a stack trace.

Two ordering rules that will bite anyone who touches this:
1. `editor.setState()` must put the seeds in **without** `_toSeeds()` — running it on a seed clips
   a symmetric half a second time;
2. `applyState()` restores the shape first and the params second, because `onChange` runs
   `autoBridgeWidth()`, which would otherwise overwrite a saved manual connection thickness.

`viewer.snapshot()` renders one frame explicitly and reads the canvas back in the same task (the
renderer does not preserve its drawing buffer); `editor.renderPreview()` draws every shape and its
wall bands — no grid, guides, handles or dimensions, and nothing greyed out. Both may fail; the project then saves without
that picture rather than not at all.

### Reading an STL back (`js/stlimport.js`)
The inverse of `buildCutter`, for cutters made before there were project files. Nothing is guessed
from the triangles: every number is read off a horizontal section, which is exact because every
wall is a vertical prism.
- **the lumps**: `splitSolids()` puts triangles that share a corner in the same lump, so a plate
  of cutters that stand apart falls apart into its cutters. The one exception is folded back in: a
  cutter whose inner wall has no connection bars is two lumps that are one cutter, and a lump whose
  footprint sits inside another lump's belongs to it (cutters that stand apart never overlap in
  plan, so nesting can only mean that). Each lump then goes through `readSolid()` on its own, and
  `importSTL()` gathers every shape they yield into `parts`, biggest first;
- **the shapes in a lump**: a lump is usually one cutter, but shapes that were allowed to overlap
  were unioned into a single solid, so one lump can hold several cut lines. `regionsOf()` takes the
  voids of a section (depth 1) and treats any two no further apart than a blade as pieces of one
  region — `bridge`, the thinnest gap between a void and the outline around it, times `BLADE_SLACK`
  (1.35), measured off this very model. A void standing on its own is never touched, so a cut line
  that survived whole comes back to the micron. `readSolid()` then walks the tiers **downwards**,
  and a region no cutter found so far already covers (`sameRegion`, half of the smaller by area) is
  a cutter of its own whose height is the top of the tier it first appears in — which is what gives
  a shorter shape beside a taller one its own height, and what keeps the pockets between connection
  bars from being read as shapes;
- **blades that run through each other** cut the region they cross into pieces, and the pieces are
  not shapes. Which shape a wall between two pieces belongs to is *measured*, not guessed: a wall
  is a band, it stands on its cut line and grows away from it, so at a tier whose walls are a
  different width the cut-line edge is in exactly the same place (`SAME_EDGE`, 0.05 mm) and the
  other edge has moved by the difference between the two widths — millimetres. `cutSideOf()` reads
  that off `mateFaces()`, the same void seen at the other tier. Then the shape that wall belongs to
  is the whole region less the piece on the far side of the wall, wall and all:
  `subtractPolygons(U, offsetPolygon(farPiece, wallThickness))`, where `U` is the pieces closed up
  across their walls (`closeGaps`, radius one wall — tighter rounds the crossings more than the
  bridging gains). Two circles half over each other come back as two circles, to 0.09 mm at the
  two crossing points and exactly everywhere else. The reading is then checked before it is
  believed: every piece must end up inside one of the shapes and the shapes together must be the
  whole region, to 2 %. If it does not check out — or the solid has only one tier, so there is no
  second width to read the walls against — the pieces come back joined as the one outline around
  them, with a note, because inventing a wall per piece is the reading that is certainly wrong;
- **the tiers** are the z of the horizontal faces that carry real area (`MIN_FACE_AREA`, 0.5 mm²,
  merged within `LEVEL_MERGE` = 0.05 mm so the 0.02 mm tier overlap cannot show up as a level);
- **the section** at the middle of a tier is chained out of the triangle/plane segments
  (`sliceRings`) into contours with a nesting depth. Halfway up the blade, depth 1 is the cut line
  — exactly the polygon `buildCutter` was handed, because the blade body has a prism of that very
  polygon subtracted out of it — and depth 2 is the inner wall. Every wall face is two triangles,
  so each contour carries a seam point in the middle of each face; 0.001 mm of RDP takes those out
  (including the one at the start of the contour, which RDP is otherwise forced to keep);
- **the widths** are the distance from the cut line out to that tier's outer edge, less `FAT`.
  Read at the 2nd percentile of points taken evenly *along* the outline: an offset never runs
  closer than its width but does run wider (a notch pinches, a reflex corner spikes), and sampling
  at the corners instead would let a star answer with its notches. The outer edge is the smallest
  depth-0 contour *around that cut line* (`edgeAround`), not simply the biggest one in the section
  — on a merged lump they are not the same contour. Tiers that come back the same width are then
  merged, the way `buildCutter` merges them on the way out: a plate whose shapes are not all the
  same height puts a level through a wall that does not change there, and without that merge a
  shape's step lands at the wrong height;
- **the bars** are what is left of the base section inside the channel between the two cut lines,
  held back `CHANNEL_BACK` = 0.05 mm from both. Without that hold-back the boolean has to cut along
  an edge it already shares and leaves spikes on the bars, which throws their width off. Where the
  channel *starts*, though, is not something the cut lines can say: Cutter's own walls grow away
  from the cut piece, but plenty of cutters are built with a base flange that overhangs its cut
  line towards it, and that flange runs right round the channel and joins every bar into one ring.
  The **pockets** answer it — the voids of the base section that lie in the channel are exactly
  where the flange ends, so `flangeReach()` measures from the middle pocket to each cut line
  (`gapBetween`) and the channel is held back by that much more. On a Cutter-built model the
  pockets touch both cut lines, the reach is nil and nothing changes. A void is tested for
  pocket-hood at the vertex standing clearest of both cut lines (`inChannel`), because a pocket's
  own boundary runs along them and on the line itself inside and outside are a coin toss; other
  shapes' voids in a merged lump are ruled out by their bounding box first.
  Each bar's thickness is then the distance between its own two **sides** — the edges of the piece
  that lie on neither side of the channel (`ON_END` = 0.1 mm from either means it is an end, cut
  off by the channel, not a side), which are straight and parallel because a bar is a rectangle.
  The narrowest span of the whole piece (`narrowest()`, still the fallback when a channel is too
  shallow to have sides worth the name) is that same distance only while a bar is longer than it is
  thick: a 12 mm bar across a 9 mm channel answers with the channel. The bar's direction is that of
  its sides — not the direction of its centroid, which a degree of error turns into millimetres of
  width. Bars that differ are answered with the middle one, and of an even pair the thinner;
- **Mirror comes back off** and the drawing is the y-flip of the model. Both settings make the
  same solid out of mirrored drawings, so there is nothing in the file to tell them apart; off is
  the reading whose top view *is* this STL.
What cannot come back: Bézier handles (the file holds the flattened outline), symmetry (it holds
whole outlines, not halves) and which shapes a merged lump with crossing blades was made of. A
solid with no ring at the top is not a cutter: its silhouette is taken, the wall settings are left
alone and `outlineOnly` says so.
`app.js › openSTL()` feeds the result through the same `applyState()` a project uses, including
the footprint check — which here is a real verification, since the saved size is the STL's own.

### Reading an SVG (`js/svgimport.js`)
Every loop in the file is cleaned and sorted biggest first. A loop that lands inside an outline
already taken is a hole in it (the first one becomes that shape's inner wall, the rest are counted
and reported); a loop inside nothing starts a shape of its own. So a sheet of four charms comes in
as four cutters, arranged the way the file arranges them. The size dialog asks for the size of the
whole drawing and the shapes keep their places and their proportions inside it.

### Resolution / smoothing
- SVG import samples every 0.05 mm of the SVG's native size (max 6000 samples per element) and
  only de-duplicates (`cleanPolygon(…, 0.0005)`). Simplification happens **at the final size**
  with 0.002 mm tolerance (in `regenerate()`), never before scaling. Clipper offsets use
  arcTolerance 0.01 mm. This fixed angular prints from a small SVG scaled up ×3.5.
- `editor.smoothing` belongs to the pen alone: `finalizeSketch()` is its only reader, and that
  runs on pen-up of a stroke, which only the Draw tool can start. Its slider lives in the Canvas
  flyout and nowhere else, and `app.js › syncSmoothSection()` hides that section (and the rule
  under it) unless Draw is the tool in hand. If a second reader is ever added, that rule has to
  go — a setting that is only sometimes on screen must only sometimes matter.
- **Rounding a drawn shape is a mode**, not a button that fires: `beginRound()` takes a copy of
  the wall being edited, `setRound(0…1)` shows what that much rounding does to it, and
  `applyRound()` / `cancelRound()` close it. Every preview goes straight into `this.shape[wall]`
  **without being recorded**, and `applyRound()` puts the original back just long enough to
  `_record()` it — so sliding about costs no undo steps and the whole thing lands as one. Each
  preview is worked out from the copy taken at the start, never from the last preview, so the
  slider is a dial and not a ratchet. It opens at `roundAmountOf()` — the shape's current
  roundness read back off its handles — so it can be turned down as readily as up.
  `_dropRound()` is how everything that replaces the drawing (setLayer, setActive, setShape,
  setLayers, setState, undo, redo, setSymmetry) takes the preview back first; it restores by
  layer id, so it is safe even from code about to switch shapes. While the mode is open `_down()`
  returns at once — the canvas is showing a preview, not the drawing — and app.js disables the
  shape actions in the toolbar.
- **What rounding does** depends on the contour, not on the tool. A contour of at most
  `ROUND_ANCHORS` (48) anchors is the set of corners somebody placed, so `curveCorners()` curves
  each one where it stands — Bézier handles along the `next − prev` tangent, reaching
  `amount × ROUND_BULGE` (0.5) of the way to each neighbour — and the shape keeps its anchors.
  Anything longer is a traced outline with no corners to speak of, and its corners are cut back
  with Chaikin at `amount × CHAIKIN_CUT` (0.25 is the classic quarter); the cut depth is what
  makes that path move smoothly under a slider instead of jumping a whole pass at a time.
  Amount 0 is the shape as it was, in both.

### 2D preview rings
`app.js › ringsFor(shape, params, id, rev)` computes base/step/blade bands for outer and inner
walls and the connection bars (`bridgeShapes`, Clipper) for the canvas. The editor asks for them
once per layer (`_ringsFor`), so each shape's bands follow its own settings; the cache holds one
entry per layer, keyed on that layer's `rev` and its params.

## 4. UI behaviour that users rely on

- **The shapes list** (`#shapesPanel`, canvas top left, in `.canvas-tl`):
  one row per shape, drawn by `app.js › renderShapeList()` from `editor.layerList()` — a thumbnail
  taken from the outline itself, the name (`Shape 1`, `Shape 2`, … from the position in the list;
  shapes are not named), and a trash button that appears once there are two. Clicking a row makes
  that shape the one you draw on; the others stay on the canvas in grey (`otherLine`/`otherFill`/
  `otherBase`/`otherBlade`), are not hit-tested, and keep their wall bands so you can see how close
  they are. **+** adds a shape with the wall settings of the one you were on. The list folds away
  behind its header on a phone and follows the window width until you fold it by hand.
  The settings panel says whose settings it is showing (`#settingsScope`, hidden while there is
  only one shape); Size, Cutter walls and Inner wall are per shape, Export is for the whole plate.
  A row whose shape is not on the standard settings carries a small `.shape-flag` after its name —
  the same arrow the settings panel puts beside a number, and a marker only: it is `aria-hidden`
  and not a button, so a tap on it falls through to the row and switches to that shape, which is
  where the settings are. `syncShapeFlags()` sets it and the row's tooltip (which names the count),
  from `drawShapeList()` on a redraw and from `syncResetMarks()` on a keystroke — so it keeps up
  with typing without redrawing the thumbnails. It runs on every pointermove of a drag, so a row
  whose count has not changed (`row.dataset.off`) is left alone.
- **Settings that are off the default**: `RESET_FIELDS` in `app.js` is the list — every entry of
  `DEFAULT_PARAMS` except `mirror`, which turns over the whole plate rather than this shape and
  keeps its own confirmation under Export. `syncResetMarks()` shows a `.reset-mark` (`[data-reset=
  <key>]`, one per field label in `index.html`) beside each setting that differs and fills the row
  at the top of the panel (`#resetAllRow`, hidden when nothing differs). It is called from
  `syncParamInputs()` (shape switch, file opened), `onParamsChanged()` (anything typed) and
  `onShapeChange()` (an inner wall appearing brings the bar settings into scope).
  A setting counts only while it is **on screen and doing something**: `f.when()` drops the step
  sizes with the step switched off and the bar settings with no inner wall — the same rule as the
  smoothing slider, that a setting only sometimes shown must only sometimes matter.
  The bar thickness is the odd one: its default is not the 2 mm in `DEFAULT_PARAMS` but `auto`
  (10 % of the width), so `f.auto` reads `bridgeAuto` instead and resetting it turns auto back on.
  `offDefault(f, c)` takes a context rather than reading the active shape, because the shapes list
  asks the same question of shapes you are *not* on: `shapeCtx(layer, inner)` is its settings, its
  `bridgeAuto` and whether it has an inner wall — `inner` handed in because it is the effective
  contour, which `layerList()` already gives per shape. `activeCtx()` is the one for the shape in
  hand. One mark, one press, no dialog — the value is on screen. *Reset all* goes through
  `confirmReset()` (`#resetDialog`), which lists every setting it would change from → to, because
  wall settings have no undo and some of the sections may be folded away.
- **Allow overlap** (`#overlapBtn`, in `#shapesFoot`) is a pressed-state row at the foot of the
  shapes panel, under the list and behind a hairline — it is how the shapes on this plate are
  allowed to sit, so it belongs with them and not in the settings panel. `syncOverlapRow()` shows
  it only from the second shape onwards (one shape has nothing to run into) and folds it away with
  the list; `drawShapeList()` and `setShapesOpen()` both call it. `app.js › setOverlapAllowed()`
  is the one way in — the button, `applyState()` and `adoptOverlapFromDrawing()` all go through
  it — and it says what changed: turning it off while shapes already overlap moves nothing, so it
  says they stay one merged object until they are moved apart. The status line reads
  `2 shapes, 1 object · ready` when something was joined, and the download message says so too.
- **Canvas view**: `editor.view = { size, zoom, pan }`. `size` is mm across the shorter canvas
  edge at 100 % and is what `_autoFit()` sets; `zoom` (0.25–8) multiplies it; `pan` is the mm point
  at the canvas centre. `toPx`/`toMm` are the only places this is applied — never assume the origin
  is the canvas centre (`_renderGrid` derives it from `toPx({x:0,y:0})`). `_autoFit()` is a no-op
  once the user has zoomed or panned. Pan mode routes pointer drags to the view and suppresses the
  shape-reshaping two-finger gesture, replacing it with a view pinch. The right mouse button pans
  from anywhere; a right *click* that never moves more than 3 px still opens the point menu, so both
  gestures share the button. `view.manual` (not a pan/zoom comparison) is what suppresses `_autoFit`.
  Zoom without an anchor re-centres on the shape's bbox; only the wheel and pinch anchor on a point.
- Tools: **Draw** (freehand), **Points** (tap to place the next corner, on the canvas or on the
  outline itself, or hold and pull to place a curved one; click the first corner again to close
  the shape; once closed, a tap on the canvas or inside the shape only deselects; drag, double-tap
  or Delete key or bar/menu to delete, right-click / long-press for menu, Bézier handles with
  *Sync handles*), **Move & resize** (drag, corner/edge handles, rotate knob with 15° snap,
  two-finger pinch/twist). Keyboard 1/2/3 switch tools, O/I switch wall, Ctrl+Z/Y undo/redo, Esc.
- In the Move tool, a resize anchors on the corner or edge opposite the handle; Alt / Option
  anchors it on the middle of the shape as it was when the drag started, so every side moves
  and the shape keeps its place. A mirrored axis is left out of that: there `_editBounds()`
  clamps the box to the editable half, so its middle is meaningless, and the anchor is already
  the mirror line — which for a symmetric shape *is* growing both ways from the middle.
  Shift still frees the proportions on top of it.
- In the Move tool, Shift while dragging keeps the shape on one line through where the drag
  started — whichever way it has travelled further is the way it may go, and the snap to guides
  and the grid is dropped in the frozen direction so it cannot break the lock. The arrow keys
  nudge the shape by 1 mm, 5 mm with Shift (`editor.nudgeShape`), through the same
  `_applyTransform` a drag uses: the inner wall comes along in outer mode, the mirror origin
  travels with it, and a step into another shape is simply not taken.
- The position bar (`#shapeBar`) is the Move tool's answer to the point bar and shares its
  markup and its corner: `editor.shapePos` (the middle of the wall being edited — the box the
  handles are drawn on) as number inputs, written back with `editor.moveShapeTo`.
  `app.js › updateShapeBar()` shows it whenever the Move tool is holding a contour and names
  whose position it is (`Shape 2`, or `Inner wall`); it is refreshed from `onShapeChange`, so
  the numbers run along with a drag. On a phone the shape's name goes on a line of its own, or
  the bar would sit on top of the folded shapes list.
- **Picking a shape up and putting it down** is the Move tool's other half of the shapes list.
  `editor.picked` says whether the tool is holding the shape being edited. A click on empty
  canvas puts it down (`dropShape()`): the box, its handles and the position bar go, the arrow
  keys stop nudging and the two-finger gesture stops reshaping — but it stays the shape the
  settings panel is showing, the one the shapes list marks and the one the other tools draw on;
  only the Move tool has let go. Escape does the same. A click on any shape picks that one up
  (`pickShape()` → `setLayer()` when it is another one), and while the outer wall is the one
  being edited the same press goes on to move it, so laying out a plate is one gesture per shape.
  `_layerAt(mm)` is the hit test: outlines only (an unfinished one is not a shape yet), the shape
  being edited first because it is drawn on top, then the others topmost first. A hit on the
  shape already in hand is a no-op rather than a release — in inner-wall mode you can be over the
  shape without being over the wall you are moving. `editor.hot` is the shape under the pointer,
  drawn by `_renderOther()` in the `hot*` colours: a step from the grey towards the shape you are
  editing, so you can see what a click would pick up. `_hoverAt()` keeps both the cursor and the
  highlight; a press and the pointer leaving the canvas clear it. Anything that changes which
  shape is being edited — the list, **+**, a delete, undo, a file, switching tools — hands the new
  one over held, so the tool is never left grasping at nothing.
  The undo step for a move is taken when the shape first travels (`drag.rec`), not when the button
  goes down, and `_up` leaves a press that never moved alone: picking a shape up is not an edit,
  so it costs no undo step and nothing is built again.
- **Placing a corner and pulling** (`drag.kind === 'pen'`) is the pen gesture: the anchor stays
  where it was put and the drag sets `out` with `in` its exact opposite and `smooth: true`, so the
  two handles are equal and opposite rather than merely collinear (`_mirrorHandle` keeps the other
  handle's length, which is right for adjusting one later but wrong for drawing one now). It only
  starts once the pointer has travelled `PEN_PULL` (3 px) **from where the button went down on the
  screen**, not on the canvas: placing the first corner brings the shape actions into the toolbar,
  and a canvas that shifts under a still pointer must never be read as a drag. A press that never
  travels leaves a plain sharp corner, and the whole gesture is one undo step (the `_record()` at
  placement). Both ways of placing a corner take it — on the canvas and on the outline itself —
  because it is the same act: a corner has just appeared and this is the moment its curve is
  drawn. Dragging a corner that was already there still moves it; the pen drag belongs to the
  instant of placing, not to the point.
- In the Points tool, Shift while dragging constrains: a vertex to the horizontal or vertical
  line through where its drag started (`drag.p0`), a Bézier handle to a multiple of 45°
  (`snapAngle45`). The grid magnet applies to both (a handle snaps its *tip*, not its offset).
  A handle is the one thing allowed out of the editable half in symmetry mode
  (`_snapPoint(…, { clamp: false })`) — the curve it shapes is clipped to the region anyway.
  The arrow keys nudge the selected point by 1 mm, 5 mm with Shift (`editor.nudgePoint`).
- The point bar (`#pointBar`) carries the point's exact position and, when it is curved, both
  handle offsets, as number inputs (`editor.movePoint` / `editor.setHandle`). They are refreshed
  from `onSelect` on every change, so `setField` never overwrites the box that has focus, and the
  inputs stop keydown from reaching the canvas shortcuts.
- The tool explanation (`#toolTip`) lives in the toolbar, immediately after the Draw / Points /
  Move group, so it sits with the tools it explains. It never shows itself: picking a tool only
  loads the sentence (`setToolTipText()`), and it stays behind its (i) (`.tool-tip.collapsed`
  clips the text with `clip-path`, so the words never reflow mid-slide). Hovering the (i) brings
  it out, leaving it puts it back; on touch a tap opens it (`showToolTip()`, which times out
  after `TOOL_TIP_HOLD` because a tap has no pointerleave) and selecting a point folds it away.
  The text itself is `position: fixed` and placed under the icon by `app.js › placeToolTip()` —
  clamped to the window, so it never pushes the toolbar about and never runs off the side of a
  phone; `setToolTipText()` re-places it when the text changes under an open tip, and
  `followToolTip` keeps it under the icon on resize and scroll.
- Cursors are state-dependent (`_hover()` in the editor): default/move/resize per handle/rotate
  cursor in Move mode; pointer over points, move while dragging, copy over lines, crosshair to add.
- **Which wall an action applies to** is decided by `editor.active`, and `app.js › syncWallActions()`
  keeps the buttons and their tooltips in step: Clear (`editor.clear`) and Flip (`editor.flip`)
  act on both contours of the active shape in outer mode and on its inner contour alone in inner
  mode (both go through `_affected()`); Center moves the *whole drawing*, every shape together, so
  they keep their places relative to each other and cannot collide; it is disabled in inner mode,
  where the Align control (`editor.alignInner(h, v)`, nine bbox spots) takes over. Switching a mirror on or off asks for
  confirmation once something is drawn, because it reshapes the drawing. Center, Align, both
  Flips and Clear are hidden/disabled until the wall being edited actually has a contour, so an
  empty canvas offers nothing that would do nothing; all of them are disabled while the rounding
  tool is open, because what the canvas is showing then is a preview and not yet the drawing.
- Snapping: grid (size selector 1–20 mm, Snap toggle, at the canvas' bottom left next to the
  scale bar), guides (vertical/horizontal, draggable tabs
  at the canvas edge, double-tap tab to remove), mirror lines. Magnet distance `SNAP_PX = 10`.
  Freehand strokes are deliberately **not** grid-snapped (would make them jagged).
- **Starter shapes** open a grid of previews (`#presetBtn` → `#presetMenu`): two columns on a
  phone, three, four and five as the window gets wider (`--cols` / `--tile` per breakpoint in
  `styles.css`), one tile per shape. Picking one opens `#presetDialog`, which asks for the size
  before anything lands on the canvas — prefilled at `PRESET_SIZE_MM` (30 mm) on the longest side,
  or at half the outer wall when the inner wall is the one being edited. Its width/height boxes
  share `linkSizeFields()` with the SVG import dialog. `app.js` builds the tiles from `PRESETS[key].make()` itself — the same anchors
  the editor is handed, turned into an SVG path — so a preview can never drift from the outline it
  inserts; adding a preset needs no picture. The grid is `position: fixed` and placed by
  `placePresetMenu()`, because `.pane-draw` clips what overflows it and on a phone the grid is
  taller than the pane; it flips above the button when there is more room there. The button's own
  tooltip is taken away while the grid is open, or it would cover it. The shapes themselves are
  drawn at roughly 70 mm in `presets.js` and scaled by `insertPreset()`; do not re-cut the
  coordinates to 30 mm, or the fits noted with the heart, the flower and the gingerbread man
  stop meaning anything.
- **Import** (`#svgInput`) takes an SVG *or* an STL; **Open project** (`#projectInput`) takes a
  `.cutter` *or* an STL; dragging a file onto the window takes any of the three. All of them hand
  the file to `app.js › beginImport()`, which branches on the name (`isSTL` / `isSVG` /
  `isProject`) and is the only way in — `importing` and any open dialog (`busyImporting()`) keep a
  second file from starting while the first is still being answered. Either picker may bring in
  several shapes, and each becomes a layer of its own. Both doors are meant: one is "bring a file
  onto the canvas", the other is "open the cutter I made earlier", and an STL is honestly both.
- **The drop layer** (`#dropLayer`, with `#dropZone` inside it) comes up while a file is over the
  window. It is at body level, not in `.canvas-wrap`, because that is a size container and would
  catch a `position: fixed` child; `placeDropZone()` puts the zone over the canvas' rect — clipped
  to what is on screen, and falling back to the whole window when the canvas panel is off or the
  page is scrolled past it — and it is re-measured on every `dragover`, because a drag near the
  edge scrolls the page under it. What says the file has left is a timer that `dragover` keeps
  pushing back (`DROP_LINGER`), not a dragenter/dragleave count, which gets it wrong the moment an
  element boundary is crossed mid-drag. The drop is swallowed (`preventDefault`) **everywhere on
  the window and in every state**, including while a dialog or the loader is up: letting the
  browser have the file means opening it in this tab, which throws the drawing away without
  asking. The layer itself is only offered when the file can actually land.
- **The import question** (`#importDialog`, `app.js › askImportMode()`) is what a file arriving on
  a plate that is not empty is answered with: add / replace / cancel. An empty canvas is not asked
  — there is nothing to keep — and neither is an SVG of one plain outline dropped while the inner
  wall is the one being edited, which is that wall. All three buttons are `type="submit"` with a
  `value`, and the answer is read off the **submit** event (`e.submitter.value`), the way
  `confirmAction()` does: a `close` that has to fire for the answer to arrive is one event too
  many between the press and the result. `close` is left for Esc and the backdrop.
  Replacing goes through `applyState()` as before; adding goes through `addState()` → 
  `editor.addLayers()`.
- **The loader** (`#loader`, `showLoader()` / `withLoader()`) covers the window while a file is
  read and while the solid is built — both are main-thread work of a few seconds on a big drawing.
  Putting it up is awaited, because a veil that is not painted before the work starts announces
  nothing; the wait is two frames **raced against a 60 ms timer**, since a tab in the background is
  never painted and never gets a frame either, and an import must not be able to hang on the user
  having looked away. `withLoader(..., { build: true })` pulls the rebuild out of its 120 ms
  debounce and does it inside the same veil, so the app is not left looking finished while it is
  still building.
  Opening a file asks the question when something is drawn, clears undo (replace only) and
  replaces the settings, exactly like opening a project.
- An SVG import opens a size dialog prefilled with the physical size (mm/cm/in units) or 80 mm wide;
  proportion lock; only then is the drawing imported, at that size as a whole. A hole becomes that
  shape's inner wall; a separate outline becomes a shape of its own.
- Size inputs edit the cut piece (outer wall) size of the shape you are editing; the cutter is
  bigger by the base.
- File name defaults to `cutter-xxxxx` (random 5-char hash per page load).
- While an outline is being placed the hint (`#drawHint`) says so and takes precedence over every
  other message: "keep placing corners" until there are three, then "click the first point to
  close the shape". `updateHint()` reads `editor.draft`, so it follows the tool and the wall as
  well as the drawing.
- Empty-state hint centred; the inner-wall hint sits bottom-centre, 56 px up (`.hint.corner`), clear
  of the scale bar and the zoom / pan controls; it fades out while the zoom menu is open.
- The canvas' bottom left holds the grid control (scale bar + size + Snap); the bottom right holds the zoom / pan controls (`.canvas-view`, menu opens upwards); the top
  right belongs to the point bar and the canvas setup flyout. Don't put anything else in either corner.
- **The rounding tool** is `#roundToolBtn` (icon only, the wave, immediately left of *Canvas*)
  and `#roundBar` at the bottom centre of the canvas — slider, Apply, Cancel. `syncRoundBar()`
  drives both from `editor.rounding` and `editor.canRound`; the button is disabled while the wall
  being edited has no contour. The slider takes focus when the mode opens, so Enter and Esc are
  answered on the slider itself (the canvas shortcuts stay out of a focused input) as well as on
  the document; its arrow keys are the range's own and nudge the rounding live.
- `.canvas-wrap` and `.pane-draw` are **named size containers** (`canvas` / `drawpane`), because
  how much room they have depends on which panels are switched on and not on the window. Below
  560 px of canvas the bar drops its name and the buttons their words; below 560 px of pane the
  sub-toolbar drops the *Editing* label and the word *Canvas*, and below 440 px the wall names —
  and it may wrap rather than clip a button off the end. `.with-smooth` on `.canvas-wrap` pushes
  both hints up while the bar is there. Nothing inside either container is `position: fixed`,
  which is the one thing a container would otherwise catch.
- **Which panels are on screen** is switched in the header (`.segmented.panels`, one button per
  panel). `app.js › syncPanels()` sets `hidden` on the pane and a `panes-no-*` class on `<body>`;
  the grid template for every combination lives with the breakpoints in `styles.css`, so a switched
  off panel gives its width to the ones that are left. The canvas and the 3D preview are the two
  panels that show the cutter, so one of them always stays: the switch of the last one left is
  disabled (and says why) rather than quietly doing nothing. All three are on at every page load;
  the state is not saved, in a project or anywhere else.
- 3D: always the whole plate — every shape, in its place, built from its own settings; nothing is
  greyed out or left out, because this is what comes off the printer. Fit / Top / Back buttons; smooth shading with a 32° threshold (`smoothNormals` in viewer);
  the camera refits only when the size changes a lot. `fit()` measures the viewport first (the
  distance follows the aspect ratio) and, when the panel is switched off and there is nothing to
  measure, defers itself to the next `_resize()` — otherwise a cutter built while the preview was
  hidden would come back framed for a 1:1 viewport.
- **Cut piece popup** (`#resultDialog`, *Cut piece* next to the 3D view buttons, enabled once any
  shape has an outer wall): every piece the plate leaves behind, in the places they sit in, drawn
  straight onto a canvas by `app.js › renderResult()` — the cut line filled, the inner wall punched out (`evenodd`), a second
  copy pushed down behind it for the cut edge, and a blurred fat stroke clipped to the pieces for
  the rollover. Where two shapes run into each other `pieceRings()` joins their outlines first
  (Clipper union, then the holes subtracted) — the even-odd fill would otherwise punch the overlap
  out and draw a hole where the clay is one piece — while the strokes still follow every shape's
  own outline, because every blade leaves an edge and that is where the clay comes apart.
  Nothing is handed to Clipper unless two outlines' boxes actually meet. It shows the face that
  meets the clay: `x` turns over unless `params.mirror` is on
  — left–right, never top–bottom, which would only read as "upside down". `mirrorMatters()` decides
  whether the sentence about mirroring and the *Match my drawing* toggle are shown at all: with
  more than one shape it always matters (the plate turns over, so the shapes swap sides), and with
  one it is a Clipper union against that shape's own mirror image about either bbox axis, 2 %
  tolerance, short-circuited in symmetry mode; that
  toggle and the *Mirror* checkbox under Export are one setting, both going through `setMirror()`.
  The clay colour (swatches + `<input type="color">`) is session state, not part of the cutter.
  The canvas follows its stage through a `ResizeObserver` — measuring it when the dialog opens is
  too early, the box has no size yet.

## 5. Conventions

- Plain ES modules, no framework, no bundler, no TypeScript. Keep it that way unless the owner asks.
- 2-space indent, single quotes, semicolons, ~120-char lines; small comments that explain *why*.
- Keep runtime dependencies vendored under `vendor/`; never load from a CDN (the app must work
  offline and on locked-down networks). Google Fonts is the one external request and is optional.
- All measurements in millimetres. Tolerances in `geometry.js` are named constants with comments —
  change them only with a test that shows why.
- IDs in `index.html` are the contract with `app.js`; renaming one means updating both.
- Design: neutral bench background, white canvas with mm grid, one accent blue, dough-yellow cut
  piece, purple Bézier handles, orange guides. On the canvas the three things you can grab have
  three shapes: a corner is a square, a corner with curves on it a circle, and the tip of a Bézier
  handle a small diamond (`HANDLE_TIP`) — smaller than both, because it is the thing you nudge and
  not a point the outline runs through. The drawn size is not the hit radius: `HIT_R` stays 20 px
  so a handle is still easy to catch with a finger. No headers/eyebrows/all-caps labels. Buttons ≥ 32 px
  tall (touch). Don't add icon fonts; inline SVG only.
- Never announce implementation details in the UI ("per my guidelines", library names, etc.).

## 6. Things that were decided and should not be silently reverted

| Decision | Reason |
|---|---|
| Mirror off by default; Top view = drawing | user found the previous inverted behaviour illogical |
| Manifold CSG instead of hand-built mesh | open edges in Bambu Studio; welding approach kept hitting micron degeneracies |
| Sampling/cleaning at final size | angular prints from scaled-up SVGs |
| Bars end 0.05 mm inside rings; tiers overlap 0.02 mm; FAT 0.005 mm | prevents face-touching CSG degeneracies |
| Seed-based symmetry closed along the axes | Points tool must work naturally on one half |
| Auto connection thickness = 10 % of width, 0.5 mm steps | user request |
| No "cookie" wording; "Back" button | user request |
| No grid-snap on freehand strokes | jagged results |
| Zoom is a multiplier on the auto-fitted size, not an absolute mm scale | 100 % should always mean "the whole shape fits", whatever its size |
| Panning moves the view only, never the shape | the canvas already has a Move tool; a pan that edited the drawing would be undoable-but-surprising |
| Menu/keyboard zoom re-centres on the shape; wheel and pinch anchor on the pointer | user request: pressing zoom in must never leave the shape off screen, while direct manipulation still needs to target a spot |
| Clear / Flip follow the edited wall; Center is outer-only and Align is inner-only | the canvas buttons used to act on a mix of view, canvas and outer wall; one rule now decides |
| Mirror on/off asks for confirmation once a shape exists | it replaces half the drawing, which is not what an unlabelled toggle suggests |
| Grid size and Snap sit at the canvas' bottom left, not in the Canvas flyout | they belong to the canvas you are looking at, and they replace the scale bar that stood there |
| The tool explanation only appears on hover; it is never shown on load or on a tool switch | it is a reminder you ask for, not an announcement. It used to read itself out for 5 s after every switch, which put a paragraph over the canvas each time you reached for a tool you already knew how to use — and on load, before there was anything to explain. The (i) is where it lives; hovering it is how you ask |
| The (i) sits in the toolbar beside the three tools, not on the canvas | it belongs to the tool it explains, and the canvas' top left belongs to the shapes list. Its text floats under it rather than sitting in the toolbar, or opening it would shove Import and Starter shapes sideways |
| `.cutter` is a zip with the STL and two PNGs inside, but only `project.json` is read back | one file to keep and to hand around; rebuilding from the settings is what guarantees the same cutter, where a stored mesh would silently freeze old geometry |
| The canvas view (zoom/pan) and guides are not saved | they are scaffolding for drawing, not part of the cutter; restoring them would fight `_autoFit` on open |
| Opening a project asks for confirmation when something is drawn, and clears undo | it replaces the whole drawing, and an undo across two different projects would be nonsense |
| Shift constrains a point to H/V and a handle to 45° steps; arrow keys step 1 mm | the mouse alone cannot place a point on a straight line or an exact millimetre, and the grid is often the wrong size for it |
| Alt anchors a resize on the middle of the shape, but never on a mirrored axis | a cutter drawn to sit in a place should grow without leaving it, and the opposite-corner anchor always shoves it sideways. On a mirrored axis the box on screen is only half the shape, so its middle is a point the user cannot see and does not mean; the mirror line is the real middle there, and the plain resize already anchors on it |
| The Move tool gets the same three: Shift locks the drag to one axis, the arrow keys nudge, and a bar shows where the shape sits | placing a whole cutter is the same job as placing a corner, and it was the one that could only be done by eye. A plate of shapes is laid out to a measurement — 10 mm apart, level with each other — and dragging until it looks right does not hit that |
| The position bar reads the middle of the shape, not a corner of it | it is the point the move handles are drawn around and the point rotation turns about, so it is the one the shape is already understood to sit on. A corner would change meaning the moment the shape was rotated |
| The point bar shows position and handle offsets as editable numbers | a cutter is often drawn to a measurement; reading it off the canvas and dragging until it looks right is not a way to hit 12.5 mm |
| The cut piece is shown mirrored left–right, never turned upside down | with the mirror off the piece really is a mirror image of the drawing, and that is what catches people out with letters — but flipping it top–bottom reads as "upside down" instead. Both flips are the same piece turned round on the table, so the sideways one is the honest picture: it shows the mirroring and nothing else |
| The mirroring sentence is withheld for a shape that is its own mirror image | both settings then give the same piece, turned round, and a warning about nothing is noise |
| The clay colour is session state: not saved, not in `project.json` | it belongs to the sitting, like the canvas view; the cutter is the same object whatever colour clay goes into it |
| Starter shapes are built from anchors with Bézier handles, not sampled polylines | inserting one used to drop 100–180 points on the canvas, which the Points tool could not sensibly edit; a circle is four points now. They go into the editor uncleaned — `cleanPolygon()` would flatten every curve straight back into a polyline |
| The shapes themselves did not change: each is a fit of the outline it replaces | the heart and the flower are least-squares fits of their old formulas (worst gap 0.14 / 0.18 mm) and the gingerbread man is his old arcs written as two cubics each (0.04 mm). Anyone re-cutting a preset must keep it on the old outline — check it against `git show` of this file before and after |
| Each of the three panels can be switched off, but never both views at once | the whole width for the drawing, or for the cutter, is the point; settings only are three panels' worth of numbers with nothing to look at. The last view left is disabled instead of refusing on click, so the reason is there before you press it |
| The panels are all on at every page load and the state is never saved | like the canvas view, it is how you are sitting at the moment, not what the cutter is; and a project that opened with two panels missing would look broken |
| Starter shapes are picked from a grid of previews, not a drop-down | a list of names cannot show what you are about to insert, and the shapes are the whole point of the control. The tiles are drawn from the preset data, never from stored pictures |
| Starter shapes are drawn at ~70 mm and inserted at 30 mm through a size dialog | a cutter for earrings is the common case and 70 mm of circle is nobody's starting point. Asking first costs one keystroke (Enter) and saves a resize every time; the coordinates stay where the fitted outlines were measured |
| The grid of shapes is two columns on a phone and never more than five | two is what a thumb can hit; past five the tiles are too small to tell a shape from its neighbour, and the grid reads as a list instead of a picture |
| No starter shape comes to a point sharper than about 50°, the moon's horns excepted | a 33° teardrop tip is a sliver of clay that tears off the cut piece, and no 0.4 mm blade holds it. A moon without horns is not a moon, and at 35° it is no sharper than the gingerbread man's arms, which have always printed |
| `arcPts()` takes a signed handle length, so an arc can be walked backwards | the moon's bite and the rainbow's inner edge are arcs that curve the other way; with `Math.abs()` their tangents pointed the wrong way and the outline folded over itself |
| An STL opens as a whole cutter, not just an outline | the numbers are all in the model and measuring them is no harder than measuring the outline; handing back a shape with today's wall settings would quietly change a cutter someone had already printed |
| An imported STL comes back with Mirror off | both settings make the same solid out of mirrored drawings, so the file cannot say which was used. Off is the one whose top view is the STL you opened, which is what you are looking at |
| Where the channel between the two cut lines starts is read off the pockets, not assumed | Cutter's walls grow away from the cut piece, so its own channel starts at the cut lines. Half the cutters in the world are not built that way: a base flange that overhangs its cut line runs right round the channel and welds every connection into one ring, which used to come back as a single bar as wide as the whole shape at whatever angle a convex hull happened to answer with. The pockets are the one thing in the file that says where a flange ends, and on a Cutter-built model they touch the cut lines and change nothing |
| A bar's thickness is the distance between its own two sides, not the narrowest span of the piece | the two are the same only while a bar is longer than it is thick. A ring 8 mm across the channel with 12 mm connections in it is an ordinary earring cutter, and the narrowest way across such a bar is the channel, not the bar — it came back as 8.7 mm. The sides are the edges lying on neither side of the channel, they are straight and parallel because a bar is a rectangle, and the distance between them is the thickness it was given whatever its shape |
| Bars that are not all the same thickness are answered with the thinner of an even pair | Cutter makes them all the same, so one of them has to speak for the rest, and the thinner is the one that still fits the channel wherever the other would. The note already says they differed |
| The STL importer measures; it never fits or guesses | a cutter is prisms, so a section is the answer, not an estimate. Anything that reads like a guess (a tolerance, a percentile, a hold-back) is there to keep a boolean or an offset honest, and is named with the reason |
| A merged lump is read as the cut lines in it, not as one shape | shapes that overlap are one object in the STL, and reading only the biggest hole in it threw the rest of the plate away without a word. Where the blades stand clear of each other every cut line is still whole, and the plate comes back to the micron: same shapes, same places, same walls, same heights |
| Which shape a wall belongs to is read off a second tier, not guessed | a wall is a band: it stands on its cut line and grows away from it. So the cut-line edge of a wall is in the same place at every tier and the other edge moves by the difference between the two wall widths — 2.6 mm between a 0.4 mm blade and a 3 mm base, which no tolerance can blur. That one measurement is what takes a plate of shapes whose blades cross back apart into the shapes: two circles half over each other come back as two circles, and the plate rebuilds to the solid it was read from within 0.02 % |
| …and the reading is checked before it is believed | every piece has to end up inside one of the shapes, and the shapes together have to be the whole region. A decomposition that does not account for what is in the file is not a reading, it is a guess — and the fallback (the pieces joined into the outline around them, with a note) is honest where a wrong shape would not be. A solid of a single tier has no second width to read the walls against and takes that fallback too |
| The wall widths of a shape in a merged lump are measured against the outline *around that shape* | the biggest contour in a section is the silhouette of the whole lump, which for a shape buried between its neighbours is nowhere near its own wall. Reading it that way made a 0.4 mm blade come back as 0.76 and a 3 mm base as 4.23 |
| A drawing is a plate of shapes, not one shape | one cutter per print is a poor use of a bed, and a set of shapes usually belongs together. Every shape is a cutter in its own right: its own size, walls, step and connections. Only Export is shared, because there is one file |
| Shapes may not touch by default, and the guard is measured in base widths plus 0.4 mm | two cutters whose bases overlap come off the printer as one piece. The gap is a nozzle width, which is what a slicer needs to see two objects. The rule is enforced where the shape moves — a drag stops against its neighbour instead of refusing after the fact |
| …but one switch lowers the guard for the whole plate | shapes that share an edge are a real cutter: two hearts joined at a lobe, a word whose letters lean on each other, a charm hanging off a ring. Refusing every one of them to protect the ones that were an accident is the wrong trade, and the default keeps the accident from happening silently. One switch, not one per shape, because half a plate overlapping is not a thing you can print |
| The switch is a row under the shapes list, not a checkbox in the settings panel | it is a rule about how these shapes may sit next to each other, which is the shapes list's whole subject — and it is answered while you are dragging a shape into its neighbour, with your eyes on the canvas, not while you are filling in an export form. It appears with the second shape and folds away with the list, because a plate of one has nothing to run into |
| Shapes that overlap are unioned into one solid, and that is decided by the geometry, not by the switch | two closed surfaces crossing inside a print is the one thing a slicer cannot resolve; a union is a single watertight object it can simply print. Tying the merge to the switch would mean turning it back off silently broke the STL, and a plate imported from a file could never be built correctly at all. The switch governs the guard; the shapes govern the mesh |
| Turning the switch off moves nothing | it is the same rule as a file's layout: the drawing is the user's. Off means the *next* drag stops against its neighbour; what already overlaps stays where it was put, still built as one object, and the toast says so |
| A file whose shapes already overlap switches the setting on by itself | an SVG sheet or an STL plate says where its shapes go, and nothing is moved to suit us. The only thing left that can be wrong is the setting, so the drawing decides it. A project file that states the setting is taken at its word instead — that one is not a guess, it is what the user saved |
| The project file keeps overlapping shapes apart, one entry each | the merge belongs to the mesh, not to the drawing. Saving the lump would take the shapes away for good; saving the shapes means reopening the file gives back the two hearts, each still with its own size, walls and settings |
| The cut piece popup joins overlapping pieces but still draws every blade | an even-odd fill over two overlapping outlines punches the overlap out, which draws a hole exactly where the clay is thickest. Joining them fixes the silhouette; keeping the individual outlines as strokes is what shows that the clay is cut into several pieces along the shared line, which is what really happens |
| A stroke drawn on top of another shape is refused; a shape *handed* to the canvas is moved aside | a sketch belongs where the pen put it, and shuffling it elsewhere is the bigger surprise. A starter shape or an import has no such place yet — its size was settled in a dialog, so it is put beside the others rather than thrown away |
| A file's own layout is never corrected, only reported (the setting gives way instead) | an SVG or an STL says where its shapes go; moving them would rearrange someone's sheet. If they are too close to print apart, `warnIfClashing()` says which ones |
| Shapes are named by their place in the list, and cannot be renamed | the thumbnail is what tells two shapes apart; a name is one more thing to fill in, and "Shape 2" is never wrong |
| Wall settings are per shape, but Mirror is not | mirroring turns the whole plate over — half a plate mirrored is not a thing you can print. It lives under Export with the file name for that reason |
| A new shape starts with the wall settings of the one you were on | height and blade are usually meant for the whole plate; copying them once saves typing them again, and each shape still owns its own from then on |
| Undo covers adding and deleting shapes, but never wall settings | the settings have no undo of their own, so restoring them behind a shape edit would take back a number the user had just typed. A layer coming back from the dead is the exception: its settings would otherwise be gone for good |
| Symmetry mirrors a shape about its own centre, not about the canvas origin | with several shapes on a plate, only one of them could ever sit on the origin. The mirror lines travel with the shape, which is also why a symmetric shape can now be moved — it used to be pinned to the axis |
| Center moves every shape together | centring one shape of several would move it into its neighbours. Moving the arrangement keeps the shapes where they are relative to each other and can never collide |
| The Points tool does not close a shape for you; you close it by clicking the first point | three corners are not a cutter, they are three corners. Closing on the third one meant every outline began life as a triangle in the 3D preview, and the only way to draw a square was to draw a triangle first and then correct it. The first point pulses and the canvas says what to do, because a rule nobody can see is worse than the wrong rule |
| While an outline is open there is no shape at all: no fill, no bands, no size, no solid | it is a line of corners, and showing it as a cutter is the thing that was wrong. It also gives the rule its own edge — the 3D preview filling in *is* the shape being made |
| A closed outline takes new corners only on its own lines; a click beside or inside it deselects | once the shape exists, a click on the canvas almost never means "grow the outline by one corner out there" — it means "I am done with this point". Corners go where you can see they will go, on the line, where the cursor already turns into a + |
| The closing click tolerates 3 px of movement, and a real drag of that point still moves it | a mouse emits a pointermove between press and release, so "did not move at all" would never close anything. Past the threshold it is a drag, and the first point has to stay draggable like every other |
| A mirrored half is never an open outline | its mirror lines close it; there is no first point to click, and the two ends belong on the axes. Symmetry mode keeps taking corners the way it always did |
| Rounding is a mode with a live preview, Apply and Cancel — not a slider plus a button that fires | a number between 0 and 1 means nothing until you see what it does to your shape. Pressing a button and reading the result off the canvas afterwards makes you undo to compare, and a slider that only takes effect on the next press is a slider nobody trusts. Seeing it bend under your finger is the whole answer |
| The preview is never recorded; the whole thing is one undo step | sliding from 0.1 to 0.9 and back is one decision, not eighty. Recording each step would bury the drawing under the dial |
| The slider opens at how round the shape already is | it is a dial you can turn both ways: down to sharp corners as readily as up. Opening at 0 would say the shape is sharp when it is not, and opening at a remembered number would bend it the moment you pressed the button |
| While the mode is open the canvas and the shape actions are off | what is on the canvas is a preview of a shape that has not been decided yet. Letting a corner be dragged into it, or Clear be pressed, would leave behind a drawing nobody chose |
| Sketch smoothing stays in the Canvas flyout, with nothing to do with rounding | it belongs to the pen — what a stroke is cleaned up by when you lift it — and that is a setting you leave alone for a session. Rounding a shape you have already drawn is a different act with a different answer each time |
| …and it is only in the flyout while the Draw tool is in hand | once rounding had a dial of its own, the only thing left that reads it is `finalizeSketch()`, and only Draw can start a stroke. A slider sitting under Points and Move that quietly does nothing there is worse than no slider: it invites you to move it and then ignores you |
| Round corners curves the anchors of a point-drawn shape instead of chopping it into more points | the Points tool exists so a shape is a handful of corners you can move. Rounding it by subdividing handed back 200 polyline points and took the shape away from the tool that made it. It is the same thing the per-point *Curve* button already does, with the slider setting the length |
| …but a traced outline is still smoothed as a polyline | handles a fraction of the gap between two points 0.3 mm apart bend nothing anybody can see, and there is no corner there to round. The line between the two is 48 anchors: the biggest starter shape has 20, an import has hundreds |
| A curved corner bulges past itself, so rounding makes the shape slightly bigger | the curve has to pass through the anchor, so with one anchor per corner it can only bow outwards. Filleting instead (two anchors per corner, straight edges kept) would double the anchors every time and stop the slider being a dial you can turn back. The canvas shows the size changing as you slide, the size boxes are right there, and Cancel is one press away |
| Placing a corner and pulling draws its curve; it does not move the corner | you put the corner where you meant it a fraction of a second ago — dragging it straight off that spot is the one thing you cannot have wanted. The pull is the only moment a new corner's curve can be drawn in the same gesture, and it is how every pen tool people have used works. Place, pull, place, pull draws a smooth outline in one pass instead of placing corners and then curving each of them |
| …and on the outline itself as much as on the canvas | a corner put on a line is a corner being placed, and it is usually put there precisely because the outline needs to bend at that spot. Two ways of adding a corner that answer the same press differently is the kind of rule nobody can hold in their head |
| The two handles of a pulled corner are exactly opposite and the same length | that is what makes the outline run smoothly through it, and it is the only thing a single drag can mean. Adjusting one afterwards keeps the other's length instead (`_mirrorHandle`), which is a different question with a different answer |
| The pull threshold is measured on the screen, not on the canvas | the toolbar gains buttons the moment the first corner goes down. If that ever grows a row, the canvas slides out from under a perfectly still pointer, and a canvas-relative threshold reads the slide as a 38 px drag. The screen does not move |
| A file dropped on the window is imported; the canvas is lit up as where it lands | dragging a file in is how people bring a file to an app, and the two pickers were the only way. The canvas is the honest target — that is where the shapes appear — and showing it beats a veil that says nothing about where the file is going |
| …but the drop is swallowed over the whole window, and in every state | a file let go beside the canvas is opened by the browser *in this tab*, which throws away an unsaved drawing without asking. That is the worst thing that can happen here, so the layer covers everything and never lets the browser have the file — even while a dialog is up, when the app cannot take it either |
| The layer is dismissed by a timer that `dragover` pushes back, not by counting dragenter against dragleave | the count is the usual way and it is wrong: moving from an element to its own child fires a leave and an enter, and any imbalance leaves a veil stuck over the app with no drag in sight. `dragover` keeps firing while the file is over the window, even when the pointer stands still, so it is the signal that is actually there |
| A file arriving on a plate that is not empty asks: add, replace, or cancel | only the person who dropped it knows which. A plate is a set of cutters that belong together, so a second file is at least as likely to be another one of them as a fresh start — and the old confirm offered "replace" or nothing, which made adding a shape from a file impossible |
| …but an empty canvas is never asked, and neither is an SVG dropped onto the inner wall | there is nothing to keep and nothing to replace; and with *Editing: Inner wall* in hand, an outline goes into the wall you are editing, which is neither of the two answers |
| Added shapes keep the file's own arrangement and move clear of the plate as one group | the file says how its shapes sit relative to each other — that is the sheet someone laid out — and only where the group lands is ours to decide. Placing them one at a time would take the sheet apart |
| Added shapes take the plate's Mirror, not the file's | mirror turns the whole plate over; half a plate mirrored is not a thing you can print. It is the one setting a shape does not get to bring with it |
| Adding is one undo step; only replacing clears the undo history | adding is an edit to the drawing you are working on, like any other. Replacing is a different drawing, and an undo across two of them would be nonsense |
| The import answer is read off the dialog's submit event, not its close | the button that was pressed *is* the answer, and it is already in the submit. Waiting for the close that follows puts one more event between the press and the result, and any browser or state in which that event is late or missing leaves the import hanging with a veil over the app. `confirmAction()` already reads its OK the same way |
| Reading a file and building the solid happen behind a full-window loader | both are main-thread work of a few seconds on a big drawing, and the app used to look like it had done nothing at all until the shapes suddenly appeared |
| Putting the loader up is awaited, and the wait is raced against a timer | a veil painted after the work it announces is no veil at all, so the code waits for a frame. But a tab in the background is never painted and never gets a frame, and an import that hangs because the user looked at something else for a moment is far worse than a veil that goes up 60 ms late |
| The rebuild after an import is pulled out of its debounce and done inside the same loader | the wait is one wait as far as the user is concerned. Dropping the veil after the parse would show a finished-looking app that then freezes for another 300 ms |
| A setting that is off the app's default is marked, per setting, with a one-press reset | a cutter opened from an STL has every number measured off the model, and nothing on the panel said so — a 21.5 mm height and a 0.8 mm blade look exactly like settings somebody chose. The mark is a marker first and a button second: seeing *which* numbers are not the standard ones is most of what it is for |
| One setting resets on the press; all of them ask first | the value of one setting is right there on screen, so a dialog could tell you nothing you cannot see. All of them is several numbers at once, some in sections that are folded away, and wall settings have no undo — so it says what it would change, from what to what, and can be said no to |
| A setting only counts as off-default while it is on screen and doing something | the step sizes with the step switched off, and the bar settings with no inner wall, build nothing and are not shown. Counting them would put a number in the row that points at a field the user cannot find — the same rule as the smoothing slider |
| The bar thickness's default is `auto`, not the 2 mm in `DEFAULT_PARAMS` | a shape you draw never gets 2 mm — auto gives it 10 % of its width. Resetting to 2 would be overwritten by auto on the next edit, so the reset turns auto back on instead, and having auto on *is* being on the default, whatever it works out to |
| A shape whose settings are off the default is flagged in the shapes list too | the settings panel only ever shows one shape. On a plate of six, five of them are off screen, and an STL that came in with its numbers measured off the model gives no sign at all until you step through the shapes one by one. The arrow in the row is the same arrow, one level up: this shape, not this number |
| …and it is a marker, not a button | the row it sits in already means "switch to this shape", and that is the right answer to pressing it — the panel is where you can see what you would be changing. Two different things to press inside one 32 px row, one of them changing settings you cannot see, is not a control anybody wants on a phone |
| Mirror is left out of the reset marks | it turns over the whole plate rather than this one shape, which is why it sits under Export; it already asks for confirmation of its own, and a reset that triggered a second dialog inside the first is nobody's idea of a control |
| A shape is picked up by clicking it on the canvas, and put down by clicking beside it | the shapes list was the only way to say which shape you meant, and while you are laying out a plate you are looking at the drawing, not at the list. Clicking the shape you can see is the shortest way to say it, and the same press carries on into the drag, so a shape is picked up and placed in one gesture |
| Putting a shape down does not stop it being the shape being edited | `index` is what the settings panel, the shapes list and the other two tools all read; a canvas click that quietly took the panel away from the shape it was showing would be a much bigger thing than letting go of the handles. Put down means the Move tool is holding nothing — no box, no handles, no position bar, no nudging — and nothing else |
| A shape that is not in hand lights up under the pointer | a click that changes which shape you are editing has to say so before it is pressed, and on a plate of six grey shapes there is otherwise nothing to aim at. It is a step towards the active colours and no further: it says "this is what a click picks up", not "this is picked up" |
| A press on the shape already in hand releases nothing | in inner-wall mode the pointer is often over the shape without being over the wall the handles are on, and a click there that dropped the shape would be a trap. Only the empty canvas puts a shape down |
| The undo step for a move is taken when the shape first travels | a press is now also how a shape is picked up, and picking one up changes nothing. Recording at the press meant every selection click cost an undo step — out of sixty — and a rebuild of the whole plate for a drawing that had not changed |
| Custom tooltips from `title=` instead of native ones | icon-only buttons need an explanation; native titles are slow, unstyled and absent on touch. `app.js` moves every `title=` to `data-tip`, so new markup only needs a `title=`. Phrase it as `Name — what happens`; the part before the em dash is bolded. |

## 7. Known limitations / backlog

- One residual random stress case (1 in ~1200) produces a single pinched vertex where a very
  narrow bar meets a wobbly outline — not an open edge; slicers accept it.
- Only one inner wall (largest hole) **per shape** is supported; more holes are ignored with a toast.
- Shapes cannot be reordered in the list, renamed, duplicated or dragged between plates, and there
  is no "arrange these to fit the bed". The overlap guard is the only layout help there is.
- Overlapping shapes are merged, but nothing checks that the merge is *printable*: two blades
  crossing at a very shallow angle leave a sliver of plastic thinner than a nozzle. The STL is
  watertight; whether a slicer can fill it is between the user and the preview.
- Taking a merged lump apart assumes each shape's outside is one piece of the region. Two shapes
  crossing (any number of such pairs) is read exactly; a *chain* — A crossing B and B crossing C —
  leaves a shape with pieces of its outside on two sides, the check catches it, and the whole group
  comes back joined as one outline with a note. Nobody has asked for chains yet.
- The recovered outline is off by up to ~0.1 mm at a crossing point itself (the closing rounds the
  reflex corner there) and exact everywhere else. `cleanPolygon` at build time takes the kink out,
  so the rebuilt solid is watertight and within 0.02 % of the model it was read from.
- A shape sitting entirely inside another shape's cut region is read as that shape's inner wall,
  not as a shape of its own; its own walls and height are lost.
- The overlap guard grows the *other* shapes once per drag and then only intersects polygons, but
  a plate of a dozen dense outlines will still make a drag work for its frame rate.
- The STL importer reads widths and heights to 0.01 mm. Settings typed in tenths come back exactly;
  a model with real-valued dimensions can rebuild a few tenths of a percent off in volume.
- No text / imprint stamps, no handle on the cutter, no 3MF export.
- Regeneration ~150–300 ms; it is debounced (120 ms) and not off-thread. A Web Worker would help on
  slow phones if it ever becomes a complaint.
- Only the first file of a multi-file drop is imported; the rest are named in a toast and ignored.
- The loader is a veil, not a progress bar: the work is on the main thread and cannot report how
  far along it is. A Web Worker would fix both that and the freeze (see above).
- UI tests are not automated in-repo (they were run with Playwright during development); see §8.

## 8. How to verify changes (do this before declaring anything done)

1. **Mesh integrity** — `node tests/mesh-check.mjs 100`. All fixed cases must PASS with
   0 open / 0 non-manifold edges; random cases should be 0 (a single pinch is tolerable, an
   open edge is not). Add a fixed case whenever you touch `buildCutter` or `buildAll`. The merged
   cases check that shapes which run into each other come out as one watertight solid taking up
   less room than the two of them added together, and that a third shape standing clear of them
   is left as an object of its own. Every starter shape is
   a fixed case at both the size it is drawn and the 30 mm it is inserted at (the tighter of the
   two: the same 3 mm base around a much smaller outline), so a new or edited preset is checked
   automatically. The plate cases check that several shapes, each with its own settings, join into
   one watertight soup and that a shape that will not build is named.
2. **Project round-trip** — `node tests/project-roundtrip.mjs`. All cases must PASS; add one
   whenever you add something to the saved state. A plate of several shapes with different
   settings, a plate of two overlapping shapes (saved apart, built as one object) and a schema-1
   file opening as a plate of one are all fixed cases.
2b. **STL round-trip** — `node tests/stl-import.mjs 40`. Every fixed case must PASS (same outline
   point for point, same settings, same solid) and the random cases must come back within 1 % of
   the volume. A plate of two cutters must come back as two shapes with their own settings, in
   their places; a plate whose shapes overlap but whose blades stand clear must come back as its
   shapes with 0 % volume lost, heights and inner wall included; a plate whose blades cross must
   come back as its shapes too, every point of a recovered circle on the circle it was cut from;
   a plate of a single tier, where the walls cannot be read, must come back joined and say so; a
   ring whose connections are wider than its channel is deep must come back with the connections it
   was built with; and a cutter with a base flange overhanging its inner cut line (welded on as a
   shape of its own, since Cutter cannot build one) must still give back its three connections and
   not one ring-shaped bar.
   Add a case whenever you touch `buildCutter` *or* `stlimport.js` — the importer is the inverse of
   the builder, so a change to either can only be trusted through both.
3. **Local run** — `node dev-server.js`, open http://localhost:3002, check the browser console is
   clean, and exercise: draw → 3D appears; Points with a curve; SVG import of a file with a hole
   (a viewBox-only SVG must trigger the size dialog with 80 mm); symmetry left–right and both;
   grid snap; a guide; Download STL (open it in a slicer if available — no repair warning);
   Save project, reload the page, Open project — the drawing, the settings and the STL must match.
   Then Import that same STL: the drawing, every setting and the 3D preview must come back with it.
   Do it again with two shapes 4 mm apart whose 3 mm bases overlap: both shapes must come back,
   in their places, and the 3D preview must be the plate you started from. Then push them into
   each other so the blades cross and import that: both shapes must come back whole, crossing where
   they crossed, and the 3D preview must be the plate you started from.
   Then the plate: add a second shape, give it a different height, check the first one keeps its
   own; drag one into the other and watch it stop; draw a stroke on top of a shape and see it
   refused; import an SVG with several separate outlines and get a shape per outline; save, reload,
   open — every shape and its settings must come back, and so must an STL of the whole plate.
   Then overlapping: with one shape on the canvas the *Allow overlap* row must not be there at
   all; add a second and it appears under the list, and folding the list away takes it with it.
   Switch it on and drag one shape across
   another — it must go, the 3D preview must show one joined solid where they meet (no wall
   stopping dead inside another), the status line must read `2 shapes, 1 object`, and the cut
   piece popup must show one blob with the shared cut line drawn across it, not a hole in the
   middle. Switch the setting back off: nothing moves and the toast says they stay joined, but the
   next drag stops again. Save, reload, open — two shapes back on the canvas with the setting on.
   Import an SVG of two overlapping circles with the setting off: the row must light up by itself
   and say so. Download the STL and open it in a slicer — one object, no repair warning.
   Then dropping a file in: drag an SVG from the file manager over the window — the canvas must
   light up with a dashed frame, and the veil must reach the edges of the window. Drag back out and
   it goes away on its own. Drop it on an empty canvas and the size dialog comes straight up; drop
   it on a canvas with a shape on it and the question comes first — *Add n shapes* must put them
   beside what is there, keeping the file's own arrangement, with Undo taking the whole thing back
   in one press, and *Replace the drawing* must start over. Cancel must leave everything alone
   *and* let the next file in. Do the same with an STL and with a `.cutter` project: added shapes
   keep the settings the file gave them, but take the plate's Mirror, and the file name and the
   grid stay yours. Drop a file while a dialog is up — nothing may happen, and in particular the
   browser must not open it. Check the message over the window appears while a big file is read
   and stays up until the 3D preview has caught up.
   Then picking shapes up: with two shapes on the plate and the Move tool in hand, move the
   pointer over the grey one — it must light up and the cursor become a pointer — and click it:
   it becomes the shape being edited, the settings panel and the shapes list follow, and the box
   and handles are on it. Press on the other one and drag in the same gesture — it must pick up
   and move. Click the empty canvas: the box, the handles and the position bar must go, the arrow
   keys must stop nudging, and the panel must still show that shape. Click it again (or any
   shape) to pick it back up; Escape must put it down again. Switch to Points and back to Move —
   it comes back held. With *Editing: Inner wall*, a click in the ring between the two walls must
   change nothing at all. Check that clicking about between shapes adds no undo steps: the Undo
   button must stay where it was until something actually moves.
   Then the Points tool: place three corners and check the 3D preview stays empty and the line
   stays dashed; click the first point and watch the cutter appear; click the canvas and inside
   the shape (deselects, no corner), then a line (inserts one). Leave one outline unfinished,
   save, reload and open — it must come back unfinished.
   Then the pen gesture, on the canvas and on an existing outline alike: tap to place a corner and
   it is sharp; hold and pull as you place the next and it comes out curved, with the corner still
   where you put it — on the line, if that is where you put it — and its two handles equal and
   opposite. Dragging a corner that was already there must still move it. Four of those and a closing click must give a smooth blob from four anchors.
   Watch the toolbar as the first corner goes down — it must not gain a row and shove the canvas.
   Then the rounding tool, from each of the three tools in turn: the wave button is disabled on
   an empty canvas and lights up once a wall exists. On a square drawn with Points, pressing it
   must bring up the slider at 0; dragging it must bend the corners on the canvas *and* in the 3D
   preview while you drag, with the size in the corner following; Cancel must put the square back
   exactly and add no undo step; Apply must add exactly one, which Undo takes back whole. Reopen
   it and the slider must start where the shape now stands, and go back down to sharp. Check the
   inner wall of the same shape (the outer must not move), a freehand outline (the line is cut
   back instead of the corners curved), and that the canvas and the shape action buttons do
   nothing while the slider is up. Check it at a narrow canvas too (switch the settings panel on
   and off) — the bar loses its name and its button labels, and the toolbar loses its words
   rather than clipping a button off the end.
   Then the reset marks: on a shape you have just drawn the row at the top of the settings panel
   must not be there and no field may carry an arrow. Type a different cutter height and base
   width — two arrows appear and the row reads `2 settings differ from the defaults`. Press one
   arrow: that field goes back, the row reads `1 setting`, the 3D preview follows. Switch the
   support step off — the step sizes go off screen and stop counting; switch it back on and they
   count again. Type a bar thickness (auto goes off): an arrow appears beside *Thickness*, and
   pressing it turns auto back on rather than writing 2 mm. Press *Reset all*: the dialog must
   list every setting from → to, Cancel must change nothing, and confirming must put them all
   back and say so. With two shapes on the plate, the marks and the row must follow the shape you
   are on and the dialog must name it. Then import an STL of a cutter that is not on the
   defaults — the row must come up with most of the settings named, and resetting must leave the
   drawing and its size alone. With several shapes on the plate, the arrow in the shapes list must
   appear on exactly the shapes that are off the default — on the shape you are on as you type,
   and on the ones you are not — and go away as each is put back. Import a plate whose cutters
   were built with different settings and check the arrow lands on the right rows.
4. **Responsive** — check desktop, ~1024 px tablet and ~390 px phone widths (touch: canvas must not
   scroll the page; long-press opens the point menu).
5. If you have Playwright/Chromium, drive the page headless with
   `--use-gl=swiftshader --enable-webgl` flags; `window.cutter = { editor, viewer, params }` is
   exposed for automation (`editor.getShape()`, `editor.getSize()`, `editor._bboxHandles()`).
6. Update `README.md` when behaviour changes, and update **this file** when you make a decision
   that future agents must respect (add it to §6).

## 9. Deployment

Static site. Vercel: import the repo, framework "Other", no build command, output directory root;
or `vercel --prod` from the folder. `.wasm` is served with the right MIME type by Vercel and by
`dev-server.js`. Nothing else to configure.
