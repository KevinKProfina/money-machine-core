import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig, type StudioConfig } from '../config.js';
import type { MMEvent } from '../mm-contract.js';
import type { DeployResult } from '../state.js';
import { StripeChannel } from '../stripe.js';
import { Studio, type Control, type StudioDeps } from '../studio.js';
import { FakeLlm, type FakeLlmOptions } from './fake-llm.js';
import { FakeStripe } from './fake-stripe.js';

export function tempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venture-studio-test-'));
  process.env.MM_STATE_DIR = dir;
  delete process.env.MM_KILL;
  return dir;
}

export const OPERATOR_ENV = {
  STUDIO_SITE_URL: 'https://shop.example.test',
  STUDIO_OPERATOR_NAME: 'Test Operator',
  STUDIO_OPERATOR_ADDRESS: 'Teststr. 1, 12345 Teststadt',
  STUDIO_OPERATOR_EMAIL: 'owner@example.test',
};

export function testConfig(env: Record<string, string> = {}): StudioConfig {
  return readConfig({ ...OPERATOR_ENV, ...env });
}

export type Harness = {
  studio: Studio;
  stripe: FakeStripe;
  llm: FakeLlm | null;
  events: Array<Omit<MMEvent, 'ts'>>;
  deploys: string[];
  clock: { t: number };
  control: Control;
  cycle: () => Promise<void>;
  advanceDays: (d: number) => void;
};

export async function harness(opts: { env?: Record<string, string>; llm?: FakeLlmOptions | null; deployResult?: Partial<DeployResult>; channel?: 'stripe' | 'none'; extra?: Partial<StudioDeps> } = {}): Promise<Harness> {
  const cfg = testConfig(opts.env);
  const clock = { t: Date.UTC(2026, 0, 1) };
  const now = () => new Date(clock.t);
  const stripe = new FakeStripe();
  const llm = opts.llm === null ? null : new FakeLlm({ seed: 'test', badDraftRate: 0, ...(opts.llm ?? {}) });
  const events: Array<Omit<MMEvent, 'ts'>> = [];
  const deploys: string[] = [];
  const control: Control = { halted: false };
  const studio = await Studio.open({
    cfg,
    now,
    llm,
    channel: opts.channel === 'none' ? undefined : new StripeChannel('sk_test_x', { fetchImpl: stripe.fetch, backoffMs: 1 }),
    deploy: async (dir) => {
      deploys.push(dir);
      return { ok: true, at: now().toISOString(), code: 0, timedOut: false, durationMs: 1, outputTail: '', ...opts.deployResult };
    },
    emit: async (e) => {
      events.push(e);
    },
    log: () => undefined,
    control: async () => ({ ...control }),
    ...opts.extra,
  });
  return {
    studio,
    stripe,
    llm,
    events,
    deploys,
    clock,
    control,
    cycle: async () => {
      clock.t += 3_600_000;
      await studio.cycle();
    },
    advanceDays: (d) => {
      clock.t += d * 86_400_000;
    },
  };
}
