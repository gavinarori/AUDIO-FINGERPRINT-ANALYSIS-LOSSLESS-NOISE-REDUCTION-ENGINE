import { type ProcessingResult } from '../../lib/audio/utils';
import { WaveformChart } from './WaveformChart';
import { FrequencySpectrumChart } from './FrequencySpectrumChart';
import { SpectrogramHeatmap } from './SpectrogramHeatmap';
import { BandEnergyChart } from './BandEnergyChart';
import { PhaseSpectrumChart } from './PhaseSpectrumChart';
import { ConstellationMap } from './ConstellationMap';
import { BeforeAfterComparison } from './BeforeAfterComparison';

interface GraphsGridProps {
  result: ProcessingResult;
  sampleRate: number;
}

export function GraphsGrid({ result, sampleRate }: GraphsGridProps) {
  const originalStep = result.steps[0];
  const finalStep = result.steps[result.steps.length - 1];

  // Prepare before/after metrics
  const beforeAfterMetrics = [
    {
      label: 'RMS Level',
      before: Math.sqrt(
        result.originalAudio.reduce((sum, val) => sum + val * val, 0) / result.originalAudio.length
      ),
      after: Math.sqrt(
        result.finalAudio.reduce((sum, val) => sum + val * val, 0) / result.finalAudio.length
      ),
    },
    {
      label: 'Peak Level',
      before: Math.max(...Array.from(result.originalAudio).map(Math.abs)),
      after: Math.max(...Array.from(result.finalAudio).map(Math.abs)),
    },
    {
      label: 'Crest Factor',
      before:
        Math.max(...Array.from(result.originalAudio).map(Math.abs)) /
        Math.sqrt(
          result.originalAudio.reduce((sum, val) => sum + val * val, 0) / result.originalAudio.length
        ),
      after:
        Math.max(...Array.from(result.finalAudio).map(Math.abs)) /
        Math.sqrt(result.finalAudio.reduce((sum, val) => sum + val * val, 0) / result.finalAudio.length),
    },
  ];

  return (
    <div className="w-full space-y-6">
      {/* Row 1: Original and Final Waveforms */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <WaveformChart
          data={result.originalAudio}
          title="Original Audio Waveform"
          sampleRate={sampleRate}
          color="#ef4444"
        />
        <WaveformChart
          data={result.finalAudio}
          title="Cleaned Audio Waveform"
          sampleRate={sampleRate}
          color="#10b981"
        />
      </div>

      {/* Row 2: Frequency Spectra */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <FrequencySpectrumChart
          data={result.originalAudio}
          title="Original Frequency Spectrum"
          sampleRate={sampleRate}
          color="#ef4444"
        />
        <FrequencySpectrumChart
          data={result.finalAudio}
          title="Cleaned Frequency Spectrum"
          sampleRate={sampleRate}
          color="#10b981"
        />
      </div>

      {/* Row 3: Spectrograms */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SpectrogramHeatmap
          data={result.originalAudio}
          title="Original Spectrogram"
          sampleRate={sampleRate}
        />
        <SpectrogramHeatmap
          data={result.finalAudio}
          title="Cleaned Spectrogram"
          sampleRate={sampleRate}
        />
      </div>

      {/* Row 4: Phase Spectra */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PhaseSpectrumChart
          data={result.originalAudio}
          title="Original Phase Spectrum"
          sampleRate={sampleRate}
          color="#f59e0b"
        />
        <PhaseSpectrumChart
          data={result.finalAudio}
          title="Cleaned Phase Spectrum"
          sampleRate={sampleRate}
          color="#10b981"
        />
      </div>

      {/* Row 5: Band Energy and Constellation Map */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <BandEnergyChart
          originalData={result.originalAudio}
          processedData={result.finalAudio}
          title="Band Energy Comparison"
          sampleRate={sampleRate}
        />
        <ConstellationMap
          data={result.finalAudio}
          title="FFT Constellation Map"
          sampleRate={sampleRate}
          color="#8b5cf6"
        />
      </div>

      {/* Row 6: Before/After Metrics */}
      <div className="grid grid-cols-1 gap-4">
        <BeforeAfterComparison
          metrics={beforeAfterMetrics}
          title="Audio Quality Metrics Comparison"
        />
      </div>
    </div>
  );
}
