# VolumeCube

**A volumetric LED-cube simulator and pattern-authoring tool.** Designed around a 10×10×10 WS2815 cube driven by an ESP32, and parameterised over independent `Nx × Ny × Nz` + physical pitch — the same stack works for non-cubic builds (e.g. a 10×10×3 stack of panels) and scales up as you add more hardware.

Write a pattern in plain JavaScript. Drop it into `patterns/`. It hot-reloads and starts rendering in a React-Three-Fiber viewport with bloom glow and billboarded-shader LEDs. Tune color, power, wiring, and audio-reactivity from side panels. Stream frames to real hardware over WLED UDP (DDP) or USB serial, or bake them into a standalone FastLED `.ino` that runs without a host.

Built on **Tauri 2**, so it ships as a single native binary — no web server, no Electron shell — with direct access to serial ports and UDP sockets.

```
┌─────────────┬──────────────────────────────────────┬─────────────┐
│  Library    │                                      │  Params     │
│             │                                      │  Color      │
│  (pattern   │         3D Viewer (R3F + bloom)      │  Power      │
│   list,     │         orbit • zoom • presets       │  Audio      │
│   hot-      │                                      │  Output     │
│   reload)   │                                      │  Structure  │
└─────────────┴──────────────────────────────────────┴─────────────┘
```

---

## Table of contents

