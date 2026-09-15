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
Local testing: `node dev-server.js` → http://localhost:3000 (zero dependencies).

Owner's language is Dutch; the UI is English. Keep UI copy short, friendly and non-technical.
Never call it a "cookie cutter" in the UI — it is just a "cutter"; the piece it cuts is the
"cut piece". The view from the cutting edge is called "Back".

## 2. Repository layout

```
index.html           page structure, all controls (ids are referenced from js/app.js)
styles.css           tokens + responsive layout (desktop ≥1181px, tablet ≤1180px, phone ≤760px)
js/app.js            wiring: UI ↔ editor ↔ geometry ↔ viewer; SVG dialog; point bar/menu; download
js/editor.js         2D canvas editor (ShapeEditor class) — everything the user draws/edits
js/geometry.js       math: polygon cleanup/offsets (Clipper), symmetry, solid build (Manifold), STL
js/svgimport.js      SVG → outline(s) using the browser's own path engine
js/viewer.js         three.js preview (CutterViewer class)
js/presets.js        starter shapes
vendor/              three.module.js (+ addons/controls/OrbitControls.js), clipper.js,
                     manifold.js + manifold.wasm — vendored; no CDN, no npm at runtime
tests/mesh-check.mjs mesh integrity test (Node) — see §8
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
- SVG upload opens a size dialog prefilled with the physical size (mm/cm/in units) or 80 mm wide;
  proportion lock; only then is the shape imported. SVG holes become the inner wall; separate
  outside shapes are merged into the outline.
- Size inputs edit the cut piece (outer wall) size; the cutter is bigger by the base.
- File name defaults to `cutter-xxxxx` (random 5-char hash per page load).
- Empty-state hint centred; the inner-wall hint sits bottom-centre, 56 px up (`.hint.corner`), clear
  of the scale bar and the zoom / pan controls; it fades out while the zoom menu is open.
- The canvas' bottom left holds the grid control (scale bar + size + Snap); the bottom right holds the zoom / pan controls (`.canvas-view`, menu opens upwards); the top
  right belongs to the point bar and the canvas setup flyout. Don't put anything else in either corner.
- 3D: Fit / Top / Back buttons; smooth shading with a 32° threshold (`smoothNormals` in viewer);
  the camera refits only when the size changes a lot.

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
   open edge is not). Add a fixed case whenever you touch `buildCutter`.
2. **Local run** — `node dev-server.js`, open http://localhost:3000, check the browser console is
   clean, and exercise: draw → 3D appears; Points with a curve; SVG upload of a file with a hole
   (a viewBox-only SVG must trigger the size dialog with 80 mm); symmetry left–right and both;
   grid snap; a guide; Download STL (open it in a slicer if available — no repair warning).
3. **Responsive** — check desktop, ~1024 px tablet and ~390 px phone widths (touch: canvas must not
   scroll the page; long-press opens the point menu).
4. If you have Playwright/Chromium, drive the page headless with
   `--use-gl=swiftshader --enable-webgl` flags; `window.cutter = { editor, viewer, params }` is
   exposed for automation (`editor.getShape()`, `editor.getSize()`, `editor._bboxHandles()`).
5. Update `README.md` when behaviour changes, and update **this file** when you make a decision
   that future agents must respect (add it to §6).

## 9. Deployment

Static site. Vercel: import the repo, framework "Other", no build command, output directory root;
or `vercel --prod` from the folder. `.wasm` is served with the right MIME type by Vercel and by
`dev-server.js`. Nothing else to configure.
