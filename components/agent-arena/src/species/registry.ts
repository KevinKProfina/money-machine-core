import type { Species } from '../types.js';
import { traderSpecies } from './trader.js';

/**
 * All species known to the arena. A future `service` species (agents that sell
 * services on agent-marketplace) plugs in here; see README "Next step".
 */
export const SPECIES: Record<string, Species> = {
  [traderSpecies.id]: traderSpecies,
};

export function getSpecies(id: string): Species {
  const s = SPECIES[id];
  if (!s) throw new Error(`unknown species: ${id}`);
  return s;
}
