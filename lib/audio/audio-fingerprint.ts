/**
 * ============================================================
 * AUDIO FINGERPRINT ANALYSIS & LOSSLESS NOISE REDUCTION ENGINE
 * ============================================================
 *
 * Concepts drawn from:
 *  - Avery Li-Chun Wang, "An Industrial Strength Audio Search Algorithm" (Shazam, ISMIR 2003)
 *  - Khatri, Dillingham & Chen, "Song Recognition Using Audio Fingerprinting" (U. Rochester)
 *  - Nyquist-Shannon Sampling Theorem
 *  - Cooley-Tukey FFT (radix-2 DIT)
 *  - STFT / Spectrogram analysis
 *  - Wiener Filter for lossless noise reduction
 *  - Overlap-Add (OLA) reconstruction
 *
 * PIPELINE OVERVIEW
 * -----------------
 *  Upload Audio
 *    │
 *    ├─ [GRAPH 1] Time-Domain Waveform         ← raw PCM amplitude vs time
 *    │
 *    ├─ Step 1: Stereo → Mono
 *    ├─ Step 2: Downsample to 8192 Hz
 *    │
 *    ├─ [GRAPH 2] Downsampled Waveform         ← mono, decimated
 *    │
 *    ├─ Step 3: Hamming-windowed STFT
 *    │
 *    ├─ [GRAPH 3] Spectrogram (STFT)           ← time-freq magnitude heatmap
 *    ├─ [GRAPH 4] FFT Frequency Spectrum       ← average magnitude vs Hz
 *    ├─ [GRAPH 5] Power Spectral Density       ← dB/Hz vs log-frequency
 *    ├─ [GRAPH 6] Constellation Map            ← Shazam fingerprint peaks
 *    ├─ [GRAPH 7] Band Energy Distribution     ← energy per log band over time
 *    ├─ [GRAPH 8] Phase Spectrum               ← instantaneous phase vs freq
 *    │
 *    ├─ Step 4: Noise Floor Estimation         ← min-statistics method
 *    ├─ Step 5: Wiener Filter in freq domain   ← SNR-weighted spectral subtraction
 *    ├─ Step 6: Overlap-Add IFFT               ← reconstruct time-domain signal
 *    │
 *    ├─ [GRAPH 9]  Cleaned Waveform            ← output PCM
 *    ├─ [GRAPH 10] Noise Residual Waveform     ← what was removed
 *    ├─ [GRAPH 11] Before/After Spectrum       ← overlay comparison
 *    └─ [GRAPH 12] Noise Reduction Gain Curve  ← Wiener gain H(f) vs Hz
 */

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

export interface RawAudio {
  /** Per-channel PCM float32 samples */
  channels: Float32Array[];
  sampleRate: number;
  duration: number;
  numChannels: number;
  numSamples: number;
}

export interface MonoAudio {
  samples: Float32Array;
  sampleRate: number;
  duration: number;
}

/** A single STFT frame */
export interface STFTFrame {
  index: number;
  timeSeconds: number;
  /** Complex FFT output — real[k], imag[k] for k=0..windowSize-1 */
  real: Float32Array;
  imag: Float32Array;
  /** Magnitude spectrum |X[k]| for k=0..numBins-1 */
  magnitude: Float32Array;
  /** Phase spectrum ∠X[k] in radians for k=0..numBins-1 */
  phase: Float32Array;
  /** Power spectrum |X[k]|² */
  power: Float32Array;
}

export interface STFTResult {
  frames: STFTFrame[];
  numBins: number;   // = windowSize / 2
  windowSize: number;
  hopSize: number;
  sampleRate: number;
  /** Frequency in Hz for each bin index */
  binFrequencies: Float32Array;
  /** Time in seconds for each frame index */
  frameTimes: Float32Array;
}

export interface ConstellationPoint {
  frameIndex: number;
  binIndex: number;
  timeSeconds: number;
  frequencyHz: number;
  magnitude: number;
  bandIndex: number;
}

