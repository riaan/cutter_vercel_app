# Cutter — instructions for coding agents

This file is the single source of truth for any AI coding agent (Claude, OpenAI/Codex, Gemini,
Cursor, Copilot, …) working on this repository. Read it fully before changing anything.
`CLAUDE.md`, `GEMINI.md` and `.github/copilot-instructions.md` only point here — keep it that way;
do not duplicate content into them.

---

## 1. What this project is

**Cutter** is a single-page web app: the user draws or uploads a 2D outline and downloads a
3D-printable cutter (cookie / clay / fondant cutter) as a binary STL. It runs entirely in the
browser — no build step, no backend, no accounts. It must work on phones and tablets (touch, pen)
as well as desktop browsers, and be usable by non-technical people.

Deployment target: Vercel free tier as a static site (also works on any static host).
Local testing: `node dev-server.js` → http://localhost:3002 (PORT overrides it) (zero dependencies).

Owner's language is Dutch; the UI is English. Keep UI copy short, friendly and non-technical.
Never call it a "cookie cutter" in the UI — it is just a "cutter"; the piece it cuts is the
"cut piece". The view from the cutting edge is called "Back".

## 2. Repository layout

```
index.html           page structure, all controls (ids are referenced from js/app.js)
styles.css           tokens + responsive layout (desktop ≥1181px, tablet ≤1180px, phone ≤760px)
js/app.js            wiring: UI ↔ editor ↔ geometry ↔ viewer; SVG dialog; starter-shape picker;
                     point bar/menu; download; save/open project; cut-piece popup
js/project.js        .cutter project file: the saved state, validation, zip packing
js/zip.js            minimal stored-only zip writer + reader (no dependency)
js/editor.js         2D canvas editor (ShapeEditor class) — everything the user draws/edits
js/geometry.js       math: polygon cleanup/offsets (Clipper), symmetry, solid build (Manifold), STL
js/svgimport.js      SVG → outline(s) using the browser's own path engine
js/viewer.js         three.js preview (CutterViewer class)
js/presets.js        starter shapes (few anchors + Bézier handles, see §6)
vendor/              three.module.js (+ addons/controls/OrbitControls.js), clipper.js,
                     manifold.js + manifold.wasm — vendored; no CDN, no npm at runtime
tests/mesh-check.mjs mesh integrity test (Node) — see §8
tests/project-roundtrip.mjs  save → open → identical mesh (Node) — see §8
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
                 shape = { outer: [...], inner: [...] }   // "seed" contours, mm, y DOWN
                 getShape() → effective shape (curves flattened, symmetry applied)
                        │ onChange(shape)
                        ▼
              app.js: updates size inputs, hint, auto connection thickness,
                      2D rings for the canvas (Clipper offsets), debounced regenerate()
                        │
                        ▼
              geometry.buildCutter(shape, params)  ── Manifold CSG ──► { positions, volume, … }
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

### Shape model
- Points are `{ x, y }`, optionally with Bézier handles `in`/`out` (offsets from the anchor) and
  `smooth` (handles kept collinear). Only the Points tool creates handles. `flatten()` turns a
  control polygon into a polyline (cubic sampling ≤ 0.25 mm). Every transform must go through
  `mapPts()` so handles move with their anchors.
- **Symmetry mode** (`sym.x` = left–right mirror line x=0, editable side x ≥ 0;
  `sym.y` = top–bottom mirror line y=0, editable side y ≤ 0). The stored contour is the user's
  half ("seed"). The effective contour = `symmetrize(closeViaAxes(flatten(seed)))`:
  close the open half along the mirror lines (through the origin when both are on), clip to the
  region, mirror, union. Turning symmetry off bakes the full shape; turning it on clips the full
  shape to the region (`clipToRegion`, which rotates the ring so it starts/ends on the mirror line).
  In symmetry mode: no rotation handle, handles on the mirror side hidden, moving restricted to
  along the axis, two-finger gestures disabled, strokes and corners clamped and magneted to the axis.
- **Inner wall**: `shape.inner` is a hole in the cut piece. Editing "Outer wall" transforms both
  contours; editing "Inner wall" transforms only the inner. The Inner wall tab is disabled until an
  outer wall exists. Validation: inner must be completely inside outer (`isInside`).
- `_display()` caches the effective shape keyed on `version` **and** array identity — any code that
  replaces `this.shape` and then reads `_display()` before `_changed()` relies on this (a stale
  cache once produced NaN coordinates).

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

### Project files (`.cutter`)
`Save project` writes a zip (`js/zip.js`, stored, no compression) containing `project.json`,
`model.stl`, `preview-2d.png` and `preview-3d.png`. **Only `project.json` is read back** — the
mesh is rebuilt from it, which is what makes a reopened project identical; the STL and the two
pictures are there for the user's file browser and slicer.

`project.json` carries the **seed** contours (with Bézier handles — in symmetry mode the edited
half, exactly as stored), `sym`, the active wall, the tool, smoothing, aspect lock, grid size and
snap, all `DEFAULT_PARAMS`, the `bridgeAuto` flag, the file name and a stats snapshot. The view
(zoom/pan) and guides are deliberately **not** saved — they belong to the sitting, not the cutter.
Params are merged over `DEFAULT_PARAMS`, so a file saved before a new parameter existed still opens.
`schema` is checked and a newer file is refused with a sentence, not a stack trace.

Two ordering rules that will bite anyone who touches this:
1. `editor.setState()` must put the seeds in **without** `_toSeeds()` — running it on a seed clips
   a symmetric half a second time;
2. `applyState()` restores the shape first and the params second, because `onChange` runs
   `autoBridgeWidth()`, which would otherwise overwrite a saved manual connection thickness.

`viewer.snapshot()` renders one frame explicitly and reads the canvas back in the same task (the
renderer does not preserve its drawing buffer); `editor.renderPreview()` draws the shape and wall
bands only — no grid, guides, handles or dimensions. Both may fail; the project then saves without
that picture rather than not at all.

### Resolution / smoothing
- SVG import samples every 0.05 mm of the SVG's native size (max 6000 samples per element) and
  only de-duplicates (`cleanPolygon(…, 0.0005)`). Simplification happens **at the final size**
  with 0.002 mm tolerance (in `regenerate()`), never before scaling. Clipper offsets use
  arcTolerance 0.01 mm. This fixed angular prints from a small SVG scaled up ×3.5.
- "Sketch smoothing" only affects freehand strokes on pen-up (RDP simplify + Chaikin); "Round
  corners" applies the same to the selected wall on demand (strength from the slider).

### 2D preview rings
`app.js › ringsFor()` computes base/step/blade bands for outer and inner walls and the connection
bars (`bridgeShapes`, Clipper) for the canvas. It is cached per editor version + params; clear
`ringsKey` when params change.

## 4. UI behaviour that users rely on

- **Canvas view**: `editor.view = { size, zoom, pan }`. `size` is mm across the shorter canvas
  edge at 100 % and is what `_autoFit()` sets; `zoom` (0.25–8) multiplies it; `pan` is the mm point
  at the canvas centre. `toPx`/`toMm` are the only places this is applied — never assume the origin
  is the canvas centre (`_renderGrid` derives it from `toPx({x:0,y:0})`). `_autoFit()` is a no-op
  once the user has zoomed or panned. Pan mode routes pointer drags to the view and suppresses the
  shape-reshaping two-finger gesture, replacing it with a view pinch. The right mouse button pans
  from anywhere; a right *click* that never moves more than 3 px still opens the point menu, so both
  gestures share the button. `view.manual` (not a pan/zoom comparison) is what suppresses `_autoFit`.
  Zoom without an anchor re-centres on the shape's bbox; only the wheel and pinch anchor on a point.
- Tools: **Draw** (freehand), **Points** (tap to add, tap a line to insert, drag, double-tap or
  Delete key or bar/menu to delete, right-click / long-press for menu, Bézier handles with
  *Sync handles*), **Move & resize** (drag, corner/edge handles, rotate knob with 15° snap,
  two-finger pinch/twist). Keyboard 1/2/3 switch tools, O/I switch wall, Ctrl+Z/Y undo/redo, Esc.
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
- The tool explanation at the canvas' top left (`#toolTip`) shows itself for 5 s after a tool
  switch, then slides back behind its (i) (`.tool-tip.collapsed` clips the text with `clip-path`,
  so the words never reflow mid-slide). Hovering the (i) brings it out, leaving it puts it back;
  on touch a tap toggles it. `app.js › showToolTip()` owns the text and the timer.
