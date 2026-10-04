import fsp from 'node:fs/promises';
import path from 'node:path';
import { emitEvent, readJsonSafe, statePaths, writeJsonAtomic } from '../contract/mm-contract.js';
import { cyclePhases, type SystemConfig } from './config.js';
import { diffAlerts, telegramSender, type AlertSender, type AlertState } from './alerts.js';
import { Daemon, runStep, type StepResult } from './runner.js';
import { collectStatus, supervisorStatePath, type SupervisorState } from './status.js';

type StepRunner = (component: SystemConfig['components'][number], config: SystemConfig) => Promise<StepResult>;

export async function setKillSwitch(reason: string): Promise<void> {
  await fsp.mkdir(path.dirname(statePaths.kill()), { recursive: true });
  await fsp.writeFile(statePaths.kill(), `${new Date().toISOString()} ${reason}\n`, 'utf8');
  await emitEvent({ source: 'money-machine-core', level: 'error', type: 'kill-switch.on', message: `Kill switch activated: ${reason}` });
}

export async function clearKillSwitch(): Promise<boolean> {
  try {
    await fsp.unlink(statePaths.kill());
  } catch {
    return false;
  }
  await emitEvent({ source: 'money-machine-core', level: 'warn', type: 'kill-switch.off', message: 'Kill switch cleared' });
  return true;
}

async function updateSupervisorState(mutate: (state: SupervisorState) => void): Promise<void> {
  const state = await readJsonSafe<SupervisorState>(supervisorStatePath(), { cycles: 0, daemons: [] });
  mutate(state);
  await writeJsonAtomic(supervisorStatePath(), state);
}

/**
 * Runs one full system cycle: phases in ascending order, components of the same
 * phase in parallel. A failing component never blocks later phases — the
 * orchestrator treats missing/stale reports as unhealthy, which is the safe default.
 */
export async function runCycle(config: SystemConfig, run: StepRunner = runStep): Promise<{ ok: boolean; steps: StepResult[] }> {
  const startedAt = new Date().toISOString();
  const steps: StepResult[] = [];
  for (const phase of cyclePhases(config)) {
    const results = await Promise.all(phase.map((component) => run(component, config)));
    steps.push(...results);
  }
  const ok = steps.every((s) => s.ok);
  const finishedAt = new Date().toISOString();

  await updateSupervisorState((state) => {
    state.cycles += 1;
    state.lastCycle = { startedAt, finishedAt, ok, steps };
  });
  for (const step of steps.filter((s) => !s.ok)) {
    await emitEvent({
      source: 'money-machine-core',
      level: step.skipped ? 'warn' : 'error',
      type: 'cycle.step-failed',
      message: `${step.name}: ${step.skipped ?? (step.timedOut ? 'timed out' : `exit code ${step.exitCode}`)}`,
      data: { tail: step.tail.slice(-5) },
    });
  }
  return { ok, steps };
}

export class Supervisor {
  private daemons: Daemon[] = [];
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopping = false;
  private cycleInFlight?: Promise<unknown>;
  private alertState: AlertState = { failing: [], killSwitch: false, live: [] };

  constructor(
    private config: SystemConfig,
    private sendAlert: AlertSender | undefined = telegramSender(),
  ) {}

  private async alert(steps: StepResult[]): Promise<void> {
    if (!this.sendAlert) return;
    const status = await collectStatus();
    const next: AlertState = {
      failing: steps.filter((s) => !s.ok).map((s) => s.name).sort(),
      killSwitch: status.killSwitch.active || Boolean(status.allocations?.killSwitch),
      live: status.strategies.filter((s) => s.mode === 'live').map((s) => s.name).sort(),
    };
    for (const text of diffAlerts(this.alertState, next)) await this.sendAlert(text);
    this.alertState = next;
  }

  async start(): Promise<void> {
    await updateSupervisorState((state) => {
      state.startedAt = new Date().toISOString();
      state.daemons = [];
    });
    await emitEvent({ source: 'money-machine-core', level: 'info', type: 'supervisor.start', message: 'Supervisor started' });

    for (const component of this.config.components.filter((c) => c.type === 'daemon')) {
      const daemon = new Daemon(component, this.config);
      daemon.start();
      this.daemons.push(daemon);
    }
    this.running = true;
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    const cycle = runCycle(this.config).then(async (result) => {
      await updateSupervisorState((state) => {
        state.daemons = this.daemons.map((d) => ({ ...d.state }));
      });
      await this.alert(result.steps);
      console.log(`cycle finished: ${result.ok ? 'ok' : 'with failures'}; next in ${this.config.cycleIntervalMs} ms`);
    });
    this.cycleInFlight = cycle.catch((err) => console.error(`cycle crashed: ${(err as Error).message}`));
    await this.cycleInFlight;
    if (this.running) this.timer = setTimeout(() => void this.tick(), this.config.cycleIntervalMs);
  }

  daemonStates() {
    return this.daemons.map((d) => ({ ...d.state }));
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.cycleInFlight;
    await Promise.all(this.daemons.map((d) => d.stop()));
    await emitEvent({ source: 'money-machine-core', level: 'info', type: 'supervisor.stop', message: 'Supervisor stopped' });
  }
}
