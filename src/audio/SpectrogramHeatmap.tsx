import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { fft, getMagnitudeSpectrum, hannWindow } from '../../lib/audio/utils';

interface SpectrogramHeatmapProps {
  data: Float32Array;
  title: string;
  sampleRate?: number;
}

export function SpectrogramHeatmap({ data, title, sampleRate = 44100 }: SpectrogramHeatmapProps) {
  const fftSize = 512;
  const hopSize = fftSize / 2;
  const nyquist = sampleRate / 2;
  
  const specData = [];
  const window = hannWindow(fftSize);

  for (let start = 0; start + fftSize < data.length; start += hopSize) {
    const windowedSignal = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      windowedSignal[i] = data[start + i] * window[i];
    }

    const fftResult = fft(windowedSignal);
    const magnitude = getMagnitudeSpectrum(fftResult);

    // Sample every other bin for performance
    for (let i = 0; i < magnitude.length; i += 4) {
      const freq = (i / fftSize) * nyquist;
      const timeMs = (start / sampleRate) * 1000;
      const magnitude_db = 20 * Math.log10(Math.max(1e-6, magnitude[i]));

      specData.push({
        time: Math.round(timeMs),
        frequency: Math.round(freq),
        magnitude: magnitude_db,
      });
    }
  }

  // Color map function
  const getColor = (value: number) => {
    const normalized = Math.max(0, Math.min(1, (value + 80) / 80)); // Normalize to 0-1
    if (normalized < 0.25) return '#000033';
    if (normalized < 0.5) return '#0000ff';
    if (normalized < 0.75) return '#00ff00';
    return '#ff0000';
  };

  return (
    <div className="w-full h-full flex flex-col bg-background rounded-lg border border-border p-4">
      <h3 className="text-sm font-medium text-foreground mb-2">{title}</h3>
      <ResponsiveContainer width="100%" height="100%" minHeight={250}>
        <ScatterChart margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis type="number" dataKey="time" name="Time (ms)" tick={{ fontSize: 12 }} stroke="#6b7280" />
          <YAxis type="number" dataKey="frequency" name="Frequency (Hz)" tick={{ fontSize: 12 }} stroke="#6b7280" />
          <Tooltip
            contentStyle={{ backgroundColor: '#fff', border: '1px solid #ccc' }}
            formatter={(value) => typeof value === 'number' ? value.toFixed(1) : value}
          />
          <Scatter name="Spectrogram" data={specData.slice(0, Math.min(1000, specData.length))}>
            {specData.slice(0, Math.min(1000, specData.length)).map((entry, index) => (
              <Cell key={`cell-${index}`} fill={getColor(entry.magnitude)} />
            ))}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
