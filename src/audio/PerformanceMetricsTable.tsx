import { ProcessingStep } from '../../lib/audio/utils';

interface PerformanceMetricsTableProps {
  steps: ProcessingStep[];
  totalTime: number;
}

export function PerformanceMetricsTable({ steps, totalTime }: PerformanceMetricsTableProps) {
  return (
    <div className="w-full bg-background rounded-lg border border-border p-4">
      <h3 className="text-sm font-medium text-foreground mb-4">Performance Metrics</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border">
            <tr className="bg-muted">
              <th className="text-left px-4 py-2 font-medium text-foreground">Step</th>
              <th className="text-right px-4 py-2 font-medium text-foreground">Execution Time (ms)</th>
              <th className="text-right px-4 py-2 font-medium text-foreground">% of Total</th>
              <th className="text-right px-4 py-2 font-medium text-foreground">SNR (dB)</th>
              <th className="text-left px-4 py-2 font-medium text-foreground">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {steps.map((step, idx) => (
              <tr key={idx} className="hover:bg-muted/50 transition">
                <td className="px-4 py-3 font-medium text-foreground">{step.name}</td>
                <td className="px-4 py-3 text-right text-foreground">{step.executionTime.toFixed(2)}</td>
                <td className="px-4 py-3 text-right text-foreground">
                  {((step.executionTime / totalTime) * 100).toFixed(1)}%
                </td>
                <td className="px-4 py-3 text-right text-foreground">
                  {step.snr !== undefined ? step.snr.toFixed(2) : '-'}
                </td>
                <td className="px-4 py-3 text-muted-foreground">{step.description}</td>
              </tr>
            ))}
            <tr className="bg-muted font-semibold">
              <td className="px-4 py-3 text-foreground">Total</td>
              <td className="px-4 py-3 text-right text-foreground">{totalTime.toFixed(2)}</td>
              <td className="px-4 py-3 text-right text-foreground">100%</td>
              <td className="px-4 py-3 text-right text-foreground">-</td>
              <td className="px-4 py-3 text-foreground">Complete pipeline execution</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
