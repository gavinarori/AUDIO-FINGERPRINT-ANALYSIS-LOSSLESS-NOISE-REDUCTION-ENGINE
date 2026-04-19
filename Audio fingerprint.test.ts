/**
 * ============================================================
 * AUDIO FINGERPRINT — NOISE REDUCTION TEST SUITE
 * ============================================================
 *
 * Tests the full audio processing pipeline (audio-fingerprint.ts)
 * and both filter modules (fir-filter.ts, iir-filter.ts), measuring:
 *
 *   • SNR (dB) achieved at every pipeline stage
 *   • Execution time (ms) at every pipeline stage
 *   • Head-to-head FIR vs IIR comparison  (mirrors Table III, paper §IV)
 *
 * Test signal specification (matches paper §III–IV):
 *   - Sample rate : 48 000 Hz
 *   - Duration    : 1 second of 440 Hz sine (the "speech" signal)
 *   - Noise       : 5 000 Hz sine added at amplitude 0.3 (electrical interference)
 *   - Filter type : low-pass, cut-off 4 000 Hz, order 100
 *
 * Run (Node ≥ 18, tsx or ts-node):
 *   npx tsx audio-fingerprint.test.ts
 *   npx ts-node audio-fingerprint.test.ts
 * ============================================================
 */

// ── Polyfill `performance` for Node < 16 ────────────────────
if (typeof performance === "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { performance: nodePerf } = require("perf_hooks");
  (globalThis as Record<string, unknown>).performance = nodePerf;
}

import {
  // Core pipeline functions
  toMono,
  resample,
  computeSTFT,
  estimateNoiseFloor,
  applyWienerAndReconstruct,
  extractConstellation,
  buildHashes,
  logBandBoundaries,
  // Types
  type RawAudio,
  type MonoAudio,
  type ProcessingResult,
} from "./audio-fingerprint";

import {
  applyFIRFilter,
  printFIRReport,
  DEFAULT_FIR_SPEC,
  type FIRFilterResult,
} from "./fir-filter";

import {
  applyIIRFilter,
  printIIRReport,
  DEFAULT_IIR_SPEC,
  type IIRFilterResult,
} from "./iir-filter";

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  actual: number | string;
  expected: string;
  message: string;
}

interface BenchmarkRow {
  Filter:            string;
  "Total time (ms)": string;
  "SNR (dB)":        string;
  "SNR improvement": string;
}

// ─────────────────────────────────────────────────────────────
// TEST REGISTRY
// ─────────────────────────────────────────────────────────────

const results: TestResult[] = [];
let passed = 0;
let failed = 0;

function assert(
  name: string,
  condition: boolean,
  actual: number | string,
  expected: string,
  message = "",
): void {
  const r: TestResult = { name, passed: condition, actual, expected, message };
  results.push(r);
  if (condition) {
    passed++;
    console.log(`  ✔  ${name}`);
  } else {
    failed++;
    console.error(`  ✗  ${name}`);
    console.error(`       expected: ${expected}`);
    console.error(`       actual  : ${actual}`);
    if (message) console.error(`       note    : ${message}`);
  }
}

function section(title: string): void {
  console.log(`\n${"─".repeat(60)}`);
  console.log(` ${title}`);
  console.log("─".repeat(60));
}

// ─────────────────────────────────────────────────────────────
// SIGNAL GENERATORS
// ─────────────────────────────────────────────────────────────

/** Generate a pure sine wave at `freqHz`. */
function generateSine(
  freqHz:     number,
  sampleRate: number,
  duration:   number,
  amplitude = 1.0,
): Float32Array {
  const N = Math.round(sampleRate * duration);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return out;
}

/** Add two Float32Arrays element-wise. */
function addSignals(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + b[i];
  return out;
}

/** Compute signal power (mean square). */
function power(s: Float32Array): number {
  let sum = 0;
  for (const v of s) sum += v * v;
  return sum / s.length;
}

/** Compute SNR in dB: 10·log₁₀(P_signal / P_noise). */
function snrDb(signal: Float32Array, noise: Float32Array): number {
  const pS = power(signal);
  const pN = power(noise);
  return 10 * Math.log10(pS / Math.max(pN, 1e-30));
}

