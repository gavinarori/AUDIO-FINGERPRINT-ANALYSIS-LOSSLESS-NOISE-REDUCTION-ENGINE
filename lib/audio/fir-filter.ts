/**
 * ============================================================
 * FIR FILTER — HAMMING WINDOW METHOD
 * Audio Signal Noise Reduction
 * ============================================================
 *
 * Theory drawn from:
 *  - Liu, Shabrina & Hardson, "Comparison of FIR and IIR Filters
 *    for Audio Signal Noise Reduction" (Ultima Computing, June 2023)
 *  - Hamming window: w(n) = 0.54 − 0.46·cos(2πn/(N−1))
 *  - FIR ideal impulse response (low-pass): h_D(n) = sin(n·ωc) / (n·π)
 *
 * Characteristics:
 *  ✔  Linear (zero) phase — no phase distortion
 *  ✔  Always stable (non-recursive)
 *  ✔  Shorter transition band at equivalent order
 *  ✗  Requires more coefficients than IIR for sharp cutoff
 *  ✗  Higher computational cost per sample
 *
 * Pipeline:
 *  samples → designFIRCoefficients → applyFIRFilter → FilterResult
 * ============================================================
 */

import type { MonoAudio } from "./lib/audio/audio-fingerprint";

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

export interface FIRFilterSpec {
  /** Sampling frequency in Hz (e.g. 48 000) */
  sampleRate: number;
  /** Filter order N — number of taps = order + 1 */
  order: number;
  /** Cut-off frequency in Hz */
  cutoffHz: number;
  /** Pass-band type */
  type: "lowpass" | "highpass" | "bandpass" | "bandstop";
  /** Optional second cut-off Hz (required for bandpass / bandstop) */
  cutoff2Hz?: number;
}

export interface FIRCoefficients {
  /** The h[n] tap weights, length = order + 1 */
  taps: Float64Array;
  /** Spec used to design these coefficients */
  spec: FIRFilterSpec;
  /** Normalised cut-off ωc = 2π·fc/fs (radians / sample) */
  omegaC: number;
  /** Hamming window values used during design */
  hammingWeights: Float64Array;
}

export interface FilterStageMetrics {
  /** Label describing this stage */
  label: string;
  /** Wall-clock ms taken for this stage */
  elapsedMs: number;
  /** Signal-to-Noise Ratio in dB (if calculable at this stage) */
  snrDb: number | null;
  /** Any extra info */
  note?: string;
}

export interface FIRFilterResult {
  /** Filtered audio samples */
  filtered: Float32Array;
  /** Isolated noise (original − filtered) */
  noise: Float32Array;
  /** SNR of the output signal in dB */
  snrDb: number;
  /** Per-stage timing and SNR metrics */
  stageMetrics: FilterStageMetrics[];
  /** The coefficients that were applied */
  coefficients: FIRCoefficients;
  /** Total wall-clock time in ms */
  totalElapsedMs: number;
}

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

/** Paper default: sampling rate 48 000 Hz, order 100, cut-off 4 000 Hz */
export const DEFAULT_FIR_SPEC: FIRFilterSpec = {
  sampleRate: 48_000,
  order:      100,
  cutoffHz:   4_000,
  type:       "lowpass",
};

// ─────────────────────────────────────────────────────────────
// UTILITY — SIGNAL METRICS
// ─────────────────────────────────────────────────────────────

/**
 * Compute signal power (mean of squares).
 */
function signalPower(samples: Float32Array | Float64Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return sum / samples.length;
}

/**
 * Compute Signal-to-Noise Ratio in dB.
 *
 *   SNR = 10 · log₁₀(P_signal / P_noise)          [Eq. 6, paper §II-C]
 *
 * @param signal  The "clean" / filtered output
 * @param noise   The removed component (original − filtered)
 */
export function computeSNR(
  signal: Float32Array | Float64Array,
  noise:  Float32Array | Float64Array,
): number {
  const pSig   = signalPower(signal);
  const pNoise = signalPower(noise);
  if (pNoise < 1e-30) return Infinity;
  return 10 * Math.log10(pSig / pNoise);
}

// ─────────────────────────────────────────────────────────────
// STAGE 1 — HAMMING WINDOW
// ─────────────────────────────────────────────────────────────

/**
 * Generate the Hamming window of length N.
 *
 *   w(n) = 0.54 − 0.46 · cos(2πn / (N−1))
 *
 * The Hamming window is the recommended window for FIR design in the
 * paper (§II-B): "provides the best results compared to other FIR types
 * for the exact specifications."
 *
 * @param N  Window length (= filter order + 1)
 */
export function hammingWindow(N: number): Float64Array {
  const w = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    w[n] = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (N - 1));
  }
  return w;
}

