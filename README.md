# VolumeCube

Volumetric LED-cube simulator and pattern authoring tool. Designed around a 10×10×10 WS2815 cube driven by an ESP32, but parameterised over `N` so the same stack works for any N×N×N build.

Write a pattern in plain JavaScript, see it rendered live in a R3F viewport with bloom, tune color/power/wiring from side panels, and stream frames to real hardware over WLED UDP (DDP) or USB serial — or bake the pattern into a standalone FastLED `.ino` that runs without a host computer.

Built on Tauri 2 so it ships as a single native binary (no web server, no Electron) with direct access to serial ports and UDP sockets.

---

## Stack

| Layer              | Choice                                           |
|--------------------|--------------------------------------------------|
| Shell              | Tauri 2                                          |
| UI                 | React 18.3 + Vite 5.4 + TypeScript 5.6 (strict)  |
| 3D                 | @react-three/fiber 8 + three 0.169 + drei 9      |
| Post-FX            | @react-three/postprocessing (Bloom, Vignette)    |
| State              | Zustand 5                                        |
| Styling            | Hand-written CSS (no Tailwind)                   |
| Native             | Rust (notify, serialport, UdpSocket)             |
| Firmware           | Arduino-FastLED (ESP32 target, WS2815)           |
| Package manager    | pnpm                                             |

No test runner in v1 — `tsc --noEmit` is the correctness gate.

---

## Layout

```
src/
  App.tsx                         three-panel layout + per-panel ErrorBoundary
  main.tsx
  App.css                         all styles (flat, scoped by class)
  components/
    ErrorBoundary.tsx             generic React boundary with reset
    Library/LibraryPanel.tsx      pattern list + hot-reload status
    Structure/StructurePanel.tsx  N, edge length, wiring config, overlay toggle
    Params/ParamsPanel.tsx        color subsection + schema-driven pattern params
    Power/PowerPanel.tsx          mode, budget, live amps/watts
    Audio/AudioPanel.tsx          mic toggle, log-spectrum canvas, band readouts
    Output/OutputPanel.tsx        transport select + per-kind config + stats
    Viewer/
      Viewer.tsx                  Canvas + camera presets + structure mode toggle
      Cube.tsx                    InstancedMesh + per-frame render loop
      StructureOverlay.tsx        ghost/full wireframe
      WiringPathOverlay.tsx       polyline through LEDs in stream order
      cameraPresets.ts            front/side/top/iso tween targets
  core/
    cubeGeometry.ts               buildPositions, buildCoords, ledCount, spacing
    patternApi.ts                 module contract + LoadedPattern adapter
    patternRuntime.ts             Blob+URL dynamic-import loader
    usePatternHost.ts             watch patterns/, reload on change
    colorPipeline.ts              gamma LUT + bakeLinearFloats + bakeStreamBytes
    power.ts                      per-channel mA → amps estimator + ABL scaler
    audio.ts                      getUserMedia → AnalyserNode + beat detector
    wiring.ts                     logical↔stream address map + stream-path builder
    transports/
      index.ts                    TransportManager singleton + rate limiter + stats
      wledUdp.ts                  DDP over UDP (10-byte header)
      serial.ts                   framed protocol + CRC-16/CCITT-FALSE
      fastledExport.ts            bake frames → PROGMEM array → .ino sketch
    utils.ts                      clamp/smoothstep/mix/hsv/noise3d for patterns
  state/store.ts                  single Zustand store for all slices

patterns/
  classics/                       plasma, rainbow-wave, fire, noise-field
  particles/                      rain, snow, sparks, fireworks, meteors
  audio/                          spectrum-cube, beat-pulse, vu-bars
  spatial/                        sweeping-plane, rotating-cube, expanding-spheres

src-tauri/
  src/lib.rs                      Tauri commands (wled_send, serial_*, write_export)
  Cargo.toml                      tauri, serialport, notify, serde
  tauri.conf.json

firmware/
  esp32_serial_receiver/          FastLED receiver — state machine + memcpy + show

exports/                          output dir for baked .ino sketches
```

---

## Quick start

```bash
pnpm install
pnpm tauri dev
```

First launch takes a minute or two for the Rust crate compile. Subsequent launches are instant. The dev server hot-reloads React; patterns under `patterns/` hot-reload via a `notify` watcher (no restart).

Build a release bundle:

```bash
pnpm tauri build
```

---

## Concepts

### Coordinate system

Y is up. Each 10×10 mesh layer is an XZ plane stacked along Y. The canonical logical index is:

```
logical = x * N² + y * N + z
```

