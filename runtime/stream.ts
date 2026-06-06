// Headless VolumeCube streamer for the NUC.
//
// Same pattern engine as the desktop app — same .js pattern files, same
// color pipeline, same wiring address map, same transports — just run
// from Node with no Tauri / no R3F. Streams frames to one or more
// network targets (Brainboards running WLED, etc.) via sACN or DDP.
//
// Usage:
//   npm run stream -- --config runtime/example.config.json
//
// While running, the script prints a fps + transport status line every
// second. Ctrl-C cleans up the UDP socket and exits.

import { loadConfig } from './config';
import { loadPatternFromDisk } from './loadPattern';
import { nodeUdpSender, closeUdpSocket } from './nodeUdpSender';
import { buildCoords, gridDims, ledCount } from '../src/core/cubeGeometry';
import { buildAddressMapForCube } from '../src/core/wiring';
import { buildGammaLut, computeDuty, bakeFrame } from '../src/core/colorPipeline';
import { estimatePower } from '../src/core/power';
import { patternUtils } from '../src/core/utils';
import { renderPatternFrame } from '../src/core/patternRender';
import { mergeParamValues } from '../src/core/patternApi';
import type { RenderContext, SetupContext } from '../src/core/patternApi';
import { WledUdpTransport } from '../src/core/transports/wledUdp';
import { SacnTransport } from '../src/core/transports/sacn';
import type { Transport } from '../src/core/transports';

function parseArgs(argv: string[]): { configPath: string } {
  const idx = argv.indexOf('--config');
  if (idx < 0 || !argv[idx + 1]) {
    console.error('Usage: stream --config <path-to-config.json>');
    process.exit(1);
  }
  return { configPath: argv[idx + 1] };
}

async function main(): Promise<void> {
  const { configPath } = parseArgs(process.argv.slice(2));
  const config = loadConfig(configPath);

  console.log('[stream] config:', configPath);
  console.log('[stream] patterns root:', config.patternsRoot);
  console.log('[stream] cube:', config.cube);
  console.log('[stream] output kind:', config.output.kind);
  console.log('[stream] targets:', config.output.targets);

  // ---- Build all the precomputed engine state ----
  const dims = gridDims(config.cube);
  const Nmax = Math.max(dims.Nx, dims.Ny, dims.Nz);
  const count = ledCount(config.cube);
  const coords = buildCoords(config.cube);
  const addressMap = buildAddressMapForCube(config.cube, config.wiring);
  const gammaLut = buildGammaLut(config.color.gamma);

  const patternBuf = new Uint8ClampedArray(count * 3);
  const dutyBuf = new Uint8ClampedArray(count * 3);
  const streamBuf = new Uint8Array(count * 3);

  // ---- Load the pattern ----
  const pattern = await loadPatternFromDisk(config.patternsRoot, config.pattern.name);
  const params = mergeParamValues(pattern.params, config.pattern.params ?? {});
  console.log(`[stream] pattern loaded: ${pattern.displayName} (${pattern.kind} API)`);

  const setupCtx: SetupContext = { Nx: dims.Nx, Ny: dims.Ny, Nz: dims.Nz, N: Nmax, params };
  if (pattern.setup) pattern.setup(setupCtx);

  // ---- Build the transport ----
  const sender = nodeUdpSender();
  const transport: Transport =
    config.output.kind === 'sacn'
      ? new SacnTransport(sender)
      : new WledUdpTransport(sender);

  console.log(`[stream] connecting via ${transport.name}…`);
  await transport.connect(config.output);
  console.log('[stream] connected. starting render loop.');

  // ---- Render loop ----
  const fps = config.fps;
  const tickMs = 1000 / fps;
  let frame = 0;
  let lastSendAt = performance.now();
  const sendTimes: number[] = [];
  let droppedFrames = 0;
  let lastStatsAt = performance.now();

  // Stop signal so Ctrl-C exits cleanly.
  let running = true;
  const stop = () => {
    running = false;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const start = performance.now();

  while (running) {
    const tStartMs = performance.now();
    const tSeconds = (tStartMs - start) / 1000;

    const ctx: RenderContext = {
      t: tSeconds,
      dt: tickMs / 1000,
      frame: frame++,
      Nx: dims.Nx,
      Ny: dims.Ny,
      Nz: dims.Nz,
      N: Nmax,
      params,
      audio: { energy: 0, low: 0, mid: 0, high: 0, beat: false },
      power: { amps: 0, watts: 0, budgetAmps: config.power.budgetAmps, scale: 1 },
      utils: patternUtils,
    };

    try {
      renderPatternFrame(pattern, ctx, coords, patternBuf);
    } catch (e) {
      console.error('[stream] pattern render error:', e);
      stop();
      break;
    }

    computeDuty(patternBuf, config.color.brightness, dutyBuf);
    const pre = estimatePower(dutyBuf, config.power);
    bakeFrame(patternBuf, config.color, gammaLut, pre.scale, addressMap, null, streamBuf);

    try {
      await transport.sendFrame(streamBuf, config.output);
      sendTimes.push(performance.now());
      const cutoff = sendTimes[sendTimes.length - 1] - 1000;
      while (sendTimes.length && sendTimes[0] < cutoff) sendTimes.shift();
      lastSendAt = sendTimes[sendTimes.length - 1];
    } catch (e: any) {
      droppedFrames++;
      console.warn('[stream] send error:', e?.message ?? e);
    }

    const now = performance.now();
    if (now - lastStatsAt >= 1000) {
      const ablPct = Math.round(pre.scale * 100);
      console.log(
        `[stream] fps=${sendTimes.length} dropped=${droppedFrames} ` +
        `power=${pre.amps.toFixed(1)}A pre-ABL ABL=${ablPct}%`,
      );
      lastStatsAt = now;
    }

    // Sleep so we hit the target frame rate. Use the actual loop time
    // so a slow render doesn't accumulate drift.
    const elapsed = performance.now() - tStartMs;
    const remaining = tickMs - elapsed;
    if (remaining > 0) {
      await sleep(remaining);
    }
  }

  console.log('[stream] shutting down…');
  await transport.disconnect();
  closeUdpSocket();
  console.log('[stream] done.');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((e) => {
  console.error('[stream] fatal:', e);
  closeUdpSocket();
  process.exit(1);
});
