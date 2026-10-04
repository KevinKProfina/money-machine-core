import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { SystemConfig } from './config.js';

type Component = SystemConfig['components'][number];

export type StepResult = {
  name: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  skipped?: string;
  durationMs: number;
  /** Last lines of output, for status display. */
  tail: string[];
};

const TAIL_LINES = 15;

/** Why a component can't run, or undefined when it's ready. */
export function componentProblem(component: Component): string | undefined {
  if (!fs.existsSync(path.join(component.absDir, 'package.json'))) return `missing ${component.absDir}/package.json`;
  if (!fs.existsSync(path.join(component.absDir, 'node_modules'))) return 'dependencies not installed (run: npm run install-all)';
  return undefined;
}

function openLog(config: SystemConfig, name: string): fs.WriteStream {
  fs.mkdirSync(config.logsDir, { recursive: true });
  return fs.createWriteStream(path.join(config.logsDir, `${name}.log`), { flags: 'a' });
}

function spawnNpm(component: Component, args: string[], config: SystemConfig): ChildProcess {
  return spawn('npm', args, {
    cwd: component.absDir,
    env: { ...process.env, MM_STATE_DIR: config.stateDir, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // own process group so a timeout can kill npm *and* the tsx child
    detached: process.platform !== 'win32',
  });
}

function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // already gone
  }
}

function pipeOutput(child: ChildProcess, name: string, log: fs.WriteStream, tail: string[], echo: boolean) {
  const onData = (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    log.write(text);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      tail.push(line);
      if (tail.length > TAIL_LINES) tail.shift();
      if (echo) console.log(`[${name}] ${line}`);
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
}

/** Runs one cycle of a component (`npm run <script>`), enforcing the step timeout. */
export async function runStep(component: Component, config: SystemConfig, echo = true): Promise<StepResult> {
  const started = Date.now();
  const problem = componentProblem(component);
  if (problem) {
    return { name: component.name, ok: false, exitCode: null, timedOut: false, skipped: problem, durationMs: 0, tail: [] };
  }

  const log = openLog(config, component.name);
  log.write(`\n===== ${new Date().toISOString()} npm run ${component.script} =====\n`);
  const tail: string[] = [];
  const child = spawnNpm(component, ['run', '--silent', component.script], config);
  pipeOutput(child, component.name, log, tail, echo);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child, 'SIGTERM');
    setTimeout(() => killTree(child, 'SIGKILL'), 5_000).unref();
  }, config.stepTimeoutMs);

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('error', (err) => {
      tail.push(`spawn error: ${err.message}`);
      resolve(null);
    });
    child.on('close', (code) => resolve(code));
  });
  clearTimeout(timer);
  log.end();

  return {
    name: component.name,
    ok: exitCode === 0 && !timedOut,
    exitCode,
    timedOut,
    durationMs: Date.now() - started,
    tail,
  };
}

export type DaemonState = {
  name: string;
  running: boolean;
  pid?: number;
  restarts: number;
  lastExit?: { code: number | null; at: string };
  problem?: string;
};

/** Keeps a long-running component alive, restarting with exponential backoff. */
export class Daemon {
  private child?: ChildProcess;
  private stopped = false;
  private backoffMs = 1_000;
  private restartTimer?: NodeJS.Timeout;
  readonly state: DaemonState;

  constructor(private component: Component, private config: SystemConfig) {
    this.state = { name: component.name, running: false, restarts: 0 };
  }

  start() {
    this.stopped = false;
    const problem = componentProblem(this.component);
    if (problem) {
      this.state.problem = problem;
      console.warn(`[${this.component.name}] not started: ${problem}`);
      return;
    }
    this.state.problem = undefined;
    const log = openLog(this.config, this.component.name);
    log.write(`\n===== ${new Date().toISOString()} daemon npm run ${this.component.script} =====\n`);
    const startedAt = Date.now();
    const child = spawnNpm(this.component, ['run', '--silent', this.component.script], this.config);
    this.child = child;
    this.state.running = true;
    this.state.pid = child.pid;
    pipeOutput(child, this.component.name, log, [], true);

    child.on('close', (code) => {
      log.end();
      this.state.running = false;
      this.state.pid = undefined;
      this.state.lastExit = { code, at: new Date().toISOString() };
      if (this.stopped) return;
      // a run that stayed up for a minute resets the backoff
      if (Date.now() - startedAt > 60_000) this.backoffMs = 1_000;
      console.warn(`[${this.component.name}] exited with code ${code}; restarting in ${this.backoffMs} ms`);
      this.restartTimer = setTimeout(() => {
        this.state.restarts += 1;
        this.start();
      }, this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once('close', () => resolve());
      killTree(child, 'SIGTERM');
      setTimeout(() => {
        killTree(child, 'SIGKILL');
        resolve();
      }, 5_000).unref();
    });
  }
}
