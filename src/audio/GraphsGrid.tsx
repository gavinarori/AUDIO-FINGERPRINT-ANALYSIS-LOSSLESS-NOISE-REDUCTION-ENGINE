"use client";

import { useMemo } from "react";
import { type ProcessingResult } from "../../lib/audio/utils";
import { WaveformChart } from "./WaveformChart";
import { FrequencySpectrumChart } from "./FrequencySpectrumChart";
import { SpectrogramHeatmap } from "./SpectrogramHeatmap";
import { BandEnergyChart } from "./BandEnergyChart";
import { PhaseSpectrumChart } from "./PhaseSpectrumChart";
import { ConstellationMap } from "./ConstellationMap";
import { BeforeAfterComparison } from "./BeforeAfterComparison";

interface GraphsGridProps {
  result: ProcessingResult;
  sampleRate: number;
}

/**
 * Safe max absolute value (no spread operator)
 */
function getMax(arr?: number[]) {
  if (!arr || arr.length === 0) return 0;

  let max = 0;
  for (let i = 0; i < arr.length; i++) {
    const val = Math.abs(arr[i]);
    if (val > max) max = val;
  }
  return max;
}

/**
 * Safe RMS calculation
 */
function getRMS(arr?: number[]) {
  if (!arr || arr.length === 0) return 0;

  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i] * arr[i];
  }

  return Math.sqrt(sum / arr.length);
}

export function GraphsGrid({ result, sampleRate }: GraphsGridProps) {
  const originalAudio = result.originalAudio ?? [];
  const finalAudio = result.finalAudio ?? [];

  const originalStep = result.steps?.[0];
  const finalStep = result.steps?.[result.steps.length - 1];

  /**
   * Memoized metrics (prevents heavy recomputation)
   */
  const beforeAfterMetrics = useMemo(() => {
    const beforeRMS = getRMS(originalAudio);
    const afterRMS = getRMS(finalAudio);

    const beforePeak = getMax(originalAudio);
    const afterPeak = getMax(finalAudio);

    return [
      {
        label: "RMS Level",
        before: beforeRMS,
        after: afterRMS,
      },
      {
        label: "Peak Level",
        before: beforePeak,
        after: afterPeak,
      },
      {
        label: "Crest Factor",
        before: beforeRMS > 0 ? beforePeak / beforeRMS : 0,
        after: afterRMS > 0 ? afterPeak / afterRMS : 0,
      },
    ];
  }, [originalAudio, finalAudio]);

  return (
    <div className="w-full space-y-6">
      {/* Row 1: Waveforms */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <WaveformChart
          data={originalAudio}
          title="Original Audio Waveform"
          sampleRate={sampleRate}
          color="#ef4444"
        />
        <WaveformChart
          data={finalAudio}
          title="Cleaned Audio Waveform"
          sampleRate={sampleRate}
          color="#10b981"
        />
      </div>

      {/* Row 2: Frequency Spectra */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <FrequencySpectrumChart
          data={originalAudio}
          title="Original Frequency Spectrum"
          sampleRate={sampleRate}
          color="#ef4444"
        />
        <FrequencySpectrumChart
          data={finalAudio}
          title="Cleaned Frequency Spectrum"
          sampleRate={sampleRate}
          color="#10b981"
        />
      </div>

      {/* Row 3: Spectrograms */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SpectrogramHeatmap
          data={originalAudio}
          title="Original Spectrogram"
          sampleRate={sampleRate}
        />
        <SpectrogramHeatmap
          data={finalAudio}
          title="Cleaned Spectrogram"
          sampleRate={sampleRate}
        />
      </div>

      {/* Row 4: Phase Spectra */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PhaseSpectrumChart
          data={originalAudio}
          title="Original Phase Spectrum"
          sampleRate={sampleRate}
          color="#f59e0b"
        />
        <PhaseSpectrumChart
          data={finalAudio}
          title="Cleaned Phase Spectrum"
          sampleRate={sampleRate}
          color="#10b981"
        />
      </div>

      {/* Row 5: Band Energy + Constellation */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <BandEnergyChart
          originalData={originalAudio}
          processedData={finalAudio}
          title="Band Energy Comparison"
          sampleRate={sampleRate}
        />
        <ConstellationMap
          data={finalAudio}
          title="FFT Constellation Map"
          sampleRate={sampleRate}
          color="#8b5cf6"
        />
      </div>

      {/* Row 6: Metrics */}
      <div className="grid grid-cols-1 gap-4">
        <BeforeAfterComparison
          metrics={beforeAfterMetrics}
          title="Audio Quality Metrics Comparison"
        />
      </div>
    </div>
  );
}