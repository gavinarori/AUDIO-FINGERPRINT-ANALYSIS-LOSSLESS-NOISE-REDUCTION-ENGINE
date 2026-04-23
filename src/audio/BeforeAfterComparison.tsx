import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

interface BeforeAfterComparisonProps {
  metrics: {
    label: string;
    before: number;
    after: number;
  }[];
  title: string;
}

export function BeforeAfterComparison({ metrics, title }: BeforeAfterComparisonProps) {
  return (
    <div className="w-full h-full flex flex-col bg-background rounded-lg border border-border p-4">
      <h3 className="text-sm font-medium text-foreground mb-2">{title}</h3>
      <ResponsiveContainer width="100%" height="100%" minHeight={250}>
        <BarChart data={metrics} margin={{ top: 5, right: 10, left: 0, bottom: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} angle={-45} textAnchor="end" height={80} stroke="#6b7280" />
          <YAxis tick={{ fontSize: 12 }} stroke="#6b7280" />
          <Tooltip
            contentStyle={{ backgroundColor: '#fff', border: '1px solid #ccc' }}
            formatter={(value) => typeof value === 'number' ? value.toFixed(2) : value}
          />
          <Legend />
          <Bar dataKey="before" fill="#ef4444" name="Before" isAnimationActive={false} />
          <Bar dataKey="after" fill="#10b981" name="After" isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
