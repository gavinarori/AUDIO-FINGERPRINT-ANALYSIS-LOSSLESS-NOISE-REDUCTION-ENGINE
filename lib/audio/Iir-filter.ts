/**
 * ============================================================
 * IIR FILTER — BUTTERWORTH METHOD
 * Audio Signal Noise Reduction
 * ============================================================
 *
 * Theory drawn from:
 *  - Liu, Shabrina & Hardson, "Comparison of FIR and IIR Filters
 *    for Audio Signal Noise Reduction" (Ultima Computing, June 2023)
 *  - IIR transfer function:  H_LP(z) = b₀(z+1) / (z−a)     [Eq. 3]
 *  - Coefficient formulas:   a ≈ 1 − 2π(fc/fs)              [Eq. 4]
 *                             b₀ = (1−a) / 2                 [Eq. 5]
 *
 * Characteristics:
 *  ✔  Flat (maximally-smooth) pass-band response (Butterworth property)
 *  ✔  Fewer coefficients needed than FIR for equivalent sharpness
 *  ✔  Lower memory and computation per coefficient
 *  ✗  Non-linear phase response — introduces phase distortion
 *  ✗  Feedback loop — stability not guaranteed at all orders/cutoffs
 *
 * Pipeline:
 *  samples → computeIIRCoefficients → applyIIRFilter → FilterResult
 * ============================================================
 */

import type { MonoAudio } from "./audio-fingerprint";

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

export interface IIRFilterSpec {
  /** Sampling frequency in Hz (e.g. 48 000) */
  sampleRate: number;
  /** Filter order N (each 2nd-order section adds one biquad stage) */
  order: number;
  /** Cut-off frequency in Hz */
  cutoffHz: number;
  /** Pass-band type */
  type: "lowpass" | "highpass";
}

/**
 * Biquad (second-order) section coefficients.
 * Transfer function: H(z) = (b0 + b1·z⁻¹ + b2·z⁻²) / (1 + a1·z⁻¹ + a2·z⁻²)
 */
