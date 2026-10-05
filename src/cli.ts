#!/usr/bin/env -S npx tsx
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadSystemConfig, type SystemConfig } from './config.js';
import { startDashboard } from './dashboard.js';
import { telegramSender } from './alerts.js';
import { createBackup, listBackups, restoreBackup } from './maintenance.js';
import { componentProblem } from './runner.js';
import { collectStatus, formatStatus } from './status.js';
import { clearKillSwitch, runCycle, setKillSwitch, Supervisor } from './supervisor.js';

const CONTRACT_SOURCE = (config: SystemConfig) => path.join(config.coreDir, 'contract', 'mm-contract.ts');

/** Lists components whose src/mm-contract.ts differs from the canonical contract. */
export function contractDrift(config: SystemConfig): { name: string; problem: string }[] {
  const canonical = fs.readFileSync(CONTRACT_SOURCE(config), 'utf8');
  const drift: { name: string; problem: string }[] = [];
  for (const c of config.components) {
    const copy = path.join(c.absDir, 'src', 'mm-contract.ts');
    if (!fs.existsSync(copy)) drift.push({ name: c.name, problem: 'missing src/mm-contract.ts' });
    else if (fs.readFileSync(copy, 'utf8') !== canonical) drift.push({ name: c.name, problem: 'src/mm-contract.ts differs from contract' });
  }
  return drift;
}

async function cmdStart(config: SystemConfig) {
  const supervisor = new Supervisor(config);
  const server = await startDashboard({
    host: config.dashboardHost,
    port: config.dashboardPort,
    adminToken: config.adminToken,
    // a healthy supervisor finishes a cycle at least every interval + all step timeouts
    staleCycleMs: 2 * (config.cycleIntervalMs + config.stepTimeoutMs * config.components.length),
  });
  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down…`);
    server.close();
    await supervisor.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await supervisor.start();
}

async function cmdOnce(config: SystemConfig) {
  const result = await runCycle(config);
  console.log('');
  console.log(formatStatus(await collectStatus()));
  process.exitCode = result.ok ? 0 : 1;
}

function cmdInstall(config: SystemConfig) {
  let failed = false;
  for (const dir of [config.coreDir, ...config.components.map((c) => c.absDir)]) {
    if (!fs.existsSync(path.join(dir, 'package.json'))) {
      console.warn(`skip ${dir}: no package.json`);
      continue;
    }
    const hasLock = fs.existsSync(path.join(dir, 'package-lock.json'));
    console.log(`→ ${path.basename(dir)}: npm ${hasLock ? 'ci' : 'install'}`);
    const r = spawnSync('npm', [hasLock ? 'ci' : 'install', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' });
    if (r.status !== 0) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
}

function cmdSyncContract(config: SystemConfig) {
  const source = CONTRACT_SOURCE(config);
  for (const c of config.components) {
    if (!fs.existsSync(path.join(c.absDir, 'package.json'))) {
      console.warn(`skip ${c.name}: not found at ${c.absDir}`);
      continue;
    }
    fs.mkdirSync(path.join(c.absDir, 'src'), { recursive: true });
    fs.copyFileSync(source, path.join(c.absDir, 'src', 'mm-contract.ts'));
    console.log(`synced contract → ${c.name}`);
  }
}

function cmdDoctor(config: SystemConfig) {
  let problems = 0;
  console.log(`root: ${config.root}`);
  console.log(`state dir: ${config.stateDir}`);
  for (const c of config.components) {
    const problem = componentProblem(c);
    console.log(`${problem ? '✗' : '✓'} ${c.name.padEnd(22)} ${c.type.padEnd(6)} ${problem ?? c.absDir}`);
    if (problem) problems++;
  }
  for (const d of contractDrift(config)) {
    console.log(`✗ ${d.name}: ${d.problem} (run: npm run sync-contract)`);
    problems++;
  }
  console.log(problems ? `${problems} problem(s) found` : 'all good');
  process.exitCode = problems ? 1 : 0;
}

const USAGE = `usage: mm <command>
  start            run supervisor loop + daemons + dashboard
  once             run a single system cycle and print status
  status [--json]  print current system status
  kill [reason]    activate the global kill switch (no new positions anywhere)
  resume           clear the kill switch
  install          npm ci/install in core and all component repos
  sync-contract    copy contract/mm-contract.ts into every component repo
  doctor           check component checkouts, dependencies and contract copies
  test-alert       send a Telegram test message
  backup           write a state backup now (MM_BACKUP_DIR, keeps MM_BACKUP_KEEP)
  restore <file> <dir>  unpack a backup into an empty directory`;

export async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const config = loadSystemConfig();
  switch (command) {
    case 'start':
      return cmdStart(config);
    case 'once':
      return cmdOnce(config);
    case 'status': {
      const status = await collectStatus();
      console.log(rest.includes('--json') ? JSON.stringify(status, null, 2) : formatStatus(status));
      return;
    }
    case 'kill':
      await setKillSwitch(rest.join(' ') || 'manual (cli)');
      console.log('kill switch ACTIVE — strategies will stop opening positions on their next cycle');
      return;
    case 'resume':
      console.log((await clearKillSwitch()) ? 'kill switch cleared' : 'kill switch was not active');
      return;
    case 'test-alert': {
      const send = telegramSender();
      if (!send) throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set');
      await send('✅ Money Machine: Testalarm — Telegram-Benachrichtigungen funktionieren.');
      console.log('test alert sent (if nothing arrives, check the bot token, the chat id and that you messaged the bot once)');
      return;
    }
    case 'install':
      return cmdInstall(config);
    case 'sync-contract':
      return cmdSyncContract(config);
    case 'doctor':
      return cmdDoctor(config);
    case 'backup': {
      const file = await createBackup({ stateDir: config.stateDir, backupDir: config.backupDir, keep: config.backupKeep });
      console.log(`backup written: ${file}`);
      console.log(`backups kept: ${(await listBackups(config.backupDir)).length}`);
      return;
    }
    case 'restore': {
      const [archive, target] = rest;
      if (!archive || !target) throw new Error('usage: mm restore <backup.tar.gz> <empty target dir>');
      await restoreBackup(path.resolve(archive), path.resolve(target));
      console.log(`restored into ${target} — start with MM_STATE_DIR=${path.resolve(target)}`);
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
