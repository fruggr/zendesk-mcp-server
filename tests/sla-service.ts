import { createSlaRuntime, createSlaService, type SlaService } from '../src/utils/sla-service';
import { DEFAULT_SLA_THRESHOLDS } from '../src/utils/sla-thresholds';

/** An SLA service on a fresh memory store, for a caller whose user id is 42. */
export const testSlaService = (overrides: Partial<SlaService> = {}): SlaService => ({
  ...createSlaService(
    {
      subdomain: 'testsubdomain',
      slaPush: true,
      slaThresholds: DEFAULT_SLA_THRESHOLDS,
      slaCacheTtlSeconds: 60,
      slaUserPreferences: true,
    },
    createSlaRuntime({ slaCacheTtlSeconds: 60 }),
    () => Promise.resolve(42),
  ),
  ...overrides,
});
