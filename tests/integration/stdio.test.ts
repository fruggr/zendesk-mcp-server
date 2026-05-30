import { registerCoreScenarios } from './core-scenarios';
import { stdioHarness } from './stdio-harness';

// Runs the shared MCP roundtrip scenarios against the stdio transport. When the
// HTTP transport lands, a sibling http.test.ts will call registerCoreScenarios
// with an http harness to get the same coverage for free.
registerCoreScenarios(stdioHarness);