- Cursors are state-dependent (`_hover()` in the editor): default/move/resize per handle/rotate
  cursor in Move mode; pointer over points, move while dragging, copy over lines, crosshair to add.
- **Which wall an action applies to** is decided by `editor.active`, and `app.js › syncWallActions()`
  keeps the buttons and their tooltips in step: Clear (`editor.clear`) and Flip (`editor.flip`)
  act on both contours in outer mode and on the inner contour alone in inner mode (both go
  through `_affected()`); Center is disabled in inner mode, where the Align control
  (`editor.alignInner(h, v)`, nine bbox spots) takes over. Switching a mirror on or off asks for
  confirmation once something is drawn, because it reshapes the drawing. Center, Align, both
  Flips and Clear (and *Round corners* in the flyout) are hidden/disabled until the wall being
  edited actually has a contour, so an empty canvas offers nothing that would do nothing.
- Snapping: grid (size selector 1–20 mm, Snap toggle, at the canvas' bottom left next to the
  scale bar), guides (vertical/horizontal, draggable tabs
  at the canvas edge, double-tap tab to remove), mirror lines. Magnet distance `SNAP_PX = 10`.
  Freehand strokes are deliberately **not** grid-snapped (would make them jagged).
- **Starter shapes** open a grid of previews (`#presetBtn` → `#presetMenu`), three columns, one
  tile per shape. `app.js` builds the tiles from `PRESETS[key].make()` itself — the same anchors
  the editor is handed, turned into an SVG path — so a preview can never drift from the outline it
  inserts; adding a preset needs no picture. The grid is `position: fixed` and placed by
  `placePresetMenu()`, because `.pane-draw` clips what overflows it and on a phone the grid is
  taller than the pane; it flips above the button when there is more room there. The button's own
  tooltip is taken away while the grid is open, or it would cover it.
