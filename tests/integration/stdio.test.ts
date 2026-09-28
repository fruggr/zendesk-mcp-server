import { registerCoreScenarios } from './core-scenarios';
import { stdioHarness } from './stdio-harness';

// Runs the shared MCP roundtrip scenarios against the stdio transport; the
// sibling http.test.ts runs the same scenarios over HTTP.
registerCoreScenarios(stdioHarness);
