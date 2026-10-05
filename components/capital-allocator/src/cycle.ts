import { buildProposal } from './allocator.js';
import { readConfig, type AllocatorConfig } from './config.js';
import {
  isKillSwitchActive,
  readStrategyReports,
  statePaths,
  writeJsonAtomic,
  type AllocationProposal,
} from './mm-contract.js';
import { formatProposalTable } from './report.js';

export type CycleResult = { proposal: AllocationProposal; unallocatedUsd: number; reportCount: number };

/** One allocator cycle: read strategy reports, score, propose, write allocation-proposal.json. */
export async function runCycle(config: AllocatorConfig = readConfig(), now: Date = new Date()): Promise<CycleResult> {
  const reports = await readStrategyReports();
  if (reports.length === 0) {
    console.log(`[capital-allocator] no strategy reports in ${statePaths.strategiesDir()} — writing empty proposal`);
  }
  if (isKillSwitchActive()) {
    console.log('[capital-allocator] kill switch active — proposal is advisory only; orchestrator will allocate 0');
  }
  const { proposal, unallocatedUsd } = buildProposal(reports, config, now);
  await writeJsonAtomic(statePaths.proposal(), proposal);
  console.log(formatProposalTable(proposal));
  console.log(`[capital-allocator] unallocated $${unallocatedUsd.toFixed(2)} — wrote ${statePaths.proposal()}`);
  return { proposal, unallocatedUsd, reportCount: reports.length };
}
