import type { SlaThresholds } from './sla-thresholds';

/**
 * What the tools need to know about SLA alerting for the caller: whether the
 * server pushes urgency on its own, and the thresholds in force.
 */
export interface SlaService {
  push: boolean;
  thresholds: () => Promise<SlaThresholds>;
}

export interface SlaSettings {
  slaPush: boolean;
  slaThresholds: SlaThresholds;
}

export const createSlaService = (settings: SlaSettings): SlaService => ({
  push: settings.slaPush,
  thresholds: () => Promise.resolve(settings.slaThresholds),
});