export interface BiquadSection {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export interface IIRCoefficients {
  /** Cascade of second-order sections */
  sections: BiquadSection[];
  /** Spec used to design these coefficients */
  spec: IIRFilterSpec;
  /** First-order pole location 'a' from paper Eq. 4 */
  poleA: number;
  /** Gain coefficient b₀ from paper Eq. 5 */
  gainB0: number;
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

export interface IIRFilterResult {
  /** Filtered audio samples */
  filtered: Float32Array;
  /** Isolated noise (original − filtered) */
  noise: Float32Array;
  /** SNR of the output signal in dB */
  snrDb: number;
  /** Per-stage timing and SNR metrics */
  stageMetrics: FilterStageMetrics[];
  /** The coefficients that were applied */
  coefficients: IIRCoefficients;
  /** Total wall-clock time in ms */
  totalElapsedMs: number;
}

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

/** Paper default: sampling rate 48 000 Hz, order 100, cut-off 4 000 Hz */
export const DEFAULT_IIR_SPEC: IIRFilterSpec = {
  sampleRate: 48_000,
  order:      100,
  cutoffHz:   4_000,
  type:       "lowpass",
};

// ─────────────────────────────────────────────────────────────
// UTILITY — SIGNAL METRICS
// ─────────────────────────────────────────────────────────────

function signalPower(samples: Float32Array | Float64Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return sum / samples.length;
}

/**
 * Compute Signal-to-Noise Ratio in dB.
 *
 *   SNR = 10 · log₁₀(P_signal / P_noise)          [Eq. 6, paper §II-C]
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
// STAGE 1 — BUTTERWORTH POLE / COEFFICIENT COMPUTATION
// ─────────────────────────────────────────────────────────────

/**
 * Compute the first-order Butterworth IIR pole 'a' and gain 'b₀'.
 *
 * From paper §II-B equations (4) and (5):
 *
 *   if fc < fs/4:   a ≈ 1 − 2π(fc/fs)
 *   if fc > fs/4:   a ≈ π − 1 − 2π(fc/fs)     (wrap correction)
 *
 *   b₀ = (1 − a) / 2
 *
 * The transfer function is:
 *   H_LP(z) = b₀(z + 1) / (z − a)             [Eq. 3]
 */
export function computeButterworthCoefficients(
  cutoffHz: number,
  sampleRate: number,
): { a: number; b0: number } {
  const ratio = cutoffHz / sampleRate;
  const a = cutoffHz < sampleRate / 4
    ? 1 - 2 * Math.PI * ratio
    : Math.PI - 1 - 2 * Math.PI * ratio;
  const b0 = (1 - a) / 2;
  return { a, b0 };
}

/**
 * Convert first-order {a, b0} IIR lowpass to a biquad section
 * by cascading two identical first-order sections.
 *
 * H_biquad(z) = H₁(z) · H₁(z)
 *
 * where H₁(z) = b₀(z+1)/(z−a)
 *
 * Resulting biquad numerator:  b₀²·(z+1)² = b₀²·(z²+2z+1)
 * Resulting biquad denominator: (z−a)²     = z²−2a·z+a²
 *
 * In standard z⁻¹ form (divide by z²):
 *   numerator:   b₀²·(1 + 2z⁻¹ + z⁻²)
 *   denominator: 1 − 2a·z⁻¹ + a²·z⁻²
 */
function firstOrderToBiquad(a: number, b0: number): BiquadSection {
  return {
    b0:  b0 * b0,
    b1:  2 * b0 * b0,
    b2:  b0 * b0,
    a1: -2 * a,          // sign convention: y[n] + a1·y[n-1] + a2·y[n-2] = ...
    a2:  a * a,
  };
}

/**
 * Design the full IIR filter as a cascade of second-order sections.
 *
 * The paper uses order 100 — achieved here by cascading 50 biquad stages
 * (each stage contributes order 2, so 50 × 2 = 100).
 * Cascading biquads is numerically more stable than a single high-order
 * difference equation.
 *
 * @param spec  Filter specification
 */
export function computeIIRCoefficients(spec: IIRFilterSpec): IIRCoefficients {
  const { cutoffHz, sampleRate, order, type } = spec;

  let { a, b0 } = computeButterworthCoefficients(cutoffHz, sampleRate);

  // For highpass: invert the lowpass response via frequency transformation
  // a_hp = −a_lp  (bilateral Z-transform frequency flip)
  if (type === "highpass") {
    a  = -a;
    b0 = (1 - Math.abs(a)) / 2;
  }

  const numSections = Math.max(1, Math.floor(order / 2));
  const biquad      = firstOrderToBiquad(a, b0);
  const sections: BiquadSection[] = Array.from({ length: numSections }, () => ({
    ...biquad,
  }));

  return { sections, spec, poleA: a, gainB0: b0 };
}

// ─────────────────────────────────────────────────────────────
// STAGE 2 — DIRECT FORM II BIQUAD FILTERING
// ─────────────────────────────────────────────────────────────

/**
 * Apply a single biquad section using Direct Form II transposed.
 *
 * Difference equations (Direct Form II):
 *   w[n]  = x[n]  − a1·w[n−1] − a2·w[n−2]
 *   y[n]  = b0·w[n] + b1·w[n−1] + b2·w[n−2]
 *
 * This is the IIR's defining feature: the recursive (feedback) term
 * `a1·w[n−1] + a2·w[n−2]` feeds previous outputs back, giving the
 * filter its infinite impulse response.
 *
 * @param input   Input samples
 * @param biquad  Second-order section coefficients
 * @returns       Filtered output, same length as input
 */
export function applyBiquadSection(
  input:  Float32Array,
  biquad: BiquadSection,
): Float32Array {
  const { b0, b1, b2, a1, a2 } = biquad;
  const N   = input.length;
  const out = new Float32Array(N);

  let w1 = 0; // delay state w[n−1]
  let w2 = 0; // delay state w[n−2]

  for (let n = 0; n < N; n++) {
    const w  = input[n] - a1 * w1 - a2 * w2;
    out[n]   = b0 * w + b1 * w1 + b2 * w2;
    w2 = w1;
    w1 = w;
  }

  return out;
}

/**
 * Apply the full cascaded IIR filter (all biquad sections in series).
 *
 * y = section_1 → section_2 → … → section_N(x)
 *
 * Cascading is equivalent to convolving the individual impulse responses,
 * and results in the Nth-order Butterworth magnitude response.
 */
export function applyCascadedIIR(
  samples:      Float32Array,
  coefficients: IIRCoefficients,
): Float32Array {
  let buf = samples;
  for (const section of coefficients.sections) {
    buf = applyBiquadSection(buf, section);
  }
  return buf;
}

// ─────────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────

/**
 * Run the complete IIR noise-reduction pipeline with per-stage timing and SNR.
 *
 * Stages:
 *   1. Butterworth pole/coefficient computation  (Eq. 3–5)
 *   2. Biquad cascade construction               (order / 2 sections)
 *   3. Direct Form II feedback filtering         (the recursive loop)
 *   4. Noise isolation
 *   5. SNR measurement                           (Eq. 6)
 *
 * @param audio  Mono audio to filter
 * @param spec   Filter specification (defaults to paper §IV settings)
 * @returns      Full result including per-stage metrics
 */
export function applyIIRFilter(
  audio: MonoAudio,
  spec: IIRFilterSpec = DEFAULT_IIR_SPEC,
): IIRFilterResult {
  const stageMetrics: FilterStageMetrics[] = [];
  const overallStart = performance.now();

  // ── Stage 1: Butterworth coefficient computation ─────────────
  let t0 = performance.now();
  const { a, b0 } = computeButterworthCoefficients(spec.cutoffHz, spec.sampleRate);
  stageMetrics.push({
    label:     "Stage 1 — Butterworth pole & gain computation  (Eq. 3–5)",
    elapsedMs: performance.now() - t0,
    snrDb:     null,
    note:      `a = ${a.toFixed(6)},  b₀ = ${b0.toFixed(6)},  fc = ${spec.cutoffHz} Hz`,
  });

  // ── Stage 2: Biquad cascade construction ────────────────────
  t0 = performance.now();
  const coefficients = computeIIRCoefficients(spec);
  stageMetrics.push({
    label:     "Stage 2 — Biquad cascade construction",
    elapsedMs: performance.now() - t0,
    snrDb:     null,
    note:      `${coefficients.sections.length} biquad sections  (order ${spec.order})`,
  });

  // ── Stage 3: Direct Form II feedback filtering ───────────────
  t0 = performance.now();
  const filtered = applyCascadedIIR(audio.samples, coefficients);
  const feedbackElapsed = performance.now() - t0;

  const noiseAfterFeedback = new Float32Array(audio.samples.length);
  for (let i = 0; i < audio.samples.length; i++) {
    noiseAfterFeedback[i] = audio.samples[i] - filtered[i];
  }
  const snrAfterFeedback = computeSNR(filtered, noiseAfterFeedback);

  stageMetrics.push({
    label:     "Stage 3 — Direct Form II recursive filtering  y[n] = b₀w[n] + b₁w[n−1] + b₂w[n−2]",
    elapsedMs: feedbackElapsed,
    snrDb:     snrAfterFeedback,
    note:      `${audio.samples.length.toLocaleString()} samples processed`,
  });

  // ── Stage 4: Noise isolation ─────────────────────────────────
  t0 = performance.now();
  const noise = noiseAfterFeedback; // already computed
  stageMetrics.push({
    label:     "Stage 4 — Noise isolation  noise[n] = original[n] − filtered[n]",
    elapsedMs: performance.now() - t0,
    snrDb:     null,
    note:      "Residual = removed frequency components",
  });

  // ── Stage 5: SNR measurement ─────────────────────────────────
  t0 = performance.now();
  const snrDb = computeSNR(filtered, noise);
  stageMetrics.push({
    label:     "Stage 5 — SNR measurement  10·log₁₀(P_signal / P_noise)",
    elapsedMs: performance.now() - t0,
    snrDb,
    note:      `IIR SNR = ${snrDb.toFixed(4)} dB`,
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
 * Pretty-print an `IIRFilterResult` to `console.table` + `console.log`.
 */
export function printIIRReport(result: IIRFilterResult): void {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log(" IIR FILTER REPORT  (Butterworth Method)");
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