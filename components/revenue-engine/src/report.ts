import { pathToFileURL } from 'node:url';
import { aggregate } from './aggregate.js';
import { loadDotEnv } from './env.js';
import { readJsonSafe, statePaths } from './mm-contract.js';
import { loadEvents } from './store.js';
import type { ExtendedRevenueReport } from './types.js';

const usd = (n: number) => n.toFixed(2);

export function formatReport(report: ExtendedRevenueReport): string {
  const header = ['stream', 'kind', 'total USD', '30d USD', '7d USD', 'share', 'simulated'];
  const positiveSum = Object.values(report.streams).reduce((a, s) => a + Math.max(0, s.totalUsd), 0);
  const rows = Object.entries(report.streams)
    .sort((a, b) => b[1].totalUsd - a[1].totalUsd)
    .map(([name, s]) => [
      name,
      s.kind,
      usd(s.totalUsd),
      usd(s.last30dUsd),
      usd(s.last7dUsd),
      positiveSum > 0 && s.totalUsd > 0 ? `${((s.totalUsd / positiveSum) * 100).toFixed(1)}%` : '-',
      s.simulated ? 'yes' : 'no',
    ]);
  rows.push(['TOTAL', '', usd(report.totalUsd), usd(report.last30dUsd), usd(report.last7dUsd), '', '']);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r: string[]) => r.map((c, i) => (i >= 2 && i <= 5 ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ');
  const lines = [
    `Revenue report @ ${report.timestamp} (${report.eventCount} events)`,
    '',
    fmt(header),
    widths.map((w) => '-'.repeat(w)).join('  '),
    ...rows.slice(0, -1).map(fmt),
    widths.map((w) => '-'.repeat(w)).join('  '),
    fmt(rows[rows.length - 1]),
    '',
    `real: ${usd(report.realTotalUsd)} USD   simulated: ${usd(report.simulatedTotalUsd)} USD   concentration (HHI): ${report.concentration.toFixed(3)}`,
    '',
    'Recommendations:',
    ...report.recommendations.map((r) => `  - ${r}`),
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  loadDotEnv();
  // Fresh read-only aggregation from the event store (does not collect from sources).
  const report = aggregate(await loadEvents(), new Date());
  const last = await readJsonSafe<ExtendedRevenueReport | null>(statePaths.revenue(), null);
  console.log(formatReport(report));
  if (last?.sources?.length) {
    console.log('\nLast cycle sources:');
    for (const s of last.sources) {
      console.log(`  - ${s.name}: ${s.ok ? `ok, ${s.newEvents} new / ${s.collected} collected` : `FAILED (${s.error})`}`);
    }
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[revenue-engine] ERROR ${(err as Error).message}`);
    process.exit(1);
  });
}