export interface FingerprintHash {
  hash: number;
  anchorFrameIndex: number;
  anchorBin: number;
  targetBin: number;
  deltaTime: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// GRAPH DATA TYPES  (consumed by whatever rendering layer you wire up)
// Each graph is a pure-data object — no DOM dependency.
// ─────────────────────────────────────────────────────────────────────────────

export interface WaveformGraphData {
  /** label shown in UI */
  title: string;
  /** x-axis values (seconds) */
  timeAxis: Float32Array;
  /** y-axis values (amplitude) */
  amplitude: Float32Array;
  /** peak positive value (for y-axis scaling) */
  peakAmplitude: number;
  durationSeconds: number;
  sampleRate: number;
}

export interface SpectrogramGraphData {
  title: string;
  /** flat row-major [frameIndex * numBins + binIndex] log-normalised [0,1] */
  pixelData: Float32Array;
  numFrames: number;
  numBins: number;
  /** seconds per frame */
  timePerFrame: number;
  /** Hz per bin */
  hzPerBin: number;
  maxFreqHz: number;
  durationSeconds: number;
}

export interface FrequencySpectrumGraphData {
  title: string;
  /** Frequency axis in Hz */
  frequencies: Float32Array;
  /** Average magnitude across all frames */
  averageMagnitude: Float32Array;
  /** Peak magnitude across all frames (for "envelope" line) */
  peakMagnitude: Float32Array;
  maxFreqHz: number;
}

export interface PSDGraphData {
  title: string;
  /** Log-spaced frequency axis in Hz */
  frequencies: Float32Array;
  /** Power spectral density in dB */
  psdDb: Float32Array;
  noiseFloorDb: Float32Array;
}

export interface ConstellationGraphData {
  title: string;
  points: ConstellationPoint[];
  numFrames: number;
  numBins: number;
  durationSeconds: number;
  maxFreqHz: number;
}

export interface BandEnergyGraphData {
  title: string;
  /** Time axis in seconds */
  timeAxis: Float32Array;
  /** bandEnergies[bandIndex][frameIndex] */
  bandEnergies: Float32Array[];
  bandLabels: string[];
  numBands: number;
}

export interface PhaseSpectrumGraphData {
  title: string;
  frequencies: Float32Array;
  /** Average unwrapped phase in radians */
  phase: Float32Array;
  maxFreqHz: number;
}

export interface NRGainCurveGraphData {
  title: string;
  frequencies: Float32Array;
  /** Wiener gain H(f) in [0,1] */
  gain: Float32Array;
  /** Estimated SNR per bin in dB */
  snrDb: Float32Array;
}

export interface BeforeAfterSpectrumGraphData {
  title: string;
  frequencies: Float32Array;
  before: Float32Array;
  after: Float32Array;
  noiseFloor: Float32Array;
}

/** All 12 graphs bundled */
export interface AllGraphData {
  /** GRAPH 1 — original time-domain waveform */
  g1_originalWaveform: WaveformGraphData;
  /** GRAPH 2 — downsampled mono waveform */
  g2_downsampledWaveform: WaveformGraphData;
  /** GRAPH 3 — STFT spectrogram heatmap */
  g3_spectrogram: SpectrogramGraphData;
  /** GRAPH 4 — average FFT frequency spectrum */
  g4_frequencySpectrum: FrequencySpectrumGraphData;
  /** GRAPH 5 — power spectral density */
  g5_psd: PSDGraphData;
  /** GRAPH 6 — Shazam constellation fingerprint map */
  g6_constellation: ConstellationGraphData;
  /** GRAPH 7 — per-band energy over time */
  g7_bandEnergy: BandEnergyGraphData;
  /** GRAPH 8 — phase spectrum */
  g8_phase: PhaseSpectrumGraphData;
  /** GRAPH 9 — cleaned output waveform */
  g9_cleanedWaveform: WaveformGraphData;
  /** GRAPH 10 — noise residual (removed signal) */
  g10_noiseResidual: WaveformGraphData;
  /** GRAPH 11 — before/after spectrum overlay */
  g11_beforeAfterSpectrum: BeforeAfterSpectrumGraphData;
  /** GRAPH 12 — Wiener noise reduction gain curve */
  g12_nrGainCurve: NRGainCurveGraphData;
}

export interface ProcessingResult {
  graphs: AllGraphData;
  /** Final cleaned audio ready for WAV encoding */
  cleanedAudio: MonoAudio;
  /** Isolated noise signal */
  noiseAudio: MonoAudio;
  /** Fingerprint constellation points */
  constellationPoints: ConstellationPoint[];
  /** Fingerprint hashes */
  hashes: FingerprintHash[];
  stats: {
    inputDuration: number;
    inputSampleRate: number;
    workingSampleRate: number;
    totalSTFTFrames: number;
    totalConstellationPeaks: number;
    totalHashes: number;
    estimatedNoiseFloorDb: number;
    avgWienerGain: number;
    snrImprovementDb: number;
  };
}

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

/** Working sample rate — paper §3.1: "downsampled to 8192 Hz" */
const WORK_SR = 8192;

/**
 * FFT window size.
 * Paper §3.1: "A window of 1024 gives a sufficient amount of frequency resolution."
 * We use 2048 for full-band analysis before noise reduction, then 1024 for fingerprinting.
 */
const FFT_SIZE_ANALYSIS = 2048;  // for graphs 3–8 and noise reduction
const FFT_SIZE_FP       = 1024;  // for fingerprinting (paper's choice)

/** Hop size — paper §3.1: "a hop size of 32 was chosen" */
const HOP_SIZE = 32;

/** Number of logarithmic bands for fingerprinting — paper §3.1: "6 bands" */
const NUM_BANDS = 6;

/** Target zone width — paper §3.2: "50 frames to the right of the anchor" */
const TARGET_ZONE = 50;

/** Max-filter neighbourhood radius for constellation extraction */
const MF_FRAME_R = 5;
const MF_BIN_R   = 5;

/**
 * Noise estimation: number of frames used for minimum-statistics noise floor.
 * We track a rolling minimum over this many frames per bin.
 */
const NOISE_EST_FRAMES = 20;

/** Wiener filter floor — prevents division by zero, sets minimum gain */
const WIENER_FLOOR = 0.001;

// ─────────────────────────────────────────────────────────────
// STEP 1 — DECODE + STEREO → MONO
// ─────────────────────────────────────────────────────────────

/**
 * Average all channels into a single mono signal.
 * Paper §3.1: "convert a multichannel audio file to mono"
 */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return new Float32Array(channels[0]);
  const N = channels[0].length;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (const ch of channels) s += ch[i];
    out[i] = s / channels.length;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// STEP 2 — DOWNSAMPLE
// ─────────────────────────────────────────────────────────────

/**
 * Resample mono PCM from `fromSR` to `toSR` using linear interpolation.
 * Paper §3.1: "downsampled to 8192 Hz … majority of information under Nyquist of 4096 Hz"
 */
export function resample(
  samples: Float32Array,
  fromSR: number,
  toSR: number,
): Float32Array {
  if (fromSR === toSR) return samples;
  const ratio  = fromSR / toSR;
  const outLen = Math.floor(samples.length / ratio);
  const out    = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const lo  = Math.floor(pos);
    const hi  = Math.min(lo + 1, samples.length - 1);
    const t   = pos - lo;
    out[i]    = samples[lo] * (1 - t) + samples[hi] * t;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// STEP 3 — FFT (Cooley-Tukey radix-2 DIT, in-place)
// ─────────────────────────────────────────────────────────────

/**
 * In-place FFT. O(N log N) Cooley-Tukey algorithm.
 *
 * "By far the most commonly used variation of FFT is the Cooley–Tukey algorithm.
 *  This is a divide-and-conquer algorithm that recursively divides a DFT into
 *  many smaller DFTs." — Shazam algorithm article
 *
 * @param re  Real parts (length must be a power of 2)
 * @param im  Imaginary parts (same length, pre-filled with zeros for real input)
 * @param inv If true, computes inverse FFT (IFFT)
 */
export function fft(re: Float32Array, im: Float32Array, inv = false): void {
  const N   = re.length;
  const dir = inv ? 1 : -1;

  // Bit-reversal permutation
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  // Butterfly stages
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (dir * 2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let uRe = 1, uIm = 0;
      for (let j = 0; j < (len >> 1); j++) {
        const h   = i + j + (len >> 1);
        const vRe = re[h] * uRe - im[h] * uIm;
        const vIm = re[h] * uIm + im[h] * uRe;
        re[h]     = re[i + j] - vRe;
        im[h]     = im[i + j] - vIm;
        re[i + j] += vRe;
        im[i + j] += vIm;
        const nu  = uRe * wRe - uIm * wIm;
        uIm       = uRe * wIm + uIm * wRe;
        uRe       = nu;
      }
    }
  }

  // Scale for IFFT
  if (inv) {
    for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
  }
}

// ─────────────────────────────────────────────────────────────
// STEP 4 — WINDOW FUNCTIONS
// ─────────────────────────────────────────────────────────────

/**
 * Hamming window — paper §3.1: "Apply hamming window (window length 1024)"
 * w(n) = 0.54 − 0.46·cos(2πn/(N−1))
 */
export function hammingWindow(N: number): Float32Array {
  const w = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    w[n] = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (N - 1));
  }
  return w;
}

/**
 * Hann window — smoother sidelobes, better for overlap-add reconstruction
 * w(n) = 0.5·(1 − cos(2πn/(N−1)))
 */
export function hannWindow(N: number): Float32Array {
  const w = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    w[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));
  }
  return w;
}

// ─────────────────────────────────────────────────────────────
// STEP 5 — STFT (Short-Time Fourier Transform)
// ─────────────────────────────────────────────────────────────