// ─────────────────────────────────────────────────────────────
// TEST FIXTURE — synthetic 48 kHz, 1 s audio with 5 000 Hz noise
// ─────────────────────────────────────────────────────────────

const FS        = 48_000;   // sampling rate (paper §IV, Table II)
const DURATION  = 1.0;      // seconds
const SIG_FREQ  = 440;      // Hz — the "speech" signal (fundamental A)
const NOISE_FREQ = 5_000;   // Hz — electrical interference (paper §III)
const NOISE_AMP  = 0.3;     // relative amplitude of the noise component

const cleanSignal = generateSine(SIG_FREQ,   FS, DURATION, 1.0);
const noiseSignal = generateSine(NOISE_FREQ, FS, DURATION, NOISE_AMP);
const noisySignal = addSignals(cleanSignal, noiseSignal);

const SNR_BEFORE = snrDb(cleanSignal, noiseSignal);

/** Wrap noisySignal as a MonoAudio for the filter modules. */
const monoAudio: MonoAudio = {
  samples:    noisySignal,
  sampleRate: FS,
  duration:   DURATION,
};

/** Wrap noisySignal as a RawAudio for the full pipeline. */
const rawAudio: RawAudio = {
  channels:   [noisySignal],
  sampleRate: FS,
  duration:   DURATION,
  numChannels: 1,
  numSamples: noisySignal.length,
};

// ─────────────────────────────────────────────────────────────
// SECTION 1 — SIGNAL FIXTURE VALIDATION
// ─────────────────────────────────────────────────────────────

section("1. Signal Fixture Validation");

assert(
  "Clean signal has expected sample count",
  cleanSignal.length === FS * DURATION,
  cleanSignal.length,
  `${FS * DURATION}`,
);

assert(
  "Noisy signal is the same length as the clean signal",
  noisySignal.length === cleanSignal.length,
  noisySignal.length,
  `${cleanSignal.length}`,
);

assert(
  "SNR before filtering is finite",
  isFinite(SNR_BEFORE),
  SNR_BEFORE.toFixed(4),
  "finite number",
);

assert(
  "SNR before filtering is positive (signal > noise)",
  SNR_BEFORE > 0,
  `${SNR_BEFORE.toFixed(4)} dB`,
  "> 0 dB",
);

console.log(`\n  📊 Reference SNR (before filtering): ${SNR_BEFORE.toFixed(4)} dB`);

// ─────────────────────────────────────────────────────────────
// SECTION 2 — FIR FILTER PIPELINE (stage-by-stage)
// ─────────────────────────────────────────────────────────────

section("2. FIR Filter — Stage-by-Stage Metrics  (Hamming Window, order 100)");

let firResult: FIRFilterResult;
{
  const t0 = performance.now();
  firResult = applyFIRFilter(monoAudio, { ...DEFAULT_FIR_SPEC, sampleRate: FS });
  const totalMs = performance.now() - t0;

  console.log(`\n  Stage breakdown:`);
  for (const m of firResult.stageMetrics) {
    const snrStr = m.snrDb != null ? `${m.snrDb.toFixed(4)} dB` : "—";
    console.log(`    [${m.elapsedMs.toFixed(4).padStart(9)} ms]  SNR: ${snrStr.padStart(12)}  ${m.label}`);
    if (m.note) console.log(`       └─ ${m.note}`);
  }

  assert(
    "FIR filter produces output of correct length",
    firResult.filtered.length === noisySignal.length,
    firResult.filtered.length,
    `${noisySignal.length}`,
  );

  assert(
    "FIR filter: SNR improves after filtering",
    firResult.snrDb > SNR_BEFORE,
    `${firResult.snrDb.toFixed(4)} dB`,
    `> ${SNR_BEFORE.toFixed(4)} dB`,
  );

  assert(
    "FIR filter: SNR is at least 5 dB above unfiltered",
    firResult.snrDb >= SNR_BEFORE + 5,
    `${firResult.snrDb.toFixed(4)} dB`,
    `≥ ${(SNR_BEFORE + 5).toFixed(4)} dB`,
  );

  assert(
    "FIR filter: total execution time is recorded as positive",
    firResult.totalElapsedMs > 0,
    `${firResult.totalElapsedMs.toFixed(4)} ms`,
    "> 0 ms",
  );

  assert(
    "FIR filter: all 5 stages have timing entries",
    firResult.stageMetrics.length === 5,
    firResult.stageMetrics.length,
    "5",
  );

  assert(
    "FIR filter: coefficient tap count = order + 1 = 101",
    firResult.coefficients.taps.length === DEFAULT_FIR_SPEC.order + 1,
    firResult.coefficients.taps.length,
    `${DEFAULT_FIR_SPEC.order + 1}`,
  );
}

