/**
 * Small seedable PRNG (sfc32) with serialisable state, so a whole arena run is
 * reproducible from a seed and can be resumed across `--once` invocations.
 */
export type RngState = [number, number, number, number];

export class Rng {
  private s: RngState;

  constructor(seedOrState: number | string | RngState) {
    if (Array.isArray(seedOrState)) {
      this.s = [...seedOrState] as RngState;
    } else {
      const h = hashSeed(String(seedOrState));
      this.s = [h[0]!, h[1]!, h[2]!, h[3]!];
      for (let i = 0; i < 15; i++) this.next(); // warm up
    }
  }

  get state(): RngState {
    return [...this.s] as RngState;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    let [a, b, c, d] = this.s;
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    this.s = [a, b, c, d];
    return (t >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(min: number, maxInclusive: number): number {
    return Math.floor(this.range(min, maxInclusive + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Standard normal via Box-Muller. */
  normal(): number {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty array');
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** In-place Fisher-Yates shuffle. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  }

  /** Short random hex id. */
  hex(len = 8): string {
    let out = '';
    while (out.length < len) out += Math.floor(this.next() * 0x100000000).toString(16).padStart(8, '0');
    return out.slice(0, len);
  }
}

function hashSeed(str: string): number[] {
  // cyrb128
  let h1 = 1779033703,
    h2 = 3144134277,
    h3 = 1013904242,
    h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}