// ─────────────────────────────────────────────────────────────
// STAGE 2 — IDEAL IMPULSE RESPONSE
// ─────────────────────────────────────────────────────────────

/**
 * Compute the ideal (infinite-length) low-pass impulse response centred at n=0.
 *
 *   h_D(n) = sin(n · ωc) / (n · π)          [Eq. 2, paper §II-B]
 *   h_D(0) = 2·fc / fs  (sinc limit)
 *
 * The design is shifted to be causal by evaluating at n − M/2
 * where M = filter order.
 */
function idealLowPass(n: number, omegaC: number): number {
  if (n === 0) return omegaC / Math.PI; // sinc limit: 2fc = ωc/π
  return Math.sin(n * omegaC) / (n * Math.PI);
}

/**
 * Compute the ideal high-pass impulse response.
 *   h_HP(n) = δ(n) − h_LP(n)
 */
function idealHighPass(n: number, omegaC: number): number {
  const lp = idealLowPass(n, omegaC);
  return (n === 0 ? 1 - lp : -lp);
}

// ─────────────────────────────────────────────────────────────
// STAGE 3 — FIR COEFFICIENT DESIGN
// ─────────────────────────────────────────────────────────────

/**
 * Design FIR filter coefficients using the Hamming Window method.
 *
 * Steps:
 *   1. Compute normalised cut-off:  ωc = 2π·fc / fs
 *   2. Evaluate ideal impulse response h_D[n] for n = 0 … order
 *      (centred at n = order/2 to make the design causal)
 *   3. Multiply by the Hamming window:  h[n] = h_D[n − M/2] · w[n]
 *
 * @param spec  Filter specification
 * @returns     Coefficients ready to pass to `applyFIRFilter`
 */
export function designFIRCoefficients(spec: FIRFilterSpec): FIRCoefficients {
  const { sampleRate, order, cutoffHz, type, cutoff2Hz } = spec;
  const numTaps  = order + 1;
  const mid      = order / 2; // causal shift
  const omegaC   = (2 * Math.PI * cutoffHz) / sampleRate;
  const omegaC2  = cutoff2Hz != null
    ? (2 * Math.PI * cutoff2Hz) / sampleRate
    : 0;

  const hammingWeights = hammingWindow(numTaps);
  const taps = new Float64Array(numTaps);

  for (let n = 0; n < numTaps; n++) {
    const m  = n - mid; // centred index
    let h: number;

    switch (type) {
      case "lowpass":
        h = idealLowPass(m, omegaC);
        break;

      case "highpass":
        h = idealHighPass(m, omegaC);
        break;

      case "bandpass":
        // BPF = LP(ωc2) − LP(ωc1)
        h = idealLowPass(m, omegaC2) - idealLowPass(m, omegaC);
        break;

      case "bandstop":
        // BSF = LP(ωc1) + HP(ωc2)  = LP(ωc1) + [δ − LP(ωc2)]
        h = idealLowPass(m, omegaC) - idealLowPass(m, omegaC2) + (m === 0 ? 1 : 0);
        break;

      default:
        h = idealLowPass(m, omegaC);
    }

    taps[n] = h * hammingWeights[n];
  }

  // Normalise taps so DC gain = 1 (for lowpass / bandstop)
  if (type === "lowpass" || type === "bandstop") {
    let dcGain = 0;
    for (const t of taps) dcGain += t;
    if (dcGain > 1e-12) for (let n = 0; n < numTaps; n++) taps[n] /= dcGain;
  }

  return { taps, spec, omegaC, hammingWeights };
}

// ─────────────────────────────────────────────────────────────
// STAGE 4 — DIRECT-FORM CONVOLUTION (FIR apply)
// ─────────────────────────────────────────────────────────────

/**
 * Apply FIR filter via direct-form convolution.
 *
 *   y[n] = Σ_{k=0}^{M} h[k] · x[n − k]
 *
 * This is a non-recursive (feed-forward only) operation —
 * guaranteeing unconditional stability, which is a key advantage
 * of FIR over IIR (paper §II-B, Table I).
 *
 * @param samples     Input PCM float32 array
 * @param coefficients  FIR coefficients from `designFIRCoefficients`
 * @returns           Filtered output, same length as input
 */
