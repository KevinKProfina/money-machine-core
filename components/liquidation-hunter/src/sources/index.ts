import type { Config } from '../config.js';
import { AaveV3Source, KaminoSource, MarginFiSource, SaveSource } from './real-stubs.js';
import { SimulatedSource } from './simulated.js';
import type { OpportunitySource } from './types.js';

export function createSource(config: Config): OpportunitySource {
  switch (config.source) {
    case 'simulated':
      return new SimulatedSource(config.simSeed, config.simPositionsPerCycle);
    case 'kamino':
      return new KaminoSource();
    case 'marginfi':
      return new MarginFiSource();
    case 'save':
      return new SaveSource();
    case 'aave-v3':
      return new AaveV3Source();
  }
}

export type { OpportunitySource } from './types.js';