- SVG upload opens a size dialog prefilled with the physical size (mm/cm/in units) or 80 mm wide;
  proportion lock; only then is the shape imported. SVG holes become the inner wall; separate
  outside shapes are merged into the outline.
- Size inputs edit the cut piece (outer wall) size; the cutter is bigger by the base.
- File name defaults to `cutter-xxxxx` (random 5-char hash per page load).
- Empty-state hint centred; the inner-wall hint sits bottom-centre, 56 px up (`.hint.corner`), clear
  of the scale bar and the zoom / pan controls; it fades out while the zoom menu is open.
- The canvas' bottom left holds the grid control (scale bar + size + Snap); the bottom right holds the zoom / pan controls (`.canvas-view`, menu opens upwards); the top
  right belongs to the point bar and the canvas setup flyout. Don't put anything else in either corner.
- **Which panels are on screen** is switched in the header (`.segmented.panels`, one button per
  panel). `app.js › syncPanels()` sets `hidden` on the pane and a `panes-no-*` class on `<body>`;
  the grid template for every combination lives with the breakpoints in `styles.css`, so a switched
  off panel gives its width to the ones that are left. The canvas and the 3D preview are the two
  panels that show the cutter, so one of them always stays: the switch of the last one left is
  disabled (and says why) rather than quietly doing nothing. All three are on at every page load;
  the state is not saved, in a project or anywhere else.
- 3D: Fit / Top / Back buttons; smooth shading with a 32° threshold (`smoothNormals` in viewer);
  the camera refits only when the size changes a lot. `fit()` measures the viewport first (the
  distance follows the aspect ratio) and, when the panel is switched off and there is nothing to
  measure, defers itself to the next `_resize()` — otherwise a cutter built while the preview was
  hidden would come back framed for a 1:1 viewport.
