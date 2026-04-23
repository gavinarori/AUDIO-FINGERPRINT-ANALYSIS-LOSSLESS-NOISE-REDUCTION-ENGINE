import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { fft, getPhaseSpectrum, hannWindow } from '../../lib/audio/utils';

interface PhaseSpectrumChartProps {
  data: Float32Array;
  title: string;
  sampleRate?: number;
  color?: string;
}

export function PhaseSpectrumChart({
  data,
  title,
  sampleRate = 44100,
  color = '#f59e0b',
}: PhaseSpectrumChartProps) {
  const fftSize = Math.min(2048, data.length);
  const window = hannWindow(fftSize);
  const windowedSignal = new Float32Array(fftSize);

  for (let i = 0; i < fftSize; i++) {
    windowedSignal[i] = data[i] * window[i];
  }

  const fftResult = fft(windowedSignal);
  const phase = getPhaseSpectrum(fftResult);

  const nyquist = sampleRate / 2;
  const downsampleFactor = Math.max(1, Math.floor(phase.length / 200));
  const chartData = [];

  for (let i = 0; i < phase.length; i += downsampleFactor) {
    const freq = (i / fftSize) * nyquist;
    if (freq > 20 && freq < 20000) {
      chartData.push({
        frequency: Math.round(freq),
        phase: (phase[i] * 180) / Math.PI, // Convert to degrees
      });
    }
  }

  return (
    <div className="w-full h-full flex flex-col bg-background rounded-lg border border-border p-4">
      <h3 className="text-sm font-medium text-foreground mb-2">{title}</h3>
      <ResponsiveContainer width="100%" height="100%" minHeight={250}>
        <ScatterChart margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis type="number" dataKey="frequency" name="Frequency (Hz)" tick={{ fontSize: 12 }} stroke="#6b7280" />
          <YAxis
            type="number"
            dataKey="phase"
            name="Phase (°)"
            tick={{ fontSize: 12 }}
            stroke="#6b7280"
            domain={[-180, 180]}
          />
          <Tooltip
            contentStyle={{ backgroundColor: '#fff', border: '1px solid #ccc' }}
            formatter={(value) => typeof value === 'number' ? value.toFixed(1) : value}
            labelFormatter={(value) => `${value} Hz`}
          />
          <Scatter name="Phase" data={chartData} fill={color} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
