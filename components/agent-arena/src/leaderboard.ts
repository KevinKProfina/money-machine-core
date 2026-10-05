import dotenv from 'dotenv';
import { readJsonSafe } from './mm-contract.js';
import { leaderboardTable, summaryText } from './format.js';
import type { ArenaSummary } from './report.js';
import { arenaPaths } from './state.js';

dotenv.config({ quiet: true });

const summary = await readJsonSafe<ArenaSummary | null>(arenaPaths.summary(), null);
if (!summary || summary.schema !== 'mm.arena-summary/v1') {
  console.log(`no arena summary at ${arenaPaths.summary()} yet — run \`npm run once\` first`);
} else {
  console.log(summaryText(summary));
  console.log('');
  console.log(leaderboardTable(summary.leaderboard));
}
