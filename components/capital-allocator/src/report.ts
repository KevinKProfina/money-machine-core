import type { AllocationProposal } from './mm-contract.js';

/** Plain-text table of a proposal, for logs and the `report` CLI. */
export function formatProposalTable(p: AllocationProposal): string {
  const names = Object.keys(p.scores);
  const lines = [
    `Allocation proposal ${p.timestamp} — profile ${p.riskProfile}, total $${p.totalCapitalUsd.toFixed(2)}`,
  ];
  if (names.length === 0) {
    lines.push('(no strategies)');
    return lines.join('\n');
  }
  const header = ['strategy', 'score', 'allowed', 'allocation', 'share'];
  const rows = names.map((n) => {
    const s = p.scores[n]!;
    const amount = p.allocations[n] ?? 0;
    const share = p.totalCapitalUsd > 0 ? (amount / p.totalCapitalUsd) * 100 : 0;
    return [n, s.score.toFixed(1), s.riskGateAllowed ? 'yes' : 'no', `$${amount.toFixed(2)}`, `${share.toFixed(1)}%`];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  lines.push(fmt(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(fmt));
  for (const n of names) {
    const reasons = p.scores[n]!.reasons;
    if (reasons.length) lines.push(`  ${n}: ${reasons.join('; ')}`);
  }
  return lines.join('\n');
}
