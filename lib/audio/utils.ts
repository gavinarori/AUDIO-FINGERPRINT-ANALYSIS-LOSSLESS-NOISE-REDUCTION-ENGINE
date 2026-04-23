import type { MonoAudio } from './audio-fingerprint';
import { toMono, type RawAudio } from './audio-fingerprint';
import {
  applyFIRFilter,
  DEFAULT_FIR_SPEC,
  type FIRFilterSpec,
  type FIRFilterResult,
} from './fir-filter';
import {
  applyIIRFilter,
  DEFAULT_IIR_SPEC,
  type IIRFilterSpec,
  type IIRFilterResult,
} from './Iir-filter';

export interface ProcessingStep {
  name: string;
  description: string;
  executionTime: number;
  snr?: number;
}

export interface ProcessingResult {
  originalAudio: Float32Array;
  originalSampleRate: number;
  steps: ProcessingStep[];
  firResult: FIRFilterResult;
  iirResult: IIRFilterResult;
  totalTime: number;
}

/**
 * Decode WAV or MP3 file into PCM audio data
 */
export async function decodeAudioFile(file: File): Promise<{ channels: Float32Array[]; sampleRate: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const arrayBuffer = e.target?.result as ArrayBuffer;
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

        const channels: Float32Array[] = [];
        for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
          channels.push(new Float32Array(audioBuffer.getChannelData(i)));
        }

        resolve({
          channels,
          sampleRate: audioBuffer.sampleRate,
        });
      } catch (err) {
        reject(err);
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Simple FFT implementation for spectrum analysis
 */
export function fft(samples: Float32Array | Float64Array): { real: Float32Array; imag: Float32Array } {
  const n = samples.length;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);

  // Simple DFT (not optimized FFT, but works for small sizes)
  for (let k = 0; k < n; k++) {
    let sumReal = 0;
    let sumImag = 0;
    for (let t = 0; t < n; t++) {
      const angle = (-2 * Math.PI * k * t) / n;
      sumReal += samples[t] * Math.cos(angle);
      sumImag += samples[t] * Math.sin(angle);
    }
    real[k] = sumReal;
    imag[k] = sumImag;
  }

  return { real, imag };
}

/**
 * Get magnitude spectrum from FFT results
 */
export function getMagnitudeSpectrum(fftResult: { real: Float32Array; imag: Float32Array }): Float32Array {
  const magnitude = new Float32Array(fftResult.real.length);
  for (let i = 0; i < fftResult.real.length; i++) {
    const real = fftResult.real[i];
    const imag = fftResult.imag[i];
    magnitude[i] = Math.sqrt(real * real + imag * imag);
  }
  return magnitude;
}

/**
 * Get phase spectrum from FFT results
 */
export function getPhaseSpectrum(fftResult: { real: Float32Array; imag: Float32Array }): Float32Array {
  const phase = new Float32Array(fftResult.real.length);
  for (let i = 0; i < fftResult.real.length; i++) {
    phase[i] = Math.atan2(fftResult.imag[i], fftResult.real[i]);
  }
  return phase;
}

/**
 * Extract band energy across frequency bands
 */
export function extractBandEnergy(magnitude: Float32Array, bandCount: number = 10): Float32Array {
  const bandEnergy = new Float32Array(bandCount);
  const binPerBand = Math.floor(magnitude.length / bandCount);

  for (let i = 0; i < bandCount; i++) {
    const start = i * binPerBand;
    const end = Math.min((i + 1) * binPerBand, magnitude.length);
    let energy = 0;
    for (let j = start; j < end; j++) {
      energy += magnitude[j] * magnitude[j];
    }
    bandEnergy[i] = energy / (end - start);
  }

  return bandEnergy;
}

/**
 * Hann window function
 */
export function hannWindow(N: number): Float32Array {
  const w = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    w[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));
  }
  return w;
}

/**
 * Process audio through the complete noise reduction pipeline
 */
export async function processAudioPipeline(
  audioData: Float32Array,
  sampleRate: number,
  firSpec: FIRFilterSpec = DEFAULT_FIR_SPEC,
  iirSpec: IIRFilterSpec = DEFAULT_IIR_SPEC,
): Promise<ProcessingResult> {
  const startTime = performance.now();
  const steps: ProcessingStep[] = [];

  // Create mono audio
  const monoAudio: MonoAudio = {
    samples: audioData,
    sampleRate,
    duration: audioData.length / sampleRate,
  };

  steps.push({
    name: 'Audio Loaded',
    description: `${(audioData.length / sampleRate).toFixed(2)}s @ ${sampleRate} Hz`,
    executionTime: 0,
  });

  // Apply FIR filter
  const firResult = applyFIRFilter(monoAudio, firSpec);
  
  steps.push({
    name: 'FIR Filter Applied',
    description: `Order ${firSpec.order}, Cutoff ${firSpec.cutoffHz} Hz`,
    executionTime: firResult.totalElapsedMs,
    snr: firResult.snrDb,
  });

  // Prepare audio for IIR filter
  const afterFIR: MonoAudio = {
    samples: firResult.filtered,
    sampleRate: firSpec.sampleRate,
    duration: firResult.filtered.length / firSpec.sampleRate,
  };

  // Apply IIR filter
  const iirResult = applyIIRFilter(afterFIR, iirSpec);

  steps.push({
    name: 'IIR Filter Applied',
    description: `Order ${iirSpec.order}, Cutoff ${iirSpec.cutoffHz} Hz`,
    executionTime: iirResult.totalElapsedMs,
    snr: iirResult.snrDb,
  });

  const totalTime = performance.now() - startTime;

  return {
    originalAudio: audioData,
    originalSampleRate: sampleRate,
    steps,
    firResult,
    iirResult,
    totalTime,
  };
}

/**
 * Downsample audio data for visualization
 */
export function downsampleForDisplay(audio: Float32Array, targetLength: number): Float32Array {
  if (audio.length <= targetLength) {
    return audio;
  }

  const factor = Math.ceil(audio.length / targetLength);
  const downsampled = new Float32Array(Math.ceil(audio.length / factor));

  for (let i = 0; i < downsampled.length; i++) {
    const start = i * factor;
    const end = Math.min(start + factor, audio.length);
    let max = 0;

    for (let j = start; j < end; j++) {
      max = Math.max(max, Math.abs(audio[j]));
    }

    downsampled[i] = max;
  }

  return downsampled;
}