1. [Highlights](#highlights)
2. [Stack](#stack)
3. [Quick start](#quick-start)
4. [Controls](#controls)
5. [Pattern library](#pattern-library)
6. [Writing a pattern](#writing-a-pattern)
7. [The viewer](#the-viewer)
8. [Color pipeline](#color-pipeline)
9. [Power & ABL](#power--abl)
10. [Audio](#audio)
11. [Wiring](#wiring)
12. [Transports](#transports)
13. [Snapshots & presets](#snapshots--presets)
14. [Per-frame pipeline](#per-frame-pipeline)
15. [Repo layout](#repo-layout)
16. [Testing](#testing)
17. [Building a release](#building-a-release)
18. [Hardware notes](#hardware-notes)
19. [Troubleshooting](#troubleshooting)
20. [Project phases](#project-phases)
21. [Roadmap](#roadmap)
22. [License](#license)

---

## Highlights

- **Hot-reloaded JavaScript patterns.** Save a `.js` file in `patterns/` — the `notify` watcher picks it up, the runtime dynamic-imports from a Blob URL, and the viewer starts rendering inside ~50 ms. No restart, no rebuild.
- **Two pattern APIs.** A pure function-per-voxel tier (easy to generate with LLMs) and a stateful class tier (particles, simulations, trails).
- **22 built-in patterns** across 5 categories — classics, particles, audio-reactive, spatial, and debug.
- **Custom shader-billboarded LEDs.** Each LED is a world-sized quad with a bright core + soft halo falloff, additively blended and fed into the bloom post-pass. Looks like photographs of real LED cubes rather than smooth spheres.
- **Full color pipeline.** Per-channel brightness, gamma LUT, optional auto-dim ABL (pre/post readouts), configurable color order (RGB/GRB/BGR/…), all applied in one pass per frame.
- **Realistic WS2815 power model.** 20 mA/channel × 12 V live estimate, rolling power-readout panel, optional automatic budget clamping.
- **Audio-reactive.** `getUserMedia` → `AnalyserNode` → 3 log-bucketed bands + beat detector. Exposed to patterns as `ctx.audio`.
- **Three hardware output paths.** WLED UDP (DDP), USB serial with CRC-protected protocol + provided ESP32 firmware, and one-shot FastLED export that bakes a pattern into a looping PROGMEM sketch.
- **Wiring-path overlay.** Configure your mesh's serpentine/layer-order/entry-corner — a red→blue polyline traces the actual physical path of the strip through the cube so you can verify against your build.
- **Keyboard shortcuts, PNG snapshots, session presets** — everything you need to iterate on a pattern quickly.

---

## Stack

| Layer              | Choice                                           |
|--------------------|--------------------------------------------------|
| Shell              | Tauri 2                                          |
| UI                 | React 18.3 + Vite 5.4 + TypeScript 5.6 (strict)  |
| 3D                 | @react-three/fiber 8 + three 0.169 + drei 9      |
| Post-FX            | @react-three/postprocessing (Bloom, Vignette)    |
| LED primitive      | Custom `ShaderMaterial` on `THREE.Points`        |
| State              | Zustand 5                                        |
| Styling            | Hand-written CSS (no Tailwind)                   |
| Native             | Rust (notify, serialport, UdpSocket, tokio)      |
| Firmware           | Arduino + FastLED (ESP32 target, WS2815)         |
| Testing            | Vitest (unit) + `tsc --noEmit` + `cargo check`   |
| Package manager    | pnpm                                             |

---

## Quick start

```bash
pnpm install
pnpm tauri dev
```

First launch takes a minute or two for the Rust crate compile. Subsequent launches are instant. The dev server hot-reloads React; patterns under `patterns/` hot-reload via the `notify` watcher without restart.

### If `pnpm` isn't on your PATH (Windows)

Corepack ships with Node 16.9+ but the `pnpm` shim often isn't on PATH after `npm install -g pnpm`. Either:

```bash
npm run tauri dev        # uses the local npm-script wrapper
# or
corepack pnpm tauri dev  # uses the node-bundled shim
```

### Run the tests

```bash
pnpm test           # one-shot
pnpm test:watch     # watch mode
tsc --noEmit        # type check
cd src-tauri && cargo check
```

---

## Controls

### Keyboard

| Key    | Action                                              |
|--------|-----------------------------------------------------|
| `1`–`4`| Camera preset: Front / Side / Top / Isometric       |
| `B`    | Cycle structure mode: clean → ghost → full          |
| `W`    | Toggle wiring-path overlay                          |
| `S`    | Save snapshot PNG (opens native save dialog)        |
| `,` `.`| Previous / next pattern in the library              |
| `R`    | Reload active pattern                               |
| `?`    | Show keyboard help overlay                          |
| `Esc`  | Close help overlay                                  |

The keydown handler ignores modifier keys (so OS shortcuts like Ctrl+S work) and ignores input/textarea/contenteditable targets (so typing a preset name doesn't steer the camera).

### Mouse

- **Drag** — orbit camera
- **Right-drag / Shift-drag** — pan
- **Scroll** — dolly

All three go through drei's `OrbitControls`. Camera preset buttons (or `1`–`4`) tween between four canonical angles.

---

## Pattern library

Twenty-two built-in patterns organised by category. All are plain `.js` files under `patterns/<category>/` — read them, fork them, delete them, write new ones.

### Classics

- **plasma** — Three-axis sine interference with radial / linear / sphere modes and a two-color blend.
- **rainbow-wave** — Planar rainbow sweep along an arbitrary 3D direction.
- **fire** — Perlin-noise-driven upward flame with cooling gradient.
- **noise-field** — Drifting Perlin slab with colour cycling.
- **metaballs** — 1/r² scalar field with smoothstep isosurface and per-blob hue blending at merge seams.
- **life3d** — Bays' B5678/S45678 and 4 other rules on the 26-cell Moore neighborhood (toroidal wrap). Age-based coloring + auto-reseed.
- **tetris3d** — Auto-playing 3D Tetris with 6 tetracubes (including a 3D-only tripod). Full XZ-layer clears flash white then collapse.

### Particles

- **rain** — Downward drops with upward-fading trails and optional splash rings on the floor.
- **snow** — Slow drift with per-flake wobble.
- **sparks** — Rising sparks with random walks, gravity tail.
- **meteors** — Horizontal streaks with long exponential tails.
- **fireworks** — Rockets arcing up, then spherical shell bursts with embers.
- **fireworks-chrysanthemum** — Ring-pattern shells where each primary shard fires a secondary mini-burst mid-flight.

### Spatial

- **sweeping-plane** — Bright plane that sweeps along a chosen axis.
- **rotating-cube** — Wireframe cube rotating around all three axes.
- **expanding-spheres** — Pulsing shell surfaces at varying phases.
- **hilbert-curve** — Animated head tracing a true 3D Hilbert curve (Skilling's transposed-axes algorithm), with optional faint full-curve rainbow revealing the volumetric fractal.
- **hypercube** — Rotating 4D tesseract (XW + ZW + XY rotations) with perspective projection; edges colored by W-depth.

### Audio-reactive

- **spectrum-cube** — FFT bins mapped across one axis, magnitudes along the other two.
- **beat-pulse** — Cube-wide flash on beat detection with exponential decay.
- **vu-bars** — Three classic bars driven by low/mid/high band energies.

### Debug

- **stream-probe** — Wiring-verification head that sweeps through LEDs in stream order. Pair with the wiring-path overlay to visually confirm your mesh config is correct before burning it into firmware.

---

## Writing a pattern

Drop a `.js` file into `patterns/<category>/<name>.js`. Export a default pattern in one of two forms.

### Function API (stateless per-voxel)

```js
export const params = {
  speed: { type: 'range', min: 0, max: 4, step: 0.01, default: 1 },
  tint:  { type: 'color', default: '#ff7700' },
};

export default {
  name: 'My Pattern',           // optional; defaults to the filename
  render(ctx, xyz) {
    const { t, Nx, Ny, Nz, params, audio, power, utils } = ctx;
    const { x, y, z, u, v, w, cx, cy, cz, i } = xyz;
    // ...
    return [r, g, b];           // 0..255
  },
};
```

`xyz` exposes three coordinate forms so your math can pick whichever fits:

| Field         | Range       | Meaning                                        |
|---------------|-------------|------------------------------------------------|
| `x`, `y`, `z` | `0..Nx-1` / `0..Ny-1` / `0..Nz-1` | Integer lattice indices      |
| `u`, `v`, `w` | `0..1`      | Normalised position per axis                   |
| `cx`, `cy`, `cz` | `-1..1`  | Centered — zero is the volume's middle         |
| `i`           | `0..Nx·Ny·Nz-1` | Flattened logical index (`x·Ny·Nz + y·Nz + z`) |

### Class API (stateful, particles / sims)

```js
export const params = { count: { type: 'int', min: 1, max: 400, default: 80 } };

export default class Rain {
  static name = 'Rain';
  setup(ctx)       { this.drops = []; /* ... */ }
  update(ctx)      { /* mutate state using ctx.dt */ }
  render(ctx, out) { /* write out[i*3+0..2] for each logical i (0..255) */ }
}
```

The runtime picks the class API if the default export is a constructor whose prototype has `render`. The instance is created once per activation; `setup()` runs on activation and on every hot-reload. `update()` is optional but lets you keep sim-stepping separate from drawing.

### Render context

```ts
{
  t:     number,              // seconds since pattern activated
  dt:    number,              // seconds since last frame
  frame: number,              // integer frame counter from 0
  Nx:    number,              // per-axis grid dimensions
  Ny:    number,
  Nz:    number,
  N:     number,              // max(Nx, Ny, Nz) — convenience for cube-shaped math
  params: Record<string, any>,
  audio: {
    energy: number,           // [0, 1] RMS
    low: number, mid: number, high: number,  // [0, 1] per band
    beat: boolean,            // pulse = one frame after threshold crossing
  },
  power: {
    amps: number, watts: number,
    budgetAmps: number, scale: number,
  },
  utils: {
    clamp(v, lo, hi),
    smoothstep(a, b, v),
    mix(a, b, t),             // a/b: hex string or [r,g,b] 0..255
    hsv(h, s, v),             // returns [r, g, b] 0..255
    noise3d(x, y, z),         // deterministic 3D value noise
    parseColor(hex | [r,g,b]),
  },
}
```

### Parameter types

| Type       | Example                                                                |
|------------|------------------------------------------------------------------------|
| `range`    | `{ type: 'range', min: 0, max: 4, step: 0.01, default: 1, label: 'Speed' }` |
| `int`      | `{ type: 'int', min: 1, max: 40, default: 5 }`                         |
| `color`    | `{ type: 'color', default: '#ffffff' }`                                |
| `toggle`   | `{ type: 'toggle', default: true }`                                    |
| `select`   | `{ type: 'select', options: ['a', 'b', 'c'], default: 'a' }`           |

Param values persist across reloads per-pattern. When you rename or retype a param, its old value is dropped and the new default takes over — other params reconcile so your sliders keep their positions.

---

## The viewer

### LED primitive

Each LED is a `THREE.Points` vertex rendered through a custom `ShaderMaterial`:

- **Vertex shader** manually replicates perspective-correct size attenuation so `uSizeMeters` stays in world units. Set it from cube `spacing()` and the LED holds its physical size as the camera orbits.
- **Fragment shader** discards outside the unit disk, then emits a two-stop radial falloff — a sharp core (smoothstep 0.55→0) for the "LED die" plus a long soft halo (`exp(-r²·3)`). The core is boosted ×1.6 so dim post-ABL colors still read as a point of light.
- **Additive blending** lets overlapping halos stack, and the whole primitive feeds the bloom threshold-luminance pass naturally.

This replaced a prior `InstancedMesh` of low-poly spheres — at 1000 LEDs that was 48k triangles, and silhouettes flickered at grid-aligned angles. Points: ~2k triangles and no aliasing.

### Structure overlay

Three modes (`B` to cycle):

- **clean** — LEDs only
- **ghost** — LEDs + faint wireframe cube showing the build envelope
- **full** — LEDs + solid cube wireframe with subtle crosshatch

### Wiring-path overlay

Press `W` to draw a polyline through all LEDs in **stream order** — the physical path your strip takes through the mesh based on the current wiring config. The line is colored red → blue along its length so you can see the start and end. Toggle serpentine / corners / layer-order in the Structure panel and the line visibly reroutes.

### Camera presets

`1`–`4` tween to Front / Side / Top / Isometric. The tween is driven by drei's camera-target mechanism so orbit state is preserved during flight.

---

## Color pipeline

All per-frame transforms happen in one pass inside `bakeFrame()` (in `src/core/colorPipeline.ts`):

```
patternBuf (0..255)                                              ┐
   → duty    = patternBuf × brightness                           │ power estimate
   → ABL     = duty scaled so total amps ≤ budget (optional)     │
   → gamma   = 256-entry LUT (rebuilt only when gamma changes)   │ perceptual
   → shuffle = 3-tuple permute (RGB / GRB / BGR / …)             │ match strip
   → Float32 color attribute (what the shader reads)             │
   → Uint8   stream bytes (what the transport sends)             │ (if connected)
```

The float and byte outputs are written in the same loop so there's no extra iteration when a transport is live. The Float32 attribute is what THREE reads on the GPU — the shader expects [0, 1] per channel.

Gamma defaults to 2.2. The LUT is regenerated only when `colorCfg.gamma` changes, so the hot path does nothing on a normal frame.

---

## Power & ABL

WS2815 draws ~20 mA per channel at full duty @ 12 V. `estimatePower` sums the brightness-scaled duty buffer, divides by (255 / 0.020) to get amps, multiplies by 12 V for watts, then — depending on mode — either warns or returns a scale factor ≤ 1 that will bring draw under the configured budget.

Three modes, chosen in the Power panel:

- **off** — reports live draw, never dims.
- **warn** — reports + flags `overBudget` in the UI, never dims.
- **auto-dim** — returns a scale factor that clamps draw to budget.

The panel shows both numbers when ABL is active:

```
Pre-ABL (what the pattern wanted):   4.3 A / 52 W
Post-ABL (what the strip pulls):     2.0 A / 24 W    (scale 47%, saved 2.3 A)
```

Live numbers are pushed to Zustand every 8th frame (~7.5 Hz @ 60 fps) to avoid React churn in the hot path.

---

## Audio

`getUserMedia({ audio: true })` → `AudioContext` → `AnalyserNode` (`fftSize: 512`). Mic is opt-in per-session from the Audio panel — no auto-grab.

Every frame, `audioEngine.update()` computes:

- **energy** — overall RMS
- **low / mid / high** — three log-bucketed band averages
- **beat** — rolling-mean threshold crossing; true for a single frame when crossed

The Audio panel shows a live log-spectrum canvas (drawn directly with `requestAnimationFrame` outside React) and the three band readouts. All four values are exposed to patterns as `ctx.audio`.

---

## Wiring

A wiring **address map** converts a logical `(x, y, z)` to its position in the physical LED strip (stream order). The map is a bijection over `[0, Nx·Ny·Nz)` for any rectangular shape.

The Structure panel exposes the knobs:

| Setting            | Effect                                                  |
|--------------------|---------------------------------------------------------|
| `Nx`, `Ny`, `Nz`   | Per-axis voxel counts. Y is up; Z grows with panel depth|
| `pitchMeters`      | Physical LED-to-LED spacing (single uniform value)      |
| `layerOrder`       | bottom-up vs top-down (which Y first)                   |
| `layerStart`       | entry corner per layer (00 / N0 / 0N / NN)              |
| `rowDirection`     | within-layer inner counter runs along X or Z            |
| `serpentine`       | flip inner counter every other row                      |
| `layerSerpentine`  | flip entry corner every other layer                     |

Turn on the wiring-path overlay (`W`) and tweak the knobs — the polyline redraws in real time. Once you're confident it matches your physical build, it's safe to stream or bake.

The `stream-probe` debug pattern is the intended pairing: it sweeps a bright head along the logical index order, so with the overlay on you can watch the head ride along the polyline and spot mismatches instantly.

---

## Transports

All three share the same `OutputConfig`. Streaming transports (`wled`, `serial`) go through a `TransportManager` singleton that rate-limits to `sendIntervalMs` (default 20 ms ≈ 50 fps), maintains a rolling 1-second FPS window, and swallows send errors into `droppedFrames` so the render loop never crashes on a network blip.

### WLED UDP (DDP) — port 4048

10-byte DDP header followed by RGB payload:

```
[0x41][seq][0x01][0x01][offset_be×4][len_be×2] + rgb bytes
```

Arbitrary-length frames fit in a single logical datagram (IP fragmentation is transparent on LAN). Rust binds `UdpSocket::bind("0.0.0.0:0")` once and `send_to`s per frame.

### USB serial — framed custom protocol with CRC

```
0xCC 0xBE  len_hi len_lo  rgb_bytes...  crc_hi crc_lo
```

CRC is **CRC-16/CCITT-FALSE** (poly `0x1021`, init `0xFFFF`, no reflection, no xorout). Magic prefix resyncs on byte loss. Host baud defaults to 921 600.

The firmware (`firmware/esp32_serial_receiver/`) does the minimum:
- Parses the frame (state machine over magic, len, payload, CRC).
- On CRC match: `memcpy` the payload into the FastLED buffer and `show()`.
- On CRC mismatch: increment a counter, emit `[0xFE 0xED cnt_hi cnt_lo]` back over serial.

The host reads those status frames in the serial-send response and surfaces the mismatch count in the Output panel (tinted red when > 0). Host is authoritative for brightness / gamma / ABL / color order / wiring — the firmware is dumb on purpose.

### FastLED export — one-shot bake

Not a streaming transport: a Bake button that:

1. Runs the active pattern synchronously for `seconds × fps` frames.
2. Bakes each frame through the full color + power pipeline via `bakeFrame`.
3. Emits a PROGMEM 2-D `uint8_t` array plus a looping `.ino` sketch.
4. Writes to `exports/<stem>_<timestamp>.ino` via the `write_export` Rust command.

The baked sketch runs without a host. Live size estimate in the panel (`Nx·Ny·Nz × 3 × frames` bytes + header). The generated `.ino` emits `#define NX`, `#define NY`, `#define NZ` so the firmware-side layout matches whatever shape you simulated.

---

## Snapshots & presets

### Snapshot PNG

Press `S` (or click Snapshot in the toolbar). A native save dialog opens; the Canvas's backing framebuffer is read via `toDataURL()` and written to disk through the `snapshot_write` Rust command. Because the Canvas is created with `preserveDrawingBuffer: true`, you get the full post-processed image — bloom, vignette, the works — not the raw LED colors.

In a non-Tauri browser build, the PNG is offered as a download via a blob URL instead.

### Session presets

Each pattern has its own preset list (dropdown in the Params panel). Click **Save**, type a name → the current param values are snapshotted. Click **Delete** to remove. Presets live in-memory for the session only — they're not persisted across restarts (intentional: they're meant for iteration, not config).

---

## Per-frame pipeline

Simplified trace of what `useFrame` in `Cube.tsx` does every tick:

```
1. audioEngine.update(nowMs)            — fresh FFT bins + beat flag
2. store.getState() snapshot            — single read so UI changes don't re-enter
3. renderPatternFrame(pattern, ctx,
                      coords, patternBuf)  — pattern writes 0..255 RGB (logical)
4. computeDuty(patternBuf, brightness,
               dutyBuf)                  — brightness-scaled for power model
5. estimatePower(dutyBuf, powerCfg)      — pre-ABL amps + scale factor
6. bakeFrame(patternBuf, colorCfg, lut,
             ablScale, addressMap,
             floatOut, streamBuf)        — gamma + ABL + color-order shuffle;
                                          writes Float32 for the shader AND
                                          Uint8 stream bytes in one pass
7. transportManager.trySend(streamBuf)   — only if a transport is live
8. every 8th frame: push powerLive to
   Zustand (pre + post ABL)              — keeps the readout at ~7.5 Hz
```

Hot state is read once via a single `getState()` snapshot so unrelated UI changes don't force the Cube component to re-render mid-stream. Every buffer (`patternBuf`, `dutyBuf`, `streamBuf`, the Float32 color attribute) is pre-allocated outside the loop — nothing is allocated in the hot path.

---

## Repo layout

```
src/
  App.tsx                         three-panel layout + per-panel ErrorBoundary
  App.css                         all styles (flat, scoped by class)
  main.tsx
  components/
    ErrorBoundary.tsx             generic React boundary with reset
    ShortcutsHelp.tsx             keyboard-help modal (data from SHORTCUTS table)
    Library/LibraryPanel.tsx      pattern list + hot-reload status
    Structure/StructurePanel.tsx  Nx/Ny/Nz, pitch, wiring config, overlay toggle
    Params/ParamsPanel.tsx        color + schema-driven params + presets
    Power/PowerPanel.tsx          mode, budget, live pre/post ABL readouts
    Audio/AudioPanel.tsx          mic toggle, log-spectrum canvas, band readouts
    Output/OutputPanel.tsx        transport select, per-kind config, stats, CRC
    Viewer/
      Viewer.tsx                  Canvas + camera presets + structure mode toggle
      Cube.tsx                    Points primitive + per-frame render loop
      ledPointsMaterial.ts        custom ShaderMaterial for billboard LEDs
      SnapshotHandler.tsx         S-key listener, canvas capture, save dialog
      StructureOverlay.tsx        ghost/full wireframe
      WiringPathOverlay.tsx       polyline through LEDs in stream order
      cameraPresets.ts            front/side/top/iso tween targets
  core/
    audio.ts                      getUserMedia → AnalyserNode + beat detector
    colorPipeline.ts              gamma LUT + bakeFrame (float + bytes in one pass)
    cubeGeometry.ts               CubeSpec {Nx,Ny,Nz,pitchMeters}, buildCoords,
                                  ledCount, spacing, edges, voxelIndex
    keyboardShortcuts.ts          SHORTCUTS table + window keydown dispatcher
    patternApi.ts                 module contract + adapter for fn/class APIs
    patternRender.ts              calls pattern for one frame, writes patternBuf
    patternRuntime.ts             Blob+URL dynamic-import loader + watcher wiring
    power.ts                      per-channel mA → amps estimator + ABL scaler
    power.test.ts                 Vitest unit tests
    usePatternHost.ts             watch patterns/, debounce + reload on change
    utils.ts                      clamp/smoothstep/mix/hsv/noise3d for patterns
    wiring.ts                     logical↔stream address map + stream-path builder
    wiring.test.ts                Vitest unit tests
    transports/
      fastledExport.ts            bake frames → PROGMEM array → .ino sketch
      index.ts                    TransportManager + rate limiter + stats
      serial.ts                   framed protocol + CRC-16/CCITT-FALSE
      serial.test.ts              Vitest unit tests
      wledUdp.ts                  DDP over UDP (10-byte header)
  state/store.ts                  single Zustand store (all slices)

patterns/
  audio/                          beat-pulse, spectrum-cube, vu-bars
  classics/                       fire, noise-field, plasma, rainbow-wave,
                                  metaballs, life3d, tetris3d
  debug/                          stream-probe
  particles/                      fireworks, fireworks-chrysanthemum, meteors,
                                  rain, snow, sparks
  spatial/                        expanding-spheres, rotating-cube, sweeping-plane,
                                  hypercube, hilbert-curve

src-tauri/
  src/lib.rs                      Tauri commands (wled_send, serial_*, snapshot_*,
                                  list_patterns, read_pattern, watch_patterns_dir,
                                  write_export, patterns_root)
  Cargo.toml                      tauri, serialport, notify, serde, tokio
  tauri.conf.json

firmware/
  esp32_serial_receiver/          FastLED receiver — state machine, memcpy, show,
                                  CRC-mismatch status reporting

exports/                          output directory for baked .ino sketches
```

---

## Testing

Three kinds of check, none of them slow:

```bash
pnpm test            # Vitest — unit tests for pure core
tsc --noEmit         # TypeScript strict-mode gate
cd src-tauri && cargo check
```

The Vitest suites cover the parts where a bug would quietly corrupt output:

- **`power.test.ts`** — brightness scaling, per-channel mA math, ABL scale factor at and over budget, color-order permutations.
- **`wiring.test.ts`** — address-map bijection across every corner / serpentine combo for both cubic and non-cubic shapes (including 10×10×3 and all-distinct-prime shapes).
- **`serial.test.ts`** — frame build, CRC-16/CCITT-FALSE vectors, status-reply parser on split payloads.

No integration tests — the viewer lives in Tauri and driving it from CI is more pain than it's worth for a single-maintainer project. The pattern runtime is defensively try/caught at every entry point (`setup`, `update`, `render`) so a broken user pattern logs an error and disarms itself instead of crashing the app.

---

## Building a release

```bash
pnpm tauri build
```

Produces a signed single-binary installer under `src-tauri/target/release/bundle/`. On Windows that's an MSI; on macOS a DMG; on Linux a `.deb` + `.AppImage`.

The shipped binary looks for `patterns/` under the OS-standard app-data dir (`%APPDATA%/VolumeCube/patterns` on Windows, `~/Library/Application Support/VolumeCube/patterns` on macOS, `~/.config/volumecube/patterns` on Linux). The dev build uses the repo's `patterns/` directly — `patterns_root` is exposed as a Tauri command so the UI knows where to drop new files.

---

## Hardware notes

- WS2815 is **12 V**, not 5 V like WS2812. Do not connect it to a USB 5 V rail.
- Common-ground the ESP32 and the 12 V PSU, then feed the data pin through a 3.3 V → 5 V level shifter (74AHCT125 or similar) before it reaches the strip's DIN.
- WS2815 has a **backup data line (BI)**. Wire strip `i+1`'s BI to strip `i`'s DO so a single failed LED doesn't black out everything downstream — you'll get one dark pixel instead of half the cube.
- Budget real-world amps conservatively: **60 mA/LED at full white × 1000 LEDs = 60 A peak**. A 30 A 12 V PSU is fine for realistic pattern content at ~50% average duty; the ABL limiter will clamp the rare full-white frame.
- The custom serial protocol runs comfortably at 921 600 baud, which maps to ~30 FPS for a 1000-LED cube (3000 bytes payload + 6 overhead per frame). Larger cubes or higher frame rates need a USB-native ESP32 build (ESP32-S2 / S3) at 1 Mbps+.
- WLED DDP over WiFi is fine on clean networks; on congested ones, dropped frames are visible as flicker. Use the dropped-frame counter in the Output panel as your early warning.

---

## Troubleshooting

**Patterns don't appear in the library.** Make sure the file is under `patterns/<subfolder>/` (flat files at the top of `patterns/` also work, grouped under `library`). The watcher debounces at 120 ms — save a second time if the first save was during a rename mid-stream.

**Pattern loaded but the viewport is black.** Check the library-error strip at the top of the Library panel — a thrown error from `setup`, `update`, or `render` disarms the pattern and surfaces the message. Also check the DevTools console (F12) for JS-import errors like "Unexpected token".

**Serial port not listed.** Windows usually needs a driver (CP2102 for Silabs chips, CH340 for WCH chips). After plugging in, click *Rescan ports* in the Output panel.

**WLED connected, no frame on strip.** Verify the ESP32 is running WLED (not the serial receiver sketch) and that DDP is enabled in WLED's Sync settings. Port must match the UI field (4048 default).

**Serial CRC mismatches climbing.** Host and firmware agree that length and CRC are big-endian. If the count rises steadily, first suspect the baud rate — a host at 921 600 talking to a firmware at 115 200 will decode garbage that mostly passes the frame-length check but usually fails the CRC.

**Pattern crashes the viewer.** The ErrorBoundary around the Canvas shows a reset button; pattern errors thrown inside `useFrame` are caught separately in the render loop and disarm the active pattern, logging to the Library panel.

**Black viewport after dev rebuild.** React 18 strict-mode selector cache issue. If a `useAppStore` selector returns a fresh `{}` per call, `useSyncExternalStore` bails. Lift the sentinel to a module-level constant.

**`pnpm` not recognized (Windows).** Corepack's shim is commonly off-PATH. Use `npm run tauri dev` or `corepack pnpm tauri dev`.

---

## Project phases

The build was staged. Each phase is independently testable.

| Phase | Title                       | Deliverables                                                          |
|-------|-----------------------------|-----------------------------------------------------------------------|
| 0     | Scaffolding                 | Tauri app, three-panel layout, empty viewer                           |
| 1     | Cube + viewer               | InstancedMesh, camera presets, structure overlay, bloom               |
| 2     | Pattern runtime             | Function + class API, Blob-URL hot reload, params schema              |
| 3     | Color + power + audio       | Gamma / ABL / shuffle, WS2815 model, mic analyser + beat              |
| 4     | Transports                  | WLED DDP, serial + firmware, FastLED export, wiring config            |
| 5     | Overlay + polish            | Wiring-path polyline, error boundaries                                |
| 6     | v0.2 QoL                    | Keyboard shortcuts, snapshot PNG, session presets, stream-probe       |
| 7     | v0.2 telemetry              | Pre/post-ABL power readout, firmware CRC-mismatch counter             |
| 8     | v0.2 viewer                 | Points + shader billboards replacing InstancedMesh spheres            |

---

## Roadmap

Out-of-scope-for-now items live in `TODO.md`:

- E1.31 / sACN transport
- MIDI input (map to pattern params + trigger beats)
- Webcam input (brightness → audio-like reactivity; optional silhouette → color)
- Non-rectangular volumes (sphere, pyramid, arbitrary mesh with barycentric coords) — rectangular `Nx × Ny × Nz` already works
- Node-graph pattern editor
- Pattern → C++ translation (ship a FastLED binary that runs the exact JS pattern)
- GLSL-3D raymarching pattern primitive (exposes a ShaderToy-style authoring surface)
- Persistent preset store

---

## License

MIT — see [LICENSE](./LICENSE).
