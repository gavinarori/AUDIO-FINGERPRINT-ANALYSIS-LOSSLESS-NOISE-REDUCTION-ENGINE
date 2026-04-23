import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { fft, getMagnitudeSpectrum, hannWindow } from '../../lib/audio/utils';

interface FrequencySpectrumChartProps {
  data: Float32Array;
  title: string;
  sampleRate?: number;
  color?: string;
}

export function FrequencySpectrumChart({
  data,
  title,
  sampleRate = 44100,
  color = '#10b981',
}: FrequencySpectrumChartProps) {
  // Apply window function
  const fftSize = Math.min(2048, data.length);
  const window = hannWindow(fftSize);
  const windowedSignal = new Float32Array(fftSize);

  for (let i = 0; i < fftSize; i++) {
    windowedSignal[i] = data[i] * window[i];
  }

  // Compute FFT
  const fftResult = fft(windowedSignal);
  const magnitude = getMagnitudeSpectrum(fftResult);

  // Downsample magnitude spectrum
  const nyquist = sampleRate / 2;
  const downsampleFactor = Math.max(1, Math.floor(magnitude.length / 200));
  const chartData = [];

  for (let i = 0; i < magnitude.length; i += downsampleFactor) {
    const freq = (i / fftSize) * nyquist;
    if (freq > 20 && freq < 20000) {
      // Human hearing range
      chartData.push({
        frequency: Math.round(freq),
        magnitude: Math.log10(magnitude[i] + 1),
      });
    }
  }

  return (
    <div className="w-full h-full flex flex-col bg-background rounded-lg border border-border p-4">
      <h3 className="text-sm font-medium text-foreground mb-2">{title}</h3>
      <ResponsiveContainer width="100%" height="100%" minHeight={250}>
        <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="frequency" tick={{ fontSize: 12 }} stroke="#6b7280" />
          <YAxis tick={{ fontSize: 12 }} stroke="#6b7280" label={{ value: 'Log Magnitude', angle: -90, position: 'insideLeft' }} />
          <Tooltip
            contentStyle={{ backgroundColor: '#fff', border: '1px solid #ccc' }}
            formatter={(value) => typeof value === 'number' ? value.toFixed(3) : value}
          />
          <Bar dataKey="magnitude" fill={color} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
