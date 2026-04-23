import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { fft, getMagnitudeSpectrum, extractBandEnergy, hannWindow } from '../../lib/audio/utils';

interface BandEnergyChartProps {
  originalData: Float32Array;
  processedData: Float32Array;
  title: string;
  sampleRate?: number;
}

export function BandEnergyChart({
  originalData,
  processedData,
  title,
  sampleRate = 44100,
}: BandEnergyChartProps) {
  // Compute spectra
  const fftSize = 2048;
  const window = hannWindow(fftSize);

  const getSpectrum = (data: Float32Array) => {
    const windowedSignal = new Float32Array(fftSize);
    for (let i = 0; i < fftSize && i < data.length; i++) {
      windowedSignal[i] = data[i] * window[i];
    }
    const fftResult = fft(windowedSignal);
    return getMagnitudeSpectrum(fftResult);
  };

  const originalMagnitude = getSpectrum(originalData);
  const processedMagnitude = getSpectrum(processedData);

  const bands = [
    { name: 'Sub-Bass', low: 20, high: 60 },
    { name: 'Bass', low: 60, high: 250 },
    { name: 'Low-Mid', low: 250, high: 500 },
    { name: 'Mid', low: 500, high: 2000 },
    { name: 'High-Mid', low: 2000, high: 4000 },
    { name: 'Presence', low: 4000, high: 6000 },
    { name: 'Brilliance', low: 6000, high: 20000 },
  ];

  const bandCount = bands.length;
  const originalEnergy = extractBandEnergy(originalMagnitude, bandCount);
  const processedEnergy = extractBandEnergy(processedMagnitude, bandCount);

  const chartData = bands.map((band, idx) => ({
    band: band.name,
    original: Math.log10(originalEnergy[idx] + 1),
    processed: Math.log10(processedEnergy[idx] + 1),
  }));

  return (
    <div className="w-full h-full flex flex-col bg-background rounded-lg border border-border p-4">
      <h3 className="text-sm font-medium text-foreground mb-2">{title}</h3>
      <ResponsiveContainer width="100%" height="100%" minHeight={250}>
        <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="band" tick={{ fontSize: 11 }} angle={-45} textAnchor="end" height={80} stroke="#6b7280" />
          <YAxis tick={{ fontSize: 12 }} stroke="#6b7280" label={{ value: 'Log Energy', angle: -90, position: 'insideLeft' }} />
          <Tooltip
            contentStyle={{ backgroundColor: '#fff', border: '1px solid #ccc' }}
            formatter={(value) => typeof value === 'number' ? value.toFixed(2) : value}
          />
          <Legend />
          <Bar dataKey="original" fill="#ef4444" isAnimationActive={false} />
          <Bar dataKey="processed" fill="#10b981" isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
