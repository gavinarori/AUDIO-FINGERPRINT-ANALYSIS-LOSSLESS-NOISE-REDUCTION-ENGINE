import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { fft, hannWindow } from '../../lib/audio/utils';

interface ConstellationMapProps {
  data: Float32Array;
  title: string;
  sampleRate?: number;
  color?: string;
}

export function ConstellationMap({
  data,
  title,
  sampleRate = 44100,
  color = '#8b5cf6',
}: ConstellationMapProps) {
  const fftSize = 512;
  const hopSize = fftSize / 2;
  const window = hannWindow(fftSize);
  
  const constellation = [];

  for (let start = 0; start + fftSize < data.length; start += hopSize) {
    const windowedSignal = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      windowedSignal[i] = data[start + i] * window[i];
    }

    const fftResult = fft(windowedSignal);

    // Plot IQ constellation points
    for (let i = 1; i < Math.min(fftSize / 2, 50); i++) {
      constellation.push({
        real: fftResult.real[i],
        imag: fftResult.imag[i],
        bin: i,
      });
    }
  }

  // Downsample for visualization
  const downsampledConstellation = constellation.filter((_, idx) => idx % Math.ceil(constellation.length / 500) === 0);

  return (
    <div className="w-full h-full flex flex-col bg-background rounded-lg border border-border p-4">
      <h3 className="text-sm font-medium text-foreground mb-2">{title}</h3>
      <ResponsiveContainer width="100%" height="100%" minHeight={250}>
        <ScatterChart margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis
            type="number"
            dataKey="real"
            name="Real Part"
            tick={{ fontSize: 12 }}
            stroke="#6b7280"
          />
          <YAxis
            type="number"
            dataKey="imag"
            name="Imaginary Part"
            tick={{ fontSize: 12 }}
            stroke="#6b7280"
          />
          <Tooltip
            contentStyle={{ backgroundColor: '#fff', border: '1px solid #ccc' }}
            formatter={(value) => typeof value === 'number' ? value.toFixed(2) : value}
            labelFormatter={(value) => `Bin ${value}`}
          />
          <Scatter name="FFT Points" data={downsampledConstellation} fill={color} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
