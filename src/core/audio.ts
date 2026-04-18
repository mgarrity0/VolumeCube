// Mic input + FFT bins for audio-reactive patterns (lifted from Orbiter and
// extended with a beat detector).
//
// Data flow: stream → MediaStreamAudioSourceNode → AnalyserNode(fftSize=512)
// → getByteFrequencyData() → normalize to [0,1] → bins.
//
// Module-level singleton so the render loop reads it directly without
// Zustand re-renders. UI state (mic requested + error) lives in Zustand.

const FFT_SIZE = 512;
const BIN_COUNT = FFT_SIZE / 2;

export type AudioState = {
  enabled: boolean;
  bins: Float32Array;
  energy: number; // mean bin magnitude [0,1]
  low: number;    // mean of bottom third of bins
  mid: number;
  high: number;
  beat: boolean;  // true for exactly one frame per detected beat
};

// Beat detector: a rolling mean of `energy`, with a threshold * mean trigger
// plus a cooldown so a single clap doesn't flash multiple frames.
class BeatDetector {
  private history: number[] = [];
  private historyLen = 43;    // ~0.7 s at 60 fps — fast enough for tempo
  private threshold = 1.35;   // energy must exceed mean * threshold
  private cooldownMs = 180;
  private lastBeatAt = 0;

  detect(energy: number, nowMs: number): boolean {
    this.history.push(energy);
    if (this.history.length > this.historyLen) this.history.shift();
    if (this.history.length < 8) return false;

    let sum = 0;
    for (let i = 0; i < this.history.length; i++) sum += this.history[i];
    const mean = sum / this.history.length;

    if (energy > mean * this.threshold && nowMs - this.lastBeatAt > this.cooldownMs) {
      this.lastBeatAt = nowMs;
      return true;
    }
    return false;
  }
}

class AudioEngine implements AudioState {
  enabled = false;
  bins = new Float32Array(BIN_COUNT);
  energy = 0;
  low = 0;
  mid = 0;
  high = 0;
  beat = false;

  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private raw = new Uint8Array(BIN_COUNT);
  private detector = new BeatDetector();

  async start(): Promise<void> {
    if (this.enabled) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    const ctx = new AC();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0.72;
    src.connect(analyser);
    this.ctx = ctx;
    this.stream = stream;
    this.analyser = analyser;
    this.enabled = true;
  }

  stop(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
    }
    if (this.ctx) this.ctx.close().catch(() => {});
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
    this.enabled = false;
    this.bins.fill(0);
    this.energy = this.low = this.mid = this.high = 0;
    this.beat = false;
  }

  update(nowMs: number): void {
    if (!this.analyser) {
      this.beat = false;
      return;
    }
    this.analyser.getByteFrequencyData(this.raw);
    const n = this.raw.length;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = this.raw[i] / 255;
      this.bins[i] = v;
      sum += v;
    }
    this.energy = sum / n;

    const third = Math.max(1, Math.floor(n / 3));
    let lo = 0, mi = 0, hi = 0;
    for (let i = 0; i < third; i++) lo += this.bins[i];
    for (let i = third; i < 2 * third; i++) mi += this.bins[i];
    for (let i = 2 * third; i < n; i++) hi += this.bins[i];
    this.low = lo / third;
    this.mid = mi / third;
    this.high = hi / Math.max(1, n - 2 * third);

    // Beat detection favors bass-band energy; clapping/kicks/snares all
    // hit the low third hardest.
    this.beat = this.detector.detect(this.low, nowMs);
  }
}

export const audioEngine = new AudioEngine();