// ─────────────────────────────────────────────────────────────
// SECTION 3 — IIR FILTER PIPELINE (stage-by-stage)
// ─────────────────────────────────────────────────────────────

section("3. IIR Filter — Stage-by-Stage Metrics  (Butterworth, order 100)");

let iirResult: IIRFilterResult;
{
  const t0 = performance.now();
  iirResult = applyIIRFilter(monoAudio, { ...DEFAULT_IIR_SPEC, sampleRate: FS });
  const totalMs = performance.now() - t0;

  console.log(`\n  Stage breakdown:`);
  for (const m of iirResult.stageMetrics) {
    const snrStr = m.snrDb != null ? `${m.snrDb.toFixed(4)} dB` : "—";
    console.log(`    [${m.elapsedMs.toFixed(4).padStart(9)} ms]  SNR: ${snrStr.padStart(12)}  ${m.label}`);
    if (m.note) console.log(`       └─ ${m.note}`);
  }

  assert(
    "IIR filter produces output of correct length",
    iirResult.filtered.length === noisySignal.length,
    iirResult.filtered.length,
    `${noisySignal.length}`,
  );

  assert(
    "IIR filter: SNR improves after filtering",
    iirResult.snrDb > SNR_BEFORE,
    `${iirResult.snrDb.toFixed(4)} dB`,
    `> ${SNR_BEFORE.toFixed(4)} dB`,
  );

  assert(
    "IIR filter: SNR is at least 5 dB above unfiltered",
    iirResult.snrDb >= SNR_BEFORE + 5,
    `${iirResult.snrDb.toFixed(4)} dB`,
    `≥ ${(SNR_BEFORE + 5).toFixed(4)} dB`,
  );

  assert(
    "IIR filter: total execution time is recorded as positive",
    iirResult.totalElapsedMs > 0,
    `${iirResult.totalElapsedMs.toFixed(4)} ms`,
    "> 0 ms",
  );

  assert(
    "IIR filter: all 5 stages have timing entries",
    iirResult.stageMetrics.length === 5,
    iirResult.stageMetrics.length,
    "5",
  );

  assert(
    "IIR filter: biquad section count = order / 2 = 50",
    iirResult.coefficients.sections.length === DEFAULT_IIR_SPEC.order / 2,
    iirResult.coefficients.sections.length,
    `${DEFAULT_IIR_SPEC.order / 2}`,
  );
}

// ─────────────────────────────────────────────────────────────
// SECTION 4 — FIR vs IIR HEAD-TO-HEAD COMPARISON
// ─────────────────────────────────────────────────────────────

section("4. FIR vs IIR Head-to-Head Comparison  (mirrors paper Table III)");

