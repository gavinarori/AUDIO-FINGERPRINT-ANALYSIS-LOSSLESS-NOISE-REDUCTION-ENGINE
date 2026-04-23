import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

interface WaveformChartProps {
  data: Float32Array;
  title: string;
  sampleRate?: number;
  color?: string;
}

export function WaveformChart({ data, title, sampleRate = 44100, color = '#3b82f6' }: WaveformChartProps) {
  // Downsample for visualization
  const downsampleFactor = Math.max(1, Math.floor(data.length / 1000));
  const chartData = [];

  for (let i = 0; i < data.length; i += downsampleFactor) {
    chartData.push({
      time: (i / sampleRate) * 1000, // milliseconds
      amplitude: data[i],
    });
  }

  return (
    <div className="w-full h-full flex flex-col bg-background rounded-lg border border-border p-4">
      <h3 className="text-sm font-medium text-foreground mb-2">{title}</h3>
      <ResponsiveContainer width="100%" height="100%" minHeight={250}>
        <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="time" tick={{ fontSize: 12 }} stroke="#6b7280" />
          <YAxis tick={{ fontSize: 12 }} stroke="#6b7280" domain={[-1, 1]} />
          <Tooltip
            contentStyle={{ backgroundColor: '#fff', border: '1px solid #ccc' }}
            formatter={(value) => typeof value === 'number' ? value.toFixed(4) : value}
          />
          <Line
            type="monotone"
            dataKey="amplitude"
            stroke={color}
            dot={false}
            isAnimationActive={false}
            strokeWidth={1}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