- **Cut piece popup** (`#resultDialog`, *Cut piece* next to the 3D view buttons, enabled once there
  is an outer wall): the piece the cutter leaves behind, drawn straight onto a canvas by
  `app.js › renderResult()` — the cut line filled, the inner wall punched out (`evenodd`), a second
  copy pushed down behind it for the cut edge, and a blurred fat stroke clipped to the piece for
  the rollover. It shows the face that meets the clay: `x` turns over unless `params.mirror` is on
  — left–right, never top–bottom, which would only read as "upside down". `mirrorMatters()` (Clipper union against the shape's
  own mirror image about either bbox axis, 2 % tolerance, symmetry mode short-circuits it) decides
  whether the sentence about mirroring and the *Match my drawing* toggle are shown at all; that
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
  piece, purple Bézier handles, orange guides. No headers/eyebrows/all-caps labels. Buttons ≥ 32 px
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
| The tool explanation auto-hides after 5 s into an (i) that reopens on hover | it explains a tool you have just picked, and after that it is only in the way of the canvas |
| `.cutter` is a zip with the STL and two PNGs inside, but only `project.json` is read back | one file to keep and to hand around; rebuilding from the settings is what guarantees the same cutter, where a stored mesh would silently freeze old geometry |
| The canvas view (zoom/pan) and guides are not saved | they are scaffolding for drawing, not part of the cutter; restoring them would fight `_autoFit` on open |
| Opening a project asks for confirmation when something is drawn, and clears undo | it replaces the whole drawing, and an undo across two different projects would be nonsense |
| Shift constrains a point to H/V and a handle to 45° steps; arrow keys step 1 mm | the mouse alone cannot place a point on a straight line or an exact millimetre, and the grid is often the wrong size for it |
| The point bar shows position and handle offsets as editable numbers | a cutter is often drawn to a measurement; reading it off the canvas and dragging until it looks right is not a way to hit 12.5 mm |
| The cut piece is shown mirrored left–right, never turned upside down | with the mirror off the piece really is a mirror image of the drawing, and that is what catches people out with letters — but flipping it top–bottom reads as "upside down" instead. Both flips are the same piece turned round on the table, so the sideways one is the honest picture: it shows the mirroring and nothing else |
| The mirroring sentence is withheld for a shape that is its own mirror image | both settings then give the same piece, turned round, and a warning about nothing is noise |
| The clay colour is session state: not saved, not in `project.json` | it belongs to the sitting, like the canvas view; the cutter is the same object whatever colour clay goes into it |
| Starter shapes are built from anchors with Bézier handles, not sampled polylines | inserting one used to drop 100–180 points on the canvas, which the Points tool could not sensibly edit; a circle is four points now. They go into the editor uncleaned — `cleanPolygon()` would flatten every curve straight back into a polyline |
| The shapes themselves did not change: each is a fit of the outline it replaces | the heart and the flower are least-squares fits of their old formulas (worst gap 0.14 / 0.18 mm) and the gingerbread man is his old arcs written as two cubics each (0.04 mm). Anyone re-cutting a preset must keep it on the old outline — check it against `git show` of this file before and after |
| Each of the three panels can be switched off, but never both views at once | the whole width for the drawing, or for the cutter, is the point; settings only are three panels' worth of numbers with nothing to look at. The last view left is disabled instead of refusing on click, so the reason is there before you press it |
| The panels are all on at every page load and the state is never saved | like the canvas view, it is how you are sitting at the moment, not what the cutter is; and a project that opened with two panels missing would look broken |
| Starter shapes are picked from a grid of previews, not a drop-down | a list of names cannot show what you are about to insert, and the shapes are the whole point of the control. The tiles are drawn from the preset data, never from stored pictures |
| Custom tooltips from `title=` instead of native ones | icon-only buttons need an explanation; native titles are slow, unstyled and absent on touch. `app.js` moves every `title=` to `data-tip`, so new markup only needs a `title=`. Phrase it as `Name — what happens`; the part before the em dash is bolded. |

## 7. Known limitations / backlog

- One residual random stress case (1 in ~1200) produces a single pinched vertex where a very
  narrow bar meets a wobbly outline — not an open edge; slicers accept it.
- Only one inner wall (largest hole) is supported; more holes are ignored with a toast.
- No text / imprint stamps, no handle on the cutter, no 3MF export.
- Regeneration ~150–300 ms; it is debounced (120 ms) and not off-thread. A Web Worker would help on
  slow phones if it ever becomes a complaint.
- UI tests are not automated in-repo (they were run with Playwright during development); see §8.

## 8. How to verify changes (do this before declaring anything done)

1. **Mesh integrity** — `node tests/mesh-check.mjs 100`. All fixed cases must PASS with
   0 open / 0 non-manifold edges; random cases should be 0 (a single pinch is tolerable, an
   open edge is not). Add a fixed case whenever you touch `buildCutter`. Every starter shape is
   a fixed case, so a new or edited preset is checked automatically.
2. **Project round-trip** — `node tests/project-roundtrip.mjs`. All cases must PASS; add one
   whenever you add something to the saved state.
3. **Local run** — `node dev-server.js`, open http://localhost:3002, check the browser console is
   clean, and exercise: draw → 3D appears; Points with a curve; SVG upload of a file with a hole
   (a viewBox-only SVG must trigger the size dialog with 80 mm); symmetry left–right and both;
   grid snap; a guide; Download STL (open it in a slicer if available — no repair warning);
   Save project, reload the page, Open project — the drawing, the settings and the STL must match.
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