{
  const firSNR  = firResult.snrDb;
  const iirSNR  = iirResult.snrDb;
  const firTime = firResult.totalElapsedMs;
  const iirTime = iirResult.totalElapsedMs;

  const comparison: BenchmarkRow[] = [
    {
      Filter:             "Unfiltered",
      "Total time (ms)":  "—",
      "SNR (dB)":         SNR_BEFORE.toFixed(4),
      "SNR improvement":  "baseline",
    },
    {
      Filter:             "IIR (Butterworth)",
      "Total time (ms)":  iirTime.toFixed(4),
      "SNR (dB)":         iirSNR.toFixed(4),
      "SNR improvement":  `+${(iirSNR - SNR_BEFORE).toFixed(4)} dB`,
    },
    {
      Filter:             "FIR (Hamming Window)",
      "Total time (ms)":  firTime.toFixed(4),
      "SNR (dB)":         firSNR.toFixed(4),
      "SNR improvement":  `+${(firSNR - SNR_BEFORE).toFixed(4)} dB`,
    },
  ];

  console.log("\n  Results (matches paper §IV Table III format):\n");
  console.table(comparison);

  // Paper conclusion: FIR SNR (31.4782 dB) > IIR SNR (31.4774 dB)
  assert(
    "FIR achieves higher SNR than IIR (paper conclusion §V)",
    firSNR >= iirSNR,
    `FIR ${firSNR.toFixed(4)} dB  vs  IIR ${iirSNR.toFixed(4)} dB`,
    "FIR SNR ≥ IIR SNR",
  );

  // Paper conclusion: FIR faster than IIR (0.165 s vs 0.826 s)
  assert(
    "FIR executes faster than IIR (paper conclusion §V)",
    firTime < iirTime,
    `FIR ${firTime.toFixed(4)} ms  vs  IIR ${iirTime.toFixed(4)} ms`,
    "FIR time < IIR time",
  );

  assert(
    "Both filters improve upon unfiltered SNR",
    firSNR > SNR_BEFORE && iirSNR > SNR_BEFORE,
    `FIR=${firSNR.toFixed(2)}, IIR=${iirSNR.toFixed(2)}, baseline=${SNR_BEFORE.toFixed(2)}`,
    "both > baseline",
  );

  console.log(`\n  📊 FIR SNR gain : +${(firSNR - SNR_BEFORE).toFixed(4)} dB over unfiltered`);
  console.log(`  📊 IIR SNR gain : +${(iirSNR - SNR_BEFORE).toFixed(4)} dB over unfiltered`);
  console.log(`  📊 FIR vs IIR   : FIR is ${(iirTime - firTime).toFixed(4)} ms faster`);
}

// ─────────────────────────────────────────────────────────────
// SECTION 5 — AUDIO FINGERPRINT PIPELINE (Wiener / STFT path)
// ─────────────────────────────────────────────────────────────

section("5. Audio Fingerprint Pipeline — Wiener Filter Stages");

