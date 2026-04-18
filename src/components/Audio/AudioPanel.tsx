import { useEffect, useRef } from 'react';
import { useAppStore } from '../../state/store';
import { audioEngine } from '../../core/audio';

// AudioPanel — mic toggle + live log-scaled spectrum + E/L/M/H readouts.
//
// The spectrum uses requestAnimationFrame directly on a <canvas> so it
// doesn't re-render React on every frame. Band readouts are on the same
// RAF loop, written into refs. A low-rate timer nudges React to show
// fresh numbers every ~150ms (staleness of a tenth of a second is fine
// visually and keeps the component cheap).

const SPECTRUM_BG = '#0a0a0a';
const SPECTRUM_FG = '#dce5ff';
const SPECTRUM_FG_SOFT = '#4a6cff';

export function AudioPanel() {
  const requested = useAppStore((s) => s.audio.requested);
  const error = useAppStore((s) => s.audio.error);
  const setRequested = useAppStore((s) => s.setAudioRequested);
  const setError = useAppStore((s) => s.setAudioError);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const eRef = useRef<HTMLSpanElement>(null);
  const lRef = useRef<HTMLSpanElement>(null);
  const mRef = useRef<HTMLSpanElement>(null);
  const hRef = useRef<HTMLSpanElement>(null);
  const beatRef = useRef<HTMLSpanElement>(null);

  const onToggle = async () => {
    if (audioEngine.enabled) {
      audioEngine.stop();
      setRequested(false);
      setError(null);
      return;
    }
    try {
      await audioEngine.start();
      setRequested(true);
      setError(null);
    } catch (e: any) {
      setRequested(false);
      setError(e?.message ?? String(e));
    }
  };

  // Spectrum draw loop — independent of React, reads audioEngine bins
  // live. The render-loop in Cube.tsx already calls audioEngine.update()
  // each frame, so `bins` is fresh here.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let raf = 0;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Size the canvas's backing store to its CSS box for crispness.
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const w = canvas.width;
      const h = canvas.height;
      ctx.fillStyle = SPECTRUM_BG;
      ctx.fillRect(0, 0, w, h);

      const bins = audioEngine.bins;
      const n = bins.length;
      if (!audioEngine.enabled || n === 0) return;

      // Log-spaced bars so bass doesn't dominate visually. 48 bars across.
      const barCount = 48;
      const gap = 1;
      const bw = Math.max(1, (w - (barCount + 1) * gap) / barCount);
      const maxLog = Math.log(n);
      for (let i = 0; i < barCount; i++) {
        const t0 = i / barCount;
        const t1 = (i + 1) / barCount;
        const i0 = Math.min(n - 1, Math.floor(Math.exp(t0 * maxLog)));
        const i1 = Math.max(i0 + 1, Math.floor(Math.exp(t1 * maxLog)));
        let sum = 0;
        for (let j = i0; j < i1; j++) sum += bins[j];
        const v = sum / (i1 - i0);
        const bh = Math.max(1, v * h);
        const x = gap + i * (bw + gap);
        const grad = ctx.createLinearGradient(0, h, 0, h - bh);
        grad.addColorStop(0, SPECTRUM_FG_SOFT);
        grad.addColorStop(1, SPECTRUM_FG);
        ctx.fillStyle = grad;
        ctx.fillRect(x, h - bh, bw, bh);
      }
    };
    raf = requestAnimationFrame(draw);

    // Low-rate band readout refresh — avoids re-rendering the whole
    // panel 60×/sec.
    const tick = setInterval(() => {
      if (eRef.current) eRef.current.textContent = audioEngine.energy.toFixed(2);
      if (lRef.current) lRef.current.textContent = audioEngine.low.toFixed(2);
      if (mRef.current) mRef.current.textContent = audioEngine.mid.toFixed(2);
      if (hRef.current) hRef.current.textContent = audioEngine.high.toFixed(2);
      if (beatRef.current) {
        beatRef.current.style.opacity = audioEngine.beat ? '1' : '0.25';
      }
    }, 120);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      clearInterval(tick);
    };
  }, []);

  return (
    <section className="panel-section">
      <h2>Audio</h2>
      <div className="audio-toggle-row">
        <button onClick={onToggle} className={audioEngine.enabled ? 'active' : ''}>
          {audioEngine.enabled || requested ? 'Disable mic' : 'Enable mic'}
        </button>
        <span className={'audio-status' + (audioEngine.enabled ? ' on' : '')}>
          {audioEngine.enabled ? '● LIVE' : 'off'}
        </span>
        <span
          ref={beatRef}
          className="audio-status on"
          style={{ opacity: 0.25, marginLeft: 'auto' }}
        >
          BEAT
        </span>
      </div>
      <canvas ref={canvasRef} className="audio-spectrum" />
      <div className="audio-bands">
        <div>E<strong><span ref={eRef}>0.00</span></strong></div>
        <div>L<strong><span ref={lRef}>0.00</span></strong></div>
        <div>M<strong><span ref={mRef}>0.00</span></strong></div>
        <div>H<strong><span ref={hRef}>0.00</span></strong></div>
      </div>
      {error && <div className="library-error">{error}</div>}
    </section>
  );
}