export function convolve(
  samples: Float32Array,
  coefficients: FIRCoefficients,
): Float32Array {
  const { taps } = coefficients;
  const M   = taps.length;
  const N   = samples.length;
  const out = new Float32Array(N);

  for (let n = 0; n < N; n++) {
    let acc = 0;
    for (let k = 0; k < M; k++) {
      const idx = n - k;
      if (idx >= 0) acc += taps[k] * samples[idx];
    }
    out[n] = acc;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────

/**
 * Run the complete FIR noise-reduction pipeline with per-stage timing and SNR.
 *
 * Stages:
 *   1. Hamming window construction
 *   2. Ideal impulse response computation
 *   3. Coefficient windowing (h[n] = h_D[n] · w[n])
 *   4. Direct-form convolution (filtering)
 *   5. Noise isolation and SNR scoring
 *
 * @param audio  Mono audio to filter
 * @param spec   Filter specification (defaults to paper §IV settings)
 * @returns      Full result including per-stage metrics
 */
export function applyFIRFilter(
  audio: MonoAudio,
  spec: FIRFilterSpec = DEFAULT_FIR_SPEC,
): FIRFilterResult {
  const stageMetrics: FilterStageMetrics[] = [];
  const overallStart = performance.now();

  // ── Stage 1: Hamming window ──────────────────────────────────
  let t0 = performance.now();
  const numTaps = spec.order + 1;
  hammingWindow(numTaps); // result folded into designFIRCoefficients below
  stageMetrics.push({
    label:     "Stage 1 — Hamming window construction",
    elapsedMs: performance.now() - t0,
    snrDb:     null,
    note:      `${numTaps} taps  |  w(n) = 0.54 − 0.46·cos(2πn/${numTaps - 1})`,
  });

  // ── Stage 2: Ideal impulse response ─────────────────────────
  t0 = performance.now();
  const omegaC = (2 * Math.PI * spec.cutoffHz) / spec.sampleRate;
  // (evaluation is embedded in designFIRCoefficients; we time the design step as a whole)
  stageMetrics.push({
    label:     "Stage 2 — Ideal impulse response derivation",
    elapsedMs: performance.now() - t0,
    snrDb:     null,
    note:      `ωc = 2π·${spec.cutoffHz}/${spec.sampleRate} = ${omegaC.toFixed(6)} rad/sample`,
  });

  // ── Stage 3: Windowed coefficient design ────────────────────
  t0 = performance.now();
  const coefficients = designFIRCoefficients(spec);
  stageMetrics.push({
    label:     "Stage 3 — Windowed coefficient design (h[n] = h_D[n] · w[n])",
    elapsedMs: performance.now() - t0,
    snrDb:     null,
    note:      `Order ${spec.order}, type=${spec.type}, cutoff=${spec.cutoffHz} Hz`,
  });

  // ── Stage 4: Direct-form convolution ────────────────────────
  t0 = performance.now();
  const filtered = convolve(audio.samples, coefficients);
  const convElapsed = performance.now() - t0;

  // Noise residual = original − filtered
  const noise = new Float32Array(audio.samples.length);
  for (let i = 0; i < audio.samples.length; i++) {
    noise[i] = audio.samples[i] - filtered[i];
  }
  const snrAfterConvolution = computeSNR(filtered, noise);

  stageMetrics.push({
    label:     "Stage 4 — Direct-form convolution  y[n] = Σ h[k]·x[n−k]",
    elapsedMs: convElapsed,
    snrDb:     snrAfterConvolution,
    note:      `${audio.samples.length.toLocaleString()} samples processed`,
  });

  // ── Stage 5: SNR scoring ─────────────────────────────────────
  t0 = performance.now();
  const snrDb = computeSNR(filtered, noise);
  stageMetrics.push({
    label:     "Stage 5 — SNR measurement  10·log₁₀(P_signal / P_noise)",
    elapsedMs: performance.now() - t0,
    snrDb,
    note:      `FIR SNR = ${snrDb.toFixed(4)} dB`,
  });

  return {
    filtered,
    noise,
    snrDb,
    stageMetrics,
    coefficients,
    totalElapsedMs: performance.now() - overallStart,
  };
}

// ─────────────────────────────────────────────────────────────
// HELPER — Format a result summary to the console
// ─────────────────────────────────────────────────────────────

/**
 * Pretty-print an `FIRFilterResult` to `console.table` + `console.log`.
 */
export function printFIRReport(result: FIRFilterResult): void {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log(" FIR FILTER REPORT  (Hamming Window Method)");
  console.log("═══════════════════════════════════════════════════════");
  console.table(
    result.stageMetrics.map((m) => ({
      Stage:       m.label,
      "Time (ms)": m.elapsedMs.toFixed(4),
      "SNR (dB)":  m.snrDb != null ? m.snrDb.toFixed(4) : "—",
      Note:        m.note ?? "",
    })),
  );
  console.log(`\n  ✔  Final SNR   : ${result.snrDb.toFixed(4)} dB`);
  console.log(`  ✔  Total time  : ${result.totalElapsedMs.toFixed(4)} ms`);
  console.log("═══════════════════════════════════════════════════════\n");
}