{
  // Step 1: Stereo → Mono
  let t = performance.now();
  const mono = toMono(rawAudio.channels);
  const monoMs = performance.now() - t;
  console.log(`  [${monoMs.toFixed(4).padStart(9)} ms]  Step 1 — Stereo → Mono  (${mono.length} samples)`);

  // Step 2: Downsample
  t = performance.now();
  const downsampled = resample(mono, FS, 8_192);
  const downsampleMs = performance.now() - t;
  console.log(`  [${downsampleMs.toFixed(4).padStart(9)} ms]  Step 2 — Downsample ${FS} Hz → 8192 Hz  (${downsampled.length} samples)`);

  assert(
    "Downsampled length ≈ original × (8192/48000)",
    Math.abs(downsampled.length - Math.floor(mono.length * 8_192 / FS)) <= 1,
    downsampled.length,
    `~${Math.floor(mono.length * 8_192 / FS)}`,
  );

  // Step 3: STFT
  t = performance.now();
  const stft = computeSTFT(downsampled, 8_192, 2048, 32, true);
  const stftMs = performance.now() - t;
  const stftSNR = snrDb(
    new Float32Array(stft.frames.flatMap(f => Array.from(f.magnitude))),
    new Float32Array(stft.frames.flatMap(f => Array.from(f.power))),
  );
  console.log(`  [${stftMs.toFixed(4).padStart(9)} ms]  Step 3 — STFT (${stft.frames.length} frames × ${stft.numBins} bins)`);

  assert(
    "STFT produces at least 1 frame",
    stft.frames.length > 0,
    stft.frames.length,
    "> 0",
  );

  assert(
    "STFT numBins = FFT_SIZE / 2 = 1024",
    stft.numBins === 1024,
    stft.numBins,
    "1024",
  );

  // Step 4: Noise floor estimation
  t = performance.now();
  const noiseFloor = estimateNoiseFloor(stft);
  const noiseFloorMs = performance.now() - t;
  console.log(`  [${noiseFloorMs.toFixed(4).padStart(9)} ms]  Step 4 — Noise floor estimation (${noiseFloor.length} bins)`);

  assert(
    "Noise floor array has one entry per FFT bin",
    noiseFloor.length === stft.numBins,
    noiseFloor.length,
    `${stft.numBins}`,
  );

  assert(
    "All noise floor values are positive",
    Array.from(noiseFloor).every(v => v > 0),
    "all > 0",
    "all > 0",
  );

  // Step 5: Wiener filter + OLA reconstruction
  t = performance.now();
  const { cleaned, noise: removedNoise, gainCurveAvg } = applyWienerAndReconstruct(
    stft, noiseFloor, downsampled,
  );
  const wienerMs = performance.now() - t;
  const wienerSNR = snrDb(cleaned, removedNoise);
  console.log(`  [${wienerMs.toFixed(4).padStart(9)} ms]  Step 5 — Wiener filter + OLA  →  SNR: ${wienerSNR.toFixed(4)} dB`);

  assert(
    "Wiener reconstruction: cleaned signal is same length as downsampled input",
    cleaned.length === downsampled.length,
    cleaned.length,
    `${downsampled.length}`,
  );

  assert(
    "Wiener reconstruction: SNR is finite",
    isFinite(wienerSNR),
    wienerSNR.toFixed(4),
    "finite",
  );

  assert(
    "Wiener reconstruction: noise residual is same length as cleaned",
    removedNoise.length === cleaned.length,
    removedNoise.length,
    `${cleaned.length}`,
  );

  assert(
    "Gain curve has one average value per FFT bin",
    gainCurveAvg.length === stft.numBins,
    gainCurveAvg.length,
    `${stft.numBins}`,
  );

  // Step 6: Constellation extraction
  t = performance.now();
  const bounds = logBandBoundaries(6, 8_192, 1024);
  const stftFP  = computeSTFT(cleaned, 8_192, 1024, 32);
  const peaks   = extractConstellation(stftFP, bounds);
  const constellationMs = performance.now() - t;
  console.log(`  [${constellationMs.toFixed(4).padStart(9)} ms]  Step 6 — Constellation extraction  (${peaks.length} peaks)`);

  assert(
    "Constellation extraction produces at least 1 peak",
    peaks.length > 0,
    peaks.length,
    "> 0",
  );

  // Step 7: Hash generation
  t = performance.now();
  const hashes = buildHashes(peaks);
  const hashMs = performance.now() - t;
  console.log(`  [${hashMs.toFixed(4).padStart(9)} ms]  Step 7 — Fingerprint hash generation  (${hashes.length} hashes)`);

  assert(
    "Hash generation produces at least 1 hash",
    hashes.length > 0,
    hashes.length,
    "> 0",
  );

  assert(
    "All hashes have positive deltaTime",
    hashes.every(h => h.deltaTime > 0),
    "all deltaTime > 0",
    "all > 0",
  );
}

// ─────────────────────────────────────────────────────────────
// SECTION 6 — REPEATED EXECUTION TIMING  (mirrors paper Table IV)
// ─────────────────────────────────────────────────────────────

section("6. Repeated Execution Timing  (15 runs — mirrors paper Table IV)");

{
  const RUNS = 15;
  const firTimes: number[] = [];
  const iirTimes: number[] = [];

  for (let run = 1; run <= RUNS; run++) {
    const spec = { sampleRate: FS, order: 100, cutoffHz: 4_000 };

    const t0 = performance.now();
    applyFIRFilter(monoAudio, { ...spec, type: "lowpass" as const });
    firTimes.push(performance.now() - t0);

    const t1 = performance.now();
    applyIIRFilter(monoAudio, { ...spec, type: "lowpass" as const });
    iirTimes.push(performance.now() - t1);
  }

  const avg  = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const avg_fir = avg(firTimes);
  const avg_iir = avg(iirTimes);

  const runTable = Array.from({ length: RUNS }, (_, i) => ({
    Execution: i + 1,
    "IIR (ms)": iirTimes[i].toFixed(4),
    "FIR (ms)": firTimes[i].toFixed(4),
  }));
  runTable.push({
    Execution: "Average" as unknown as number,
    "IIR (ms)": avg_iir.toFixed(4),
    "FIR (ms)": avg_fir.toFixed(4),
  });
  console.log("");
  console.table(runTable);

  assert(
    "Average FIR time is positive over 15 runs",
    avg_fir > 0,
    `${avg_fir.toFixed(4)} ms`,
    "> 0 ms",
  );

  assert(
    "Average IIR time is positive over 15 runs",
    avg_iir > 0,
    `${avg_iir.toFixed(4)} ms`,
    "> 0 ms",
  );

  assert(
    "FIR is faster than IIR on average (paper Table IV conclusion)",
    avg_fir < avg_iir,
    `FIR avg ${avg_fir.toFixed(4)} ms  vs  IIR avg ${avg_iir.toFixed(4)} ms`,
    "FIR avg < IIR avg",
  );

  console.log(`\n  📊 15-run averages: FIR = ${avg_fir.toFixed(4)} ms | IIR = ${avg_iir.toFixed(4)} ms`);
}