/**
 * Compute STFT using the given FFT size and hop size.
 * Returns one frame per hop containing full complex FFT output.
 *
 * Nyquist-Shannon: to capture all audible frequencies up to 20 kHz,
 * sample rate must be ≥ 40 kHz. At 8192 Hz we capture up to 4096 Hz —
 * sufficient for most instruments (paper §3.1).
 */
export function computeSTFT(
  samples: Float32Array,
  sampleRate: number,
  fftSize: number,
  hopSize: number,
  useHann = false,
): STFTResult {
  const win     = useHann ? hannWindow(fftSize) : hammingWindow(fftSize);
  const numBins = fftSize >> 1;     // positive frequencies only
  const frames: STFTFrame[]  = [];
  const re      = new Float32Array(fftSize);
  const im      = new Float32Array(fftSize);

  // Bin → frequency mapping
  const binFrequencies = new Float32Array(numBins);
  for (let k = 0; k < numBins; k++) {
    binFrequencies[k] = (k * sampleRate) / fftSize;
  }

  let frameIndex = 0;
  for (let start = 0; start + fftSize <= samples.length; start += hopSize) {
    re.fill(0);
    im.fill(0);

    for (let i = 0; i < fftSize; i++) {
      re[i] = (samples[start + i] ?? 0) * win[i];
    }

    fft(re, im);

    const magnitude = new Float32Array(numBins);
    const phase     = new Float32Array(numBins);
    const power     = new Float32Array(numBins);

    for (let k = 0; k < numBins; k++) {
      magnitude[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      phase[k]     = Math.atan2(im[k], re[k]);
      power[k]     = re[k] * re[k] + im[k] * im[k];
    }

    frames.push({
      index: frameIndex,
      timeSeconds: start / sampleRate,
      real:      new Float32Array(re),
      imag:      new Float32Array(im),
      magnitude,
      phase,
      power,
    });
    frameIndex++;
  }

  const frameTimes = new Float32Array(frames.length);
  frames.forEach((f, i) => { frameTimes[i] = f.timeSeconds; });

  return { frames, numBins, windowSize: fftSize, hopSize, sampleRate, binFrequencies, frameTimes };
}

// ─────────────────────────────────────────────────────────────
// STEP 6 — NOISE FLOOR ESTIMATION (minimum-statistics)
// ─────────────────────────────────────────────────────────────

/**
 * Estimate the noise floor power spectrum using a rolling minimum
 * across a window of NOISE_EST_FRAMES frames per bin.
 *
 * Minimum-statistics: noise is approximated by the minimum power in
 * a recent buffer — works because noise is (almost) always present
 * while the signal is intermittent.
 *
 * Returns noiseFloor[binIndex] as a power value.
 */
export function estimateNoiseFloor(stftResult: STFTResult): Float32Array {
  const { frames, numBins } = stftResult;
  const N    = frames.length;
  const floor = new Float32Array(numBins);

  // Rolling buffer per bin: store the last NOISE_EST_FRAMES power values
  const buffer: Float32Array[] = Array.from(
    { length: numBins },
    () => new Float32Array(NOISE_EST_FRAMES).fill(1e-10),
  );
  let bufPtr = 0;

  for (let f = 0; f < N; f++) {
    for (let k = 0; k < numBins; k++) {
      buffer[k][bufPtr % NOISE_EST_FRAMES] = frames[f].power[k];
    }
    bufPtr++;
  }

  // Take minimum over the buffer for each bin
  for (let k = 0; k < numBins; k++) {
    let minPow = Infinity;
    for (let j = 0; j < NOISE_EST_FRAMES; j++) {
      if (buffer[k][j] < minPow) minPow = buffer[k][j];
    }
    // Apply a small over-subtraction factor (1.5) to be conservative
    floor[k] = minPow * 1.5;
  }

  return floor;
}

// ─────────────────────────────────────────────────────────────
// STEP 7 — WIENER FILTER (lossless spectral noise reduction)
// ─────────────────────────────────────────────────────────────

/**
 * Compute the Wiener gain function H(f) for each bin.
 *
 * Classic Wiener filter:
 *   H(f) = SNR(f) / (1 + SNR(f))
 * where
 *   SNR(f) = max(0,  (|X(f)|² − σ²(f)) / σ²(f))
 *   σ²(f)  = estimated noise power at bin f
 *
 * This is a soft mask — unlike hard thresholding it preserves
 * spectral continuity, giving lossless-sounding output.
 *
 * Returns gain[binIndex] in [0, 1].
 */
export function wienerGain(
  signalPower: Float32Array,
  noisePower: Float32Array,
): Float32Array {
  const numBins = signalPower.length;
  const gain    = new Float32Array(numBins);

  for (let k = 0; k < numBins; k++) {
    const nP  = Math.max(noisePower[k], 1e-12);
    const snr = Math.max(0, (signalPower[k] - nP) / nP);
    gain[k]   = Math.max(WIENER_FLOOR, snr / (1 + snr));
  }
  return gain;
}

// ─────────────────────────────────────────────────────────────
// STEP 8 — OVERLAP-ADD RECONSTRUCTION (IFFT + OLA)
// ─────────────────────────────────────────────────────────────

/**
 * Apply the per-frame Wiener gain to each STFT frame, then
 * reconstruct the time-domain signal with the Overlap-Add method.
 *
 * OLA ensures perfect reconstruction: each output sample is the
 * sum of windowed IFFT outputs from all overlapping frames.
 *
 * Returns both the cleaned signal and the removed noise signal.
 */
export function applyWienerAndReconstruct(
  stftResult: STFTResult,
  noiseFloor: Float32Array,
  originalSamples: Float32Array,
): { cleaned: Float32Array; noise: Float32Array; gainCurveAvg: Float32Array } {
  const { frames, numBins, windowSize, hopSize, sampleRate } = stftResult;
  const N         = frames.length;
  const sigLen    = originalSamples.length;
  const cleanedOut = new Float32Array(sigLen);
  const normSum    = new Float32Array(sigLen); // for OLA normalisation

  // Per-bin average gain (for graph 12)
  const gainAccum = new Float32Array(numBins);
  const gainCount = new Float32Array(numBins);

  const win = hannWindow(windowSize); // Hann for perfect OLA

  const re = new Float32Array(windowSize);
  const im = new Float32Array(windowSize);

  for (let f = 0; f < N; f++) {
    const frame = frames[f];
    re.fill(0);
    im.fill(0);

    // Compute per-bin average power for this frame (use frame power directly)
    // then compute Wiener gain for this frame
    const gain = wienerGain(frame.power, noiseFloor);

    // Accumulate for average gain curve
    for (let k = 0; k < numBins; k++) {
      gainAccum[k] += gain[k];
      gainCount[k]++;
    }

    // Apply gain to complex spectrum
    for (let k = 0; k < numBins; k++) {
      re[k] = frame.real[k] * gain[k];
      im[k] = frame.imag[k] * gain[k];
    }

    // Mirror for negative frequencies (FFT symmetry)
    for (let k = 1; k < numBins - 1; k++) {
      re[windowSize - k] =  re[k];
      im[windowSize - k] = -im[k];
    }

    // IFFT → back to time domain
    fft(re, im, true); // inv=true

    // Overlap-add with synthesis window
    const start = f * hopSize;
    for (let i = 0; i < windowSize; i++) {
      const idx = start + i;
      if (idx >= sigLen) break;
      cleanedOut[idx] += re[i] * win[i];
      normSum[idx]    += win[i] * win[i];
    }
  }

  // Normalise by OLA window envelope
  for (let i = 0; i < sigLen; i++) {
    if (normSum[i] > 1e-8) cleanedOut[i] /= normSum[i];
  }

  // Noise residual = original − cleaned
  const noise = new Float32Array(sigLen);
  for (let i = 0; i < sigLen; i++) {
    noise[i] = originalSamples[i] - cleanedOut[i];
  }

  // Average gain curve
  const gainCurveAvg = new Float32Array(numBins);
  for (let k = 0; k < numBins; k++) {
    gainCurveAvg[k] = gainCount[k] > 0 ? gainAccum[k] / gainCount[k] : 0;
  }

  return { cleaned: cleanedOut, noise, gainCurveAvg };
}

// ─────────────────────────────────────────────────────────────
// STEP 9 — CONSTELLATION EXTRACTION (Shazam fingerprint)
// ─────────────────────────────────────────────────────────────

/**
 * Compute logarithmic band boundaries for fingerprinting.
 * Paper §3.1: "frequency bins are divided into logarithmic bands. 6 bands were chosen."
 */
export function logBandBoundaries(
  numBands: number,
  sampleRate: number,
  fftSize: number,
): number[] {
  const minHz = 20;
  const maxHz = sampleRate / 2;
  const bounds: number[] = [];
  for (let b = 0; b <= numBands; b++) {
    const hz  = minHz * Math.pow(maxHz / minHz, b / numBands);
    const bin = Math.round((hz * fftSize) / sampleRate);
    bounds.push(Math.min(bin, fftSize / 2 - 1));
  }
  return bounds;
}

/**
 * Band labels for the 6 logarithmic bands (20 Hz → 4096 Hz)
 */
export function bandLabels(): string[] {
  return [
    "Sub-bass (20–90 Hz)",
    "Bass (90–250 Hz)",
    "Low-mid (250–700 Hz)",
    "Mid (700–2k Hz)",
    "High-mid (2k–3.5k Hz)",
    "Air (3.5k–4k Hz)",
  ];
}

/**
 * Extract constellation peaks using a 2D max filter.
 * Paper §3.1:
 *  "the spectrogram is treated as an image and a max filter is applied …
 *   Only the pixels … with the max value in the local neighborhood will
 *   be the same as the max filtered image, leaving only the local maximums."
 */
export function extractConstellation(
  stftResult: STFTResult,
  bandBounds: number[],
): ConstellationPoint[] {
  const { frames, numBins } = stftResult;
  const nF = frames.length;

  // 1. Per-frame, per-band: find the bin with max magnitude
  interface Candidate { frameIndex: number; binIndex: number; magnitude: number; band: number }
  const candidates: Candidate[] = [];

  for (let f = 0; f < nF; f++) {
    for (let b = 0; b < NUM_BANDS; b++) {
      const lo = bandBounds[b];
      const hi = bandBounds[b + 1];
      let maxMag = -Infinity, maxBin = lo;
      for (let k = lo; k < hi; k++) {
        if (frames[f].magnitude[k] > maxMag) {
          maxMag = frames[f].magnitude[k];
          maxBin = k;
        }
      }
      if (maxMag > 0) {
        candidates.push({ frameIndex: f, binIndex: maxBin, magnitude: maxMag, band: b });
      }
    }
  }

  // Fast lookup: (frame, bin) → magnitude
  const magMap = new Map<number, number>();
  for (const c of candidates) {
    const key = c.frameIndex * numBins + c.binIndex;
    const cur = magMap.get(key) ?? -Infinity;
    if (c.magnitude > cur) magMap.set(key, c.magnitude);
  }

  // 2. 2D max filter: a candidate is a peak iff it's the max in its neighbourhood
  const points: ConstellationPoint[] = [];
  for (const c of candidates) {
    const { frameIndex: f, binIndex: bin, magnitude, band } = c;
    let localMax = -Infinity;
    for (let df = -MF_FRAME_R; df <= MF_FRAME_R; df++) {
      const nf = f + df;
      if (nf < 0 || nf >= nF) continue;
      for (let db = -MF_BIN_R; db <= MF_BIN_R; db++) {
        const nb = bin + db;
        if (nb < 0 || nb >= numBins) continue;
        const m = magMap.get(nf * numBins + nb) ?? 0;
        if (m > localMax) localMax = m;
      }
    }
    if (magnitude >= localMax) {
      points.push({
        frameIndex:   f,
        binIndex:     bin,
        timeSeconds:  frames[f].timeSeconds,
        frequencyHz:  stftResult.binFrequencies[bin],
        magnitude,
        bandIndex:    band,
      });
    }
  }

  points.sort((a, b) => a.frameIndex - b.frameIndex || a.binIndex - b.binIndex);
  return points;
}

/**
 * Build fingerprint hashes from constellation anchor+target pairs.
 * Paper §3.2: hash = f_target + Δt/100  (we encode all three into one integer)
 */
export function buildHashes(points: ConstellationPoint[]): FingerprintHash[] {
  const hashes: FingerprintHash[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    for (let j = i + 1; j < points.length; j++) {
      const t  = points[j];
      const dt = t.frameIndex - a.frameIndex;
      if (dt <= 0) continue;
      if (dt > TARGET_ZONE) break;
      hashes.push({
        hash:             a.binIndex * 10_000_000 + t.binIndex * 10_000 + dt,
        anchorFrameIndex: a.frameIndex,
        anchorBin:        a.binIndex,
        targetBin:        t.binIndex,
        deltaTime:        dt,
      });
    }
  }
  return hashes;
}

// ─────────────────────────────────────────────────────────────
// GRAPH DATA BUILDERS
// ─────────────────────────────────────────────────────────────

function buildWaveformGraph(
  samples: Float32Array,
  sampleRate: number,
  title: string,
): WaveformGraphData {
  // Downsample for graph rendering (max 4000 points)
  const maxPoints = 4000;
  const step      = Math.max(1, Math.floor(samples.length / maxPoints));
  const n         = Math.floor(samples.length / step);
  const timeAxis  = new Float32Array(n);
  const amplitude = new Float32Array(n);
  let peak        = 0;

  for (let i = 0; i < n; i++) {
    // Take min/max within each step for accurate peak display
    let lo = 1, hi = -1;
    for (let j = 0; j < step; j++) {
      const s = samples[i * step + j] ?? 0;
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    timeAxis[i]  = (i * step) / sampleRate;
    amplitude[i] = Math.abs(hi) > Math.abs(lo) ? hi : lo;
    const abs    = Math.max(Math.abs(lo), Math.abs(hi));
    if (abs > peak) peak = abs;
  }

  return {
    title,
    timeAxis,
    amplitude,
    peakAmplitude: peak,
    durationSeconds: samples.length / sampleRate,
    sampleRate,
  };
}

function buildSpectrogramGraph(stft: STFTResult): SpectrogramGraphData {
  const { frames, numBins } = stft;
  const nF      = frames.length;
  const pixData = new Float32Array(nF * numBins);

  // Global log-max for normalisation
  let globalMax = 1e-9;
  for (const fr of frames) {
    for (let k = 0; k < numBins; k++) {
      if (fr.magnitude[k] > globalMax) globalMax = fr.magnitude[k];
    }
  }
  const logMax = Math.log1p(globalMax);

  for (let f = 0; f < nF; f++) {
    for (let k = 0; k < numBins; k++) {
      pixData[f * numBins + k] = Math.log1p(frames[f].magnitude[k]) / logMax;
    }
  }

  return {
    title: "STFT Spectrogram (time × frequency magnitude)",
    pixelData: pixData,
    numFrames:       nF,
    numBins,
    timePerFrame:    stft.hopSize / stft.sampleRate,
    hzPerBin:        stft.sampleRate / stft.windowSize,
    maxFreqHz:       stft.sampleRate / 2,
    durationSeconds: (frames[nF - 1]?.timeSeconds ?? 0),
  };
}

function buildFrequencySpectrumGraph(stft: STFTResult): FrequencySpectrumGraphData {
  const { frames, numBins, binFrequencies } = stft;
  const avgMag  = new Float32Array(numBins);
  const peakMag = new Float32Array(numBins);

  for (const fr of frames) {
    for (let k = 0; k < numBins; k++) {
      avgMag[k]  += fr.magnitude[k];
      if (fr.magnitude[k] > peakMag[k]) peakMag[k] = fr.magnitude[k];
    }
  }
  for (let k = 0; k < numBins; k++) avgMag[k] /= frames.length;

  return {
    title:            "FFT Frequency Spectrum (average magnitude)",
    frequencies:      binFrequencies,
    averageMagnitude: avgMag,
    peakMagnitude:    peakMag,
    maxFreqHz:        stft.sampleRate / 2,
  };
}

function buildPSDGraph(stft: STFTResult, noiseFloor: Float32Array): PSDGraphData {
  const { frames, numBins, binFrequencies } = stft;
  const avgPow    = new Float32Array(numBins);
  const psdDb     = new Float32Array(numBins);
  const noiseFlDb = new Float32Array(numBins);

  for (const fr of frames) {
    for (let k = 0; k < numBins; k++) avgPow[k] += fr.power[k];
  }
  for (let k = 0; k < numBins; k++) {
    avgPow[k]    /= frames.length;
    psdDb[k]      = 10 * Math.log10(Math.max(avgPow[k], 1e-12));
    noiseFlDb[k]  = 10 * Math.log10(Math.max(noiseFloor[k], 1e-12));
  }

  return {
    title:        "Power Spectral Density (dB vs Hz)",
    frequencies:  binFrequencies,
    psdDb,
    noiseFloorDb: noiseFlDb,
  };
}

function buildConstellationGraph(
  points: ConstellationPoint[],
  stft: STFTResult,
): ConstellationGraphData {
  return {
    title:          "Constellation Map — Shazam Fingerprint Peaks",
    points,
    numFrames:      stft.frames.length,
    numBins:        stft.numBins,
    durationSeconds: stft.frameTimes[stft.frameTimes.length - 1] ?? 0,
    maxFreqHz:      stft.sampleRate / 2,
  };
}

function buildBandEnergyGraph(
  stft: STFTResult,
  bandBounds: number[],
): BandEnergyGraphData {
  const { frames, sampleRate, hopSize } = stft;
  const nF = frames.length;
  const energies: Float32Array[] = Array.from(
    { length: NUM_BANDS },
    () => new Float32Array(nF),
  );
  const timeAxis = new Float32Array(nF);

  for (let f = 0; f < nF; f++) {
    timeAxis[f] = frames[f].timeSeconds;
    for (let b = 0; b < NUM_BANDS; b++) {
      let e = 0;
      for (let k = bandBounds[b]; k < bandBounds[b + 1]; k++) {
        e += frames[f].power[k];
      }
      energies[b][f] = 10 * Math.log10(Math.max(e, 1e-12));
    }
  }

  return {
    title:        "Per-Band Energy Over Time (dB)",
    timeAxis,
    bandEnergies: energies,
    bandLabels:   bandLabels(),
    numBands:     NUM_BANDS,
  };
}

function buildPhaseGraph(stft: STFTResult): PhaseSpectrumGraphData {
  const { frames, numBins, binFrequencies } = stft;
  const avgPhase = new Float32Array(numBins);

  // Average using complex mean to handle phase wrapping
  const cosSum = new Float32Array(numBins);
  const sinSum = new Float32Array(numBins);
  for (const fr of frames) {
    for (let k = 0; k < numBins; k++) {
      cosSum[k] += Math.cos(fr.phase[k]);
      sinSum[k] += Math.sin(fr.phase[k]);
    }
  }
  for (let k = 0; k < numBins; k++) {
    avgPhase[k] = Math.atan2(sinSum[k], cosSum[k]);
  }

  return {
    title:     "Phase Spectrum (average instantaneous phase, radians)",
    frequencies: binFrequencies,
    phase:       avgPhase,
    maxFreqHz:   stft.sampleRate / 2,
  };
}

function buildNRGainGraph(
  stft: STFTResult,
  noiseFloor: Float32Array,
  gainCurveAvg: Float32Array,
): NRGainCurveGraphData {
  const { numBins, binFrequencies, frames } = stft;
  const snrDb = new Float32Array(numBins);

  // Average signal power
  const avgPow = new Float32Array(numBins);
  for (const fr of frames) {
    for (let k = 0; k < numBins; k++) avgPow[k] += fr.power[k];
  }
  for (let k = 0; k < numBins; k++) {
    avgPow[k] /= frames.length;
    const nP   = Math.max(noiseFloor[k], 1e-12);
    snrDb[k]   = 10 * Math.log10(Math.max(avgPow[k] / nP, 1e-6));
  }

  return {
    title:       "Wiener Noise Reduction Gain Curve H(f)",
    frequencies: binFrequencies,
    gain:        gainCurveAvg,
    snrDb,
  };
}

function buildBeforeAfterGraph(
  stftBefore: STFTResult,
  stftAfter: STFTResult,
  noiseFloor: Float32Array,
): BeforeAfterSpectrumGraphData {
  const { numBins, binFrequencies } = stftBefore;
  const before = new Float32Array(numBins);
  const after  = new Float32Array(numBins);
  const nf     = new Float32Array(numBins);

  for (const fr of stftBefore.frames) {
    for (let k = 0; k < numBins; k++) before[k] += fr.magnitude[k];
  }
  for (const fr of stftAfter.frames) {
    for (let k = 0; k < numBins; k++) after[k] += fr.magnitude[k];
  }
  for (let k = 0; k < numBins; k++) {
    before[k] = 20 * Math.log10(Math.max(before[k] / stftBefore.frames.length, 1e-9));
    after[k]  = 20 * Math.log10(Math.max(after[k]  / stftAfter.frames.length,  1e-9));
    nf[k]     = 10 * Math.log10(Math.max(noiseFloor[k], 1e-12));
  }

  return {
    title:       "Before / After Spectrum (dB average magnitude)",
    frequencies: binFrequencies,
    before,
    after,
    noiseFloor:  nf,
  };
}

// ─────────────────────────────────────────────────────────────
// STATS HELPERS
// ─────────────────────────────────────────────────────────────

function rms(s: Float32Array): number {
  let sum = 0;
  for (const v of s) sum += v * v;
  return Math.sqrt(sum / s.length);
}

function snrDb(signal: Float32Array, noise: Float32Array): number {
  const sRms = rms(signal);
  const nRms = rms(noise);
  return 20 * Math.log10(Math.max(sRms / Math.max(nRms, 1e-12), 1e-6));
}

// ─────────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────

/**
 * Full pipeline: raw audio → all 12 graphs + cleaned audio.
 *
 * @param channels         Array of per-channel Float32 PCM samples
 * @param originalSampleRate  Sample rate of the input
 *
 * @returns ProcessingResult with all graph data and cleaned audio
 *
 * @example
 * // In a browser:
 * const buf = await file.arrayBuffer();
 * const ctx = new AudioContext();
 * const decoded = await ctx.decodeAudioData(buf);
 * const channels = Array.from({ length: decoded.numberOfChannels },
 *   (_, i) => decoded.getChannelData(i));
 * const result = await processAudio(channels, decoded.sampleRate);
 */
export async function processAudio(
  channels: Float32Array[],
  originalSampleRate: number,
): Promise<ProcessingResult> {

  // ── GRAPH 1: Original waveform (raw, before any processing) ──────────────
  const rawMono = toMono(channels);
  const g1 = buildWaveformGraph(rawMono, originalSampleRate, "Original Waveform (Time Domain)");

  // ── STEP 1+2: Mono + Downsample ───────────────────────────────────────────
  const workSamples = resample(rawMono, originalSampleRate, WORK_SR);

  // ── GRAPH 2: Downsampled waveform ─────────────────────────────────────────
  const g2 = buildWaveformGraph(workSamples, WORK_SR, "Downsampled Mono Waveform (8192 Hz)");

  // ── STEP 3: STFT for analysis (FFT_SIZE_ANALYSIS = 2048) ─────────────────
  const stftAnalysis = computeSTFT(workSamples, WORK_SR, FFT_SIZE_ANALYSIS, HOP_SIZE, true);

  // ── GRAPH 3: Spectrogram ──────────────────────────────────────────────────
  const g3 = buildSpectrogramGraph(stftAnalysis);

  // ── GRAPH 4: Frequency Spectrum ───────────────────────────────────────────
  const g4 = buildFrequencySpectrumGraph(stftAnalysis);

  // ── STEP 4: Noise floor estimation ───────────────────────────────────────
  const noiseFloor = estimateNoiseFloor(stftAnalysis);

  // ── GRAPH 5: Power Spectral Density ──────────────────────────────────────
  const g5 = buildPSDGraph(stftAnalysis, noiseFloor);

  // ── STEP 5: Fingerprinting STFT (FFT_SIZE_FP = 1024) ─────────────────────
  const stftFP      = computeSTFT(workSamples, WORK_SR, FFT_SIZE_FP, HOP_SIZE, false);
  const bandBounds  = logBandBoundaries(NUM_BANDS, WORK_SR, FFT_SIZE_FP);
  const constPoints = extractConstellation(stftFP, bandBounds);
  const hashes      = buildHashes(constPoints);

  // ── GRAPH 6: Constellation Map ────────────────────────────────────────────
  const g6 = buildConstellationGraph(constPoints, stftFP);

  // ── GRAPH 7: Band Energy ──────────────────────────────────────────────────
  const g7 = buildBandEnergyGraph(stftAnalysis, logBandBoundaries(NUM_BANDS, WORK_SR, FFT_SIZE_ANALYSIS));

  // ── GRAPH 8: Phase Spectrum ───────────────────────────────────────────────
  const g8 = buildPhaseGraph(stftAnalysis);

  // ── STEP 6+7+8: Wiener filter + OLA reconstruction ───────────────────────
  const { cleaned, noise, gainCurveAvg } = applyWienerAndReconstruct(
    stftAnalysis,
    noiseFloor,
    workSamples,
  );

  // ── GRAPH 9: Cleaned waveform ─────────────────────────────────────────────
  const g9 = buildWaveformGraph(cleaned, WORK_SR, "Cleaned Output Waveform");

  // ── GRAPH 10: Noise residual ──────────────────────────────────────────────
  const g10 = buildWaveformGraph(noise, WORK_SR, "Noise Residual (Removed Signal)");

  // ── STFT of cleaned for comparison ───────────────────────────────────────
  const stftCleaned = computeSTFT(cleaned, WORK_SR, FFT_SIZE_ANALYSIS, HOP_SIZE, true);

  // ── GRAPH 11: Before / After spectrum ────────────────────────────────────
  const g11 = buildBeforeAfterGraph(stftAnalysis, stftCleaned, noiseFloor);

  // ── GRAPH 12: Wiener gain curve ───────────────────────────────────────────
  const g12 = buildNRGainGraph(stftAnalysis, noiseFloor, gainCurveAvg);

  // ── STATS ─────────────────────────────────────────────────────────────────
  const avgNoiseFloorDb = 10 * Math.log10(
    noiseFloor.reduce((s, v) => s + v, 0) / noiseFloor.length + 1e-12,
  );
  const avgGain = gainCurveAvg.reduce((s, v) => s + v, 0) / gainCurveAvg.length;
  const inputSnr  = snrDb(workSamples, noise);
  const outputSnr = snrDb(cleaned, noise);
  const snrImprove = outputSnr - inputSnr;

  return {
    graphs: { g1_originalWaveform:     g1,
              g2_downsampledWaveform:   g2,
              g3_spectrogram:           g3,
              g4_frequencySpectrum:     g4,
              g5_psd:                   g5,
              g6_constellation:         g6,
              g7_bandEnergy:            g7,
              g8_phase:                 g8,
              g9_cleanedWaveform:       g9,
              g10_noiseResidual:        g10,
              g11_beforeAfterSpectrum:  g11,
              g12_nrGainCurve:          g12 },
    cleanedAudio: { samples: cleaned, sampleRate: WORK_SR, duration: cleaned.length / WORK_SR },
    noiseAudio:   { samples: noise,   sampleRate: WORK_SR, duration: noise.length   / WORK_SR },
    constellationPoints: constPoints,
    hashes,
    stats: {
      inputDuration:           rawMono.length / originalSampleRate,
      inputSampleRate:         originalSampleRate,
      workingSampleRate:       WORK_SR,
      totalSTFTFrames:         stftAnalysis.frames.length,
      totalConstellationPeaks: constPoints.length,
      totalHashes:             hashes.length,
      estimatedNoiseFloorDb:   avgNoiseFloorDb,
      avgWienerGain:           avgGain,
      snrImprovementDb:        snrImprove,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// WAV ENCODER — produce a downloadable WAV blob
// ─────────────────────────────────────────────────────────────

/**
 * Encode mono Float32 PCM into a standard 16-bit WAV ArrayBuffer.
 * Suitable for download or new Audio(URL.createObjectURL(blob)).
 */
export function encodeWAV(audio: MonoAudio): ArrayBuffer {
  const { samples, sampleRate } = audio;
  const numSamples = samples.length;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = numSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view   = new DataView(buffer);

  const write4 = (off: number, s: string) => {
    for (let i = 0; i < 4; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  write4(0, "RIFF");
  view.setUint32(4,  36 + dataSize, true);
  write4(8, "WAVE");
  write4(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  write4(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 32768 : s * 32767, true);
    offset += 2;
  }
  return buffer;
}

// ─────────────────────────────────────────────────────────────
// BROWSER HELPER — decode a File/Blob via Web Audio API
// ─────────────────────────────────────────────────────────────

/**
 * Decode any browser-supported audio file into raw PCM channels.
 * Call this first, then pass the result to processAudio().
 *
 * @example
 * const input = document.querySelector<HTMLInputElement>('#file-input')!;
 * input.addEventListener('change', async () => {
 *   const file = input.files![0];
 *   const { channels, sampleRate } = await decodeFile(file);
 *   const result = await processAudio(channels, sampleRate);
 *   // result.graphs has all 12 graph data objects
 *   // result.cleanedAudio has the denoised signal
 *   const wavBuf = encodeWAV(result.cleanedAudio);
 *   const url    = URL.createObjectURL(new Blob([wavBuf], { type: 'audio/wav' }));
 *   const a      = document.createElement('a');
 *   a.href       = url;
 *   a.download   = 'cleaned.wav';
 *   a.click();
 * });
 */
export async function decodeFile(file: File): Promise<{
  channels: Float32Array[];
  sampleRate: number;
  duration: number;
}> {
  const ctx     = new AudioContext();
  const buf     = await file.arrayBuffer();
  const decoded = await ctx.decodeAudioData(buf);
  await ctx.close();
  return {
    channels: Array.from(
      { length: decoded.numberOfChannels },
      (_, i) => decoded.getChannelData(i),
    ),
    sampleRate: decoded.sampleRate,
    duration:   decoded.duration,
  };
}

// ─────────────────────────────────────────────────────────────
// CANVAS RENDERING HELPERS
// These are thin helpers you call from your UI layer.
// They accept the graph data objects and a CanvasRenderingContext2D.
// ─────────────────────────────────────────────────────────────

/**
 * Draw a waveform graph (graphs 1, 2, 9, 10).
 *
 * @param ctx   2D canvas context
 * @param data  WaveformGraphData from processAudio()
 * @param color Stroke colour (CSS string)
 */
export function drawWaveform(
  ctx: CanvasRenderingContext2D,
  data: WaveformGraphData,
  color = "#378ADD",
): void {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const cx = H / 2;
  const scale = (cx * 0.9) / Math.max(data.peakAmplitude, 1e-6);

  ctx.clearRect(0, 0, W, H);
  // Centre line
  ctx.strokeStyle = "rgba(128,128,128,0.3)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, cx); ctx.lineTo(W, cx); ctx.stroke();

  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const n = data.amplitude.length;
  for (let i = 0; i < n; i++) {
    const x = (i / n) * W;
    const y = cx - data.amplitude[i] * scale;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // X-axis label ticks (every ~1 second)
  ctx.fillStyle = "rgba(128,128,128,0.7)";
  ctx.font = "10px monospace";
  const totalSec = data.durationSeconds;
  const tickStep = totalSec > 60 ? 10 : totalSec > 10 ? 2 : 1;
  for (let s = 0; s <= totalSec; s += tickStep) {
    const x = (s / totalSec) * W;
    ctx.beginPath(); ctx.moveTo(x, H - 8); ctx.lineTo(x, H); ctx.stroke();
    ctx.fillText(`${s}s`, x + 2, H - 1);
  }
}

/**
 * Draw the STFT spectrogram heatmap (graph 3).
 * Uses a perceptually uniform cyan→yellow→red palette.
 */
export function drawSpectrogram(
  ctx: CanvasRenderingContext2D,
  data: SpectrogramGraphData,
): void {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const { numFrames, numBins, pixelData } = data;
  const imgData = ctx.createImageData(W, H);

  for (let px = 0; px < W; px++) {
    const fIdx = Math.floor((px / W) * numFrames);
    for (let py = 0; py < H; py++) {
      const binIdx = Math.floor(((H - 1 - py) / H) * numBins);
      const v      = pixelData[fIdx * numBins + binIdx] ?? 0;
      const [r, g, b] = spectroColor(v);
      const i = (py * W + px) * 4;
      imgData.data[i]     = r;
      imgData.data[i + 1] = g;
      imgData.data[i + 2] = b;
      imgData.data[i + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

/** Inferno-inspired colormap: 0→dark, 0.5→orange, 1→yellow */
function spectroColor(v: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, v));
  if (t < 0.25)      return [Math.round(t * 4 * 80),  0,                       Math.round(80 + t * 4 * 80)];
  else if (t < 0.5)  return [Math.round(80 + (t - 0.25) * 4 * 175), Math.round((t - 0.25) * 4 * 60), Math.round(160 - (t - 0.25) * 4 * 160)];
  else if (t < 0.75) return [255, Math.round(60 + (t - 0.5) * 4 * 165),  0];
  else               return [255, Math.round(225 + (t - 0.75) * 4 * 30), Math.round((t - 0.75) * 4 * 255)];
}

/**
 * Draw average frequency spectrum (graph 4).
 */
export function drawFrequencySpectrum(
  ctx: CanvasRenderingContext2D,
  data: FrequencySpectrumGraphData,
  colorAvg  = "#1D9E75",
  colorPeak = "rgba(29,158,117,0.35)",
): void {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const n = data.frequencies.length;
  let maxMag = 0;
  for (const v of data.peakMagnitude) if (v > maxMag) maxMag = v;
  if (maxMag < 1e-9) return;

  ctx.clearRect(0, 0, W, H);

  // Peak envelope fill
  ctx.fillStyle = colorPeak;
  ctx.beginPath();
  ctx.moveTo(0, H);
  for (let k = 0; k < n; k++) {
    const x = (k / n) * W;
    const y = H - (data.peakMagnitude[k] / maxMag) * (H * 0.95);
    k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.lineTo(W, H); ctx.closePath(); ctx.fill();

  // Average line
  ctx.strokeStyle = colorAvg;
  ctx.lineWidth   = 1.5;
  ctx.beginPath();
  for (let k = 0; k < n; k++) {
    const x = (k / n) * W;
    const y = H - (data.averageMagnitude[k] / maxMag) * (H * 0.95);
    k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/**
 * Draw Power Spectral Density in dB (graph 5).
 * Signal = teal, noise floor = amber dashed.
 */
export function drawPSD(
  ctx: CanvasRenderingContext2D,
  data: PSDGraphData,
): void {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const n = data.psdDb.length;

  let minDb = Infinity, maxDb = -Infinity;
  for (const v of data.psdDb)     { if (v < minDb) minDb = v; if (v > maxDb) maxDb = v; }
  for (const v of data.noiseFloorDb) { if (v < minDb) minDb = v; }
  const range = maxDb - minDb || 1;

  ctx.clearRect(0, 0, W, H);

  const toY = (db: number) => H - ((db - minDb) / range) * (H * 0.9) - H * 0.05;
  const toX = (k: number)  => (k / n) * W;

  // Noise floor fill area between signal and noise
  ctx.fillStyle = "rgba(239,159,39,0.15)";
  ctx.beginPath();
  ctx.moveTo(0, toY(data.psdDb[0]));
  for (let k = 0; k < n; k++) ctx.lineTo(toX(k), toY(data.psdDb[k]));
  for (let k = n - 1; k >= 0; k--) ctx.lineTo(toX(k), toY(data.noiseFloorDb[k]));
  ctx.closePath(); ctx.fill();

  // Signal PSD
  ctx.strokeStyle = "#1D9E75"; ctx.lineWidth = 1.5; ctx.beginPath();
  for (let k = 0; k < n; k++) {
    const x = toX(k), y = toY(data.psdDb[k]);
    k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Noise floor
  ctx.strokeStyle = "#EF9F27"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.beginPath();
  for (let k = 0; k < n; k++) {
    const x = toX(k), y = toY(data.noiseFloorDb[k]);
    k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke(); ctx.setLineDash([]);
}

/**
 * Draw Shazam constellation map (graph 6).
 * Background is a faint spectrogram; peaks are coloured dots by band.
 */
export function drawConstellation(
  ctx: CanvasRenderingContext2D,
  data: ConstellationGraphData,
): void {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const BAND_COLORS = ["#E24B4A","#EF9F27","#1D9E75","#378ADD","#7F77DD","#D4537E"];

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0a0a12";
  ctx.fillRect(0, 0, W, H);

  for (const p of data.points) {
    const x  = (p.frameIndex / data.numFrames) * W;
    const y  = H - (p.binIndex / data.numBins) * H;
    const r  = 2.5;
    ctx.fillStyle = BAND_COLORS[p.bandIndex % BAND_COLORS.length];
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Draw band energy over time (graph 7).
 * Each band drawn as a semi-transparent filled line.
 */
export function drawBandEnergy(
  ctx: CanvasRenderingContext2D,
  data: BandEnergyGraphData,
): void {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const COLORS = ["#E24B4A","#EF9F27","#1D9E75","#378ADD","#7F77DD","#D4537E"];

  let minDb = Infinity, maxDb = -Infinity;
  for (const band of data.bandEnergies) {
    for (const v of band) { if (v < minDb) minDb = v; if (v > maxDb) maxDb = v; }
  }
  const range = maxDb - minDb || 1;

  ctx.clearRect(0, 0, W, H);

  const nF = data.timeAxis.length;
  for (let b = data.numBands - 1; b >= 0; b--) {
    const en = data.bandEnergies[b];
    ctx.strokeStyle = COLORS[b];
    ctx.lineWidth   = 1.5;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    for (let f = 0; f < nF; f++) {
      const x = (f / nF) * W;
      const y = H - ((en[f] - minDb) / range) * (H * 0.92) - H * 0.04;
      f === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/**
 * Draw phase spectrum (graph 8).
 */
export function drawPhaseSpectrum(
  ctx: CanvasRenderingContext2D,
  data: PhaseSpectrumGraphData,
): void {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const n = data.phase.length;
  const cx = H / 2;

  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(128,128,128,0.3)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, cx); ctx.lineTo(W, cx); ctx.stroke();

  ctx.strokeStyle = "#7F77DD"; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = 0; k < n; k++) {
    const x = (k / n) * W;
    const y = cx - (data.phase[k] / Math.PI) * (cx * 0.92);
    k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/**
 * Draw before/after spectrum overlay (graph 11).
 */
export function drawBeforeAfter(
  ctx: CanvasRenderingContext2D,
  data: BeforeAfterSpectrumGraphData,
): void {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const n = data.frequencies.length;

  let min = Infinity, max = -Infinity;
  for (const v of data.before) { if (v < min) min = v; if (v > max) max = v; }
  for (const v of data.after)  { if (v < min) min = v; if (v > max) max = v; }
  const range = max - min || 1;
  const toY = (db: number) => H - ((db - min) / range) * (H * 0.9) - H * 0.05;
  const toX = (k: number)  => (k / n) * W;

  ctx.clearRect(0, 0, W, H);

  // Before (red)
  ctx.strokeStyle = "#E24B4A"; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.7;
  ctx.beginPath();
  for (let k = 0; k < n; k++) {
    const x = toX(k), y = toY(data.before[k]);
    k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // After (green)
  ctx.strokeStyle = "#1D9E75"; ctx.lineWidth = 1.5; ctx.globalAlpha = 1;
  ctx.beginPath();
  for (let k = 0; k < n; k++) {
    const x = toX(k), y = toY(data.after[k]);
    k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Noise floor (amber dashed)
  ctx.strokeStyle = "#EF9F27"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.globalAlpha = 0.8;
  ctx.beginPath();
  for (let k = 0; k < n; k++) {
    const x = toX(k), y = toY(data.noiseFloor[k]);
    k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
}

/**
 * Draw Wiener gain curve (graph 12).
 * Gain H(f) line + SNR(f) reference on secondary axis.
 */
export function drawGainCurve(
  ctx: CanvasRenderingContext2D,
  data: NRGainCurveGraphData,
): void {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const n = data.gain.length;

  ctx.clearRect(0, 0, W, H);

  // Filled area under gain curve
  ctx.fillStyle = "rgba(55,138,221,0.2)";
  ctx.beginPath();
  ctx.moveTo(0, H);
  for (let k = 0; k < n; k++) {
    const x = (k / n) * W;
    const y = H - data.gain[k] * (H * 0.9) - H * 0.05;
    k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.lineTo(W, H); ctx.closePath(); ctx.fill();

  // Gain line
  ctx.strokeStyle = "#378ADD"; ctx.lineWidth = 2;
  ctx.beginPath();
  for (let k = 0; k < n; k++) {
    const x = (k / n) * W;
    const y = H - data.gain[k] * (H * 0.9) - H * 0.05;
    k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}