All internal buffers (pattern output, duty buffer, color float buffer) are in **logical order**. The wiring address map produces **stream order** only on the path to a transport.

Positions are centered on the origin: `pos = (x - (N-1)/2) * spacing`, where `spacing = edgeMeters / (N - 1)`.

### Pattern API

Two tiers, both plain ES modules dropped in `patterns/<category>/<name>.js`.

**Function API** — pure per-voxel, easy to LLM-generate:

```js
export const params = {
  speed: { type: 'range', min: 0, max: 4, default: 1 },
  tint:  { type: 'color', default: '#ff7700' },
};

export default {
  name: 'Plasma',
  render(ctx, xyz) {
    // ctx.t, ctx.dt, ctx.frame, ctx.N, ctx.params, ctx.audio, ctx.power, ctx.utils
    // xyz.{x,y,z,u,v,w,cx,cy,cz,i}
    return [r, g, b]; // 0..255
  },
};
```

**Class API** — stateful (particles, trails, simulations):

```js
export const params = { count: { type: 'int', min: 1, max: 400, default: 80 } };

export default class Rain {
  static name = 'Rain';
  setup(ctx)       { this.drops = []; }
  update(ctx)      { /* advance state */ }
  render(ctx, out) { /* write out[i*3+0..2] for each logical i */ }
}
```

The runtime distinguishes them by whether the default export is a constructor with `render` on its prototype. Class instances are created once per pattern activation; `setup()` runs on activation and on every hot-reload.

### Color pipeline

Per-frame order inside `Cube.tsx`:

1. Pattern writes 0..255 RGB into `patternBuf` (logical order).
2. Duty buffer = `patternBuf * brightness` (pre-gamma) — used for power estimate.
3. `estimatePower(duty, powerCfg)` → pre-ABL amps + scale factor.
4. `bakeLinearFloats` writes to the `instanceColor` float buffer: `brightness → gamma LUT → ABL scale → color-order shuffle` in one pass.
5. If a transport is connected: `bakeStreamBytes` performs the same pipeline but outputs 8-bit bytes into `streamBuf` at stream-order positions, then `transportManager.trySend()` ships it.

The gamma LUT is cached and only rebuilt when `colorCfg.gamma` changes.

### Power / ABL

WS2815 is modelled as ~20 mA per channel at full duty, 12 V. `estimatePower` sums the duty buffer, converts to amps, then either warns or returns a scale factor (`auto-dim` mode) to clamp draw to the configured budget.

Three modes:
- **off** — reports draw, never dims
- **warn** — reports draw, flags `overBudget` in the UI, never dims
- **auto-dim** — returns a scale factor ≤ 1 that brings draw under budget

Live numbers pushed to Zustand every 8th frame (~7.5 Hz at 60 fps) to avoid React churn in the hot path.

### Audio

`getUserMedia({ audio: true })` → `AudioContext` → `AnalyserNode` (fftSize=512). `audioEngine.update()` runs once per frame and computes:

- `energy` — overall RMS
- `low` / `mid` / `high` — three log-bucketed band averages
- `beat` — rolling-mean threshold crossing (one-frame pulse)

Mic access is opt-in per-session from the Audio panel. The spectrum canvas draws directly with `requestAnimationFrame` outside React to avoid per-frame re-renders.

### Wiring

Address map converts `logical → stream` and is a bijection over `[0, N³)`. Config covers the common mesh permutations:

| Setting            | Effect                                                |
|--------------------|-------------------------------------------------------|
| `layerOrder`       | bottom-up vs top-down (which Y first)                 |
| `layerStart`       | entry corner per layer (00 / N0 / 0N / NN)            |
| `rowDirection`     | within-layer inner counter runs along X or Z          |
| `serpentine`       | flip inner counter every other row                    |
| `layerSerpentine`  | flip entry corner every other layer                   |

The Wiring Path overlay (Structure → Show wiring path) draws a polyline through all LEDs in stream order, colored red→blue along the path. Toggle serpentine / corners and the line visibly reroutes.

### Transports

All three share the same `OutputConfig`. The streaming ones (`wled`, `serial`) go through `transportManager` which rate-limits to `sendIntervalMs` (default 20 ms ≈ 50 fps), maintains a rolling 1-second fps window, and swallows send errors into `droppedFrames` so the render loop never crashes on a network blip.

**WLED UDP (DDP)** — port 4048 by default. 10-byte header:

```
[0x41][seq][0x01][0x01][offset_be×4][len_be×2]  + rgb payload
```

DDP supports arbitrary-length frames in a single logical datagram; IP fragmentation is transparent on LAN. Rust side binds `UdpSocket::bind("0.0.0.0:0")` once and `send_to`s per frame.

**USB serial** — framed custom protocol with CRC:

```
0xCC 0xBE  len_hi len_lo  rgb_bytes...  crc_hi crc_lo
```

CRC is CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflection, no xorout). Magic prefix resyncs on byte loss. Host baud defaults to 921 600. The ESP32 firmware in `firmware/esp32_serial_receiver/` does the minimum — it `memcpy`s the payload straight into the FastLED buffer and calls `show()`. Host is authoritative for brightness / gamma / ABL / color order / wiring.

**FastLED export** — not a streaming transport, a one-shot bake:

1. Run the active pattern synchronously for `seconds × fps` frames.
2. Bake each frame through the full color/power pipeline via `bakeStreamBytes`.
3. Emit a PROGMEM 2-D `uint8_t` array and a looping `.ino` sketch.
4. Write to `exports/<stem>_<timestamp>.ino` via the `write_export` Rust command.

The baked sketch runs without a host. Size estimate is shown live in the panel (`N³ × 3 × frames` bytes + a small header).

---

## Hardware notes

- WS2815 is a 12 V strip (not 5 V like WS2812). **Don't** connect it to a USB 5 V rail.
- Common-ground the ESP32 and the PSU ground, then feed the data pin through a 3.3 V → 5 V level shifter (74AHCT125 or similar) before it reaches the strip's DIN.
- WS2815 has a backup data line (BI). Wire strip `i+1`'s BI to strip `i`'s DO so a single LED failure doesn't black out everything downstream.
- Budget real-world amps conservatively: 60 mA/LED at full white × 1000 LEDs = 60 A peak. A 30 A 12 V PSU is fine for realistic pattern content at ~50 % average duty; the ABL limiter will clamp the rare full-white frame.

---

## Project phases

The build was staged. Each phase is independently testable.

| Phase | Title                   | Deliverables                                                          |
|-------|-------------------------|-----------------------------------------------------------------------|
| 0     | Scaffolding             | Tauri app, three-panel layout, empty viewer                           |
| 1     | Cube + viewer           | InstancedMesh, camera presets, structure overlay, bloom               |
| 2     | Pattern runtime         | Function+class API, Blob-URL hot reload, params schema                |
| 3     | Color + power + audio   | Gamma/ABL/shuffle, WS2815 model, mic analyser + beat                  |
| 4     | Transports              | WLED DDP, serial + firmware, FastLED export, wiring config            |
| 5     | Overlay + polish        | Wiring-path polyline, viewer + panel error boundaries                 |

Out-of-scope items (E1.31/sACN, MIDI, webcam input, non-cubic volumes, node-graph editor, pattern-to-C++ translation, etc.) are tracked in `TODO.md`.

---

## Writing a pattern

1. Create `patterns/<category>/<name>.js`.
2. Export a default following either API tier above.
3. Save. The notify watcher reloads within ~50 ms; param sliders reconcile so only renamed/retyped params lose their values.

Inside `ctx.utils`:

- `clamp(v, lo, hi)`
- `smoothstep(a, b, v)`
- `mix(a, b, t)` — `a`/`b` can be `'#rrggbb'` or `[r,g,b]`
- `hsv(h, s, v)` — returns `[r, g, b]` in 0..255
- `noise3d(x, y, z)` — seeded 3D value noise

`ctx.audio` is always populated; bands read zero when the mic is off. `ctx.power` reflects the *previous* frame (one-frame stale) — safe for brightness-compensated effects.

---

## Troubleshooting

- **Black viewport after dev rebuild.** Strict-mode selector cache issue. If a `useAppStore` selector returns a fresh `{}` per call, React 18's `useSyncExternalStore` bails out. Lift the sentinel to a module-level constant.
- **Serial port not listed.** Windows sometimes needs a driver (CP2102, CH340) for the USB-to-UART chip. After plugging in, click *Rescan ports* in the Output panel.
- **WLED connected, no frame on strip.** Check that the ESP32 is running WLED (not the serial receiver sketch) and that DDP is enabled in WLED's Sync settings. Port must match (4048 default).
- **Serial CRC mismatches.** Make sure firmware BAUD_RATE matches the host; protocol is little-endian on length? No — length and CRC are both big-endian. Firmware and host agree.
- **Pattern crashes the viewer.** The ErrorBoundary around the Canvas shows a reset button; pattern errors thrown inside `useFrame` are caught separately and disarm the active pattern, logging to the Library panel.

---

## License

MIT — see [LICENSE](./LICENSE).
