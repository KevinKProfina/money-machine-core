import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DeployResult } from './state.js';

export type Deployer = (siteDir: string) => Promise<DeployResult>;

/**
 * Run the owner's deploy command (shell, cwd = site dir). The whole process group is
 * killed on timeout. Output is tail-captured and appended to the deploy log.
 */
export function runDeployCmd(cmd: string, siteDir: string, timeoutMs: number, logFile?: string, now: () => Date = () => new Date()): Promise<DeployResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-4000);
    };
    const child = spawn('sh', ['-c', cmd], { cwd: siteDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const finish = async (code: number | null, error?: Error) => {
      clearTimeout(timer);
      const result: DeployResult = {
        ok: !timedOut && !error && code === 0,
        at: now().toISOString(),
        code,
        timedOut,
        durationMs: Date.now() - started,
        outputTail: (error ? `${error.message}\n` : '') + output.slice(-1000),
      };
      if (logFile) {
        try {
          await fsp.mkdir(path.dirname(logFile), { recursive: true });
          await fsp.appendFile(logFile, `[${result.at}] deploy ${result.ok ? 'ok' : timedOut ? 'TIMEOUT' : `FAILED code=${code}`} (${result.durationMs} ms)\n${output.slice(-4000)}\n`, 'utf8');
        } catch {
          // log is best-effort
        }
      }
      resolve(result);
    };
    let done = false;
    child.on('error', (e) => {
      if (!done) {
        done = true;
        void finish(null, e);
      }
    });
    child.on('close', (code) => {
      if (!done) {
        done = true;
        void finish(code);
      }
    });
  });
}