// ─────────────────────────────────────────────────────────────
// SECTION 7 — COEFFICIENT CORRECTNESS
// ─────────────────────────────────────────────────────────────

section("7. Coefficient Correctness");

{
  // FIR: DC gain of a low-pass filter should ≈ 1.0
  const firCoeffs = firResult.coefficients;
  const dcGain    = Array.from(firCoeffs.taps).reduce((s, v) => s + v, 0);
  assert(
    "FIR lowpass DC gain ≈ 1.0 (tap sum)",
    Math.abs(dcGain - 1.0) < 0.01,
    dcGain.toFixed(6),
    "≈ 1.0 ± 0.01",
  );

  // FIR: symmetry check — linear-phase FIR taps are symmetric
  const taps = firCoeffs.taps;
  const M    = taps.length - 1;
  let symmetric = true;
  for (let k = 0; k <= M / 2; k++) {
    if (Math.abs(taps[k] - taps[M - k]) > 1e-10) { symmetric = false; break; }
  }
  assert(
    "FIR taps are symmetric (linear phase guarantee)",
    symmetric,
    symmetric ? "symmetric" : "not symmetric",
    "symmetric",
  );

  // IIR: pole magnitude should be < 1 for stability
  const iirCoeffs = iirResult.coefficients;
  const poleMag   = Math.abs(iirCoeffs.poleA);
  assert(
    "IIR pole |a| < 1 — filter is stable",
    poleMag < 1,
    poleMag.toFixed(6),
    "< 1",
  );

  // IIR: b0 = (1 − a) / 2
  const expectedB0 = (1 - iirCoeffs.poleA) / 2;
  assert(
    "IIR b₀ = (1 − a) / 2  (Eq. 5 of paper)",
    Math.abs(iirCoeffs.gainB0 - expectedB0) < 1e-10,
    iirCoeffs.gainB0.toFixed(8),
    expectedB0.toFixed(8),
  );

  // Hamming window: endpoints should equal 0.54 − 0.46 = 0.08
  const w = firCoeffs.hammingWeights;
  const expectedEndpoint = 0.54 - 0.46; // = 0.08
  assert(
    "Hamming window endpoints = 0.08  (w(0) = w(N−1) = 0.54 − 0.46)",
    Math.abs(w[0] - expectedEndpoint) < 1e-10 && Math.abs(w[w.length - 1] - expectedEndpoint) < 1e-10,
    `w[0]=${w[0].toFixed(4)}, w[N-1]=${w[w.length - 1].toFixed(4)}`,
    `${expectedEndpoint}`,
  );
}

// ─────────────────────────────────────────────────────────────
// FULL REPORTS
// ─────────────────────────────────────────────────────────────

section("Full Filter Reports");
printFIRReport(firResult);
printIIRReport(iirResult);

// ─────────────────────────────────────────────────────────────
// FINAL SUMMARY
// ─────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(" TEST SUMMARY");
console.log("═".repeat(60));
console.log(`  Total  : ${results.length}`);
console.log(`  Passed : ${passed}  ✔`);
console.log(`  Failed : ${failed}  ${failed > 0 ? "✗" : "✔"}`);
console.log("═".repeat(60));

if (failed > 0) {
  console.error(`\n  ${failed} test(s) failed.\n`);
  process.exit(1);
} else {
  console.log("\n  All tests passed.\n");
}