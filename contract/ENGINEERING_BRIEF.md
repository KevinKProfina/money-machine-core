# Money Machine — engineering brief for all component repos

System layout (sibling repos in one parent dir):

| repo | role | writes | reads |
|---|---|---|---|
| solana-trading-agent | strategy `solana-trader` (kind trading) | strategies/solana-trader.json | allocations.json, KILL |
| liquidation-hunter | strategy `liquidation-hunter` (kind liquidation) | strategies/liquidation-hunter.json | allocations.json, KILL |
| capital-allocator | scores strategies, proposes allocation | allocation-proposal.json | strategies/*.json |
| orchestrator | health gates, kill switch, reserve, reinvestment, FINAL allocation | allocations.json, portfolio.json | strategies/*.json, allocation-proposal.json, revenue.json, KILL |
| revenue-engine | aggregates revenue streams | revenue.json | strategies/*.json, marketplace.json, own stream inputs |
| agent-marketplace | agent service marketplace (HTTP daemon) | marketplace.json | — |
| money-machine-core | supervisor, runs cycles in order, dashboard, kill switch CLI | events.jsonl, KILL | everything |

All files live in `$MM_STATE_DIR` (default `./.mm-state`). Contract types + helpers:
`money-machine-core/contract/mm-contract.ts` — copy it VERBATIM to `src/mm-contract.ts` in each repo
and use its helpers (writeJsonAtomic, readJsonSafe, statePaths, isKillSwitchActive, readStrategyBudget, emitEvent).

Supervisor cycle order: strategies (`--once`) → revenue-engine (`--once`) → capital-allocator (`--once`) → orchestrator (`--once`).

## Hard rules
1. Every component supports `--once` (run one cycle, exit 0; exit non-zero on fatal error) and a loop mode (default, interval from env).
2. Safe by default. Default mode is `paper` (or `dry-run`). Real-money execution only when `MODE=live` AND `LIVE_TRADING_CONFIRM=I_UNDERSTAND_REAL_MONEY_RISK`. Never fabricate executions, tx hashes, or profits. Anything simulated must be labeled simulated (mode field, notes).
3. Respect the kill switch (`isKillSwitchActive()`) and the orchestrator budget (`readStrategyBudget(name)`): no new positions when killed/paused or above budget. If no allocations.json exists yet, use the env-configured starting capital.
4. Missing secrets must not crash a paper/dry-run cycle (e.g. no ANTHROPIC_API_KEY → skip LLM step, rely on deterministic rules; no SOLANA_PRIVATE_KEY → fine in paper mode).
5. External APIs: wrap with timeout + retry with backoff, and degrade gracefully (log + empty result). The dev sandbox has NO outbound internet, so code paths must be unit-testable with injected fetch / mocked sources.
6. Claude usage (optional gate): `@anthropic-ai/sdk` latest, model `claude-opus-5-5`, `client.beta.messages.create({ model:'claude-opus-5-5', max_tokens: 2000, betas:['server-side-fallback-2026-07-01'], fallbacks:'default', output_config:{ effort:'low' }, messages })`. Check `stop_reason === 'refusal'` before reading content (treat as SKIP). Narrow content blocks by `block.type === 'text'`. If the SDK typings reject `fallbacks`/betas, use a `// @ts-expect-error` with a comment. Ask for a strict one-line answer and parse defensively; anything unclear = SKIP.
7. Tooling: Node 22, ESM, TypeScript strict, `tsx`. package.json scripts at least: `dev`, `start`, `once` (= `tsx src/index.ts --once`), `check` (= `tsc --noEmit`), `test` (= `node --import tsx --test "src/**/*.test.ts"`). devDeps include `@types/node`, `typescript`, `tsx`. Remove scripts that point to non-existent files. Only depend on packages that actually exist on npm (`npm view <pkg>` to verify); pin with caret ranges; commit `package-lock.json`.
8. Tests: node:test + node:assert/strict. Cover the core math/decision logic and one full `--once`-style cycle with mocked inputs against a temp MM_STATE_DIR.
9. `.gitignore`: node_modules/, .env, .DS_Store, dist/, .state/, .mm-state/.
10. CI: `.github/workflows/ci.yml` — on push/pull_request: actions/checkout@v4, actions/setup-node@v4 (node 22, cache npm), `npm ci`, `npm run check`, `npm test`.
11. README: accurate, no profit promises. Sections: what it does, how it fits into the system, setup, env vars, run modes, safety, status/limitations (be honest about what is simulated).
12. `.env.example` up to date (include MM_STATE_DIR).
13. Do NOT git commit or push — leave changes in the working tree. Do not touch other repos.
14. Before finishing: `npm install`, `npm run check` and `npm test` must pass, and `MM_STATE_DIR=$(mktemp -d) npm run once` must succeed with no secrets set. Report what you built, what's simulated, and any open issues.
