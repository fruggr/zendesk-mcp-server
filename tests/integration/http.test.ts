import { registerCoreScenarios } from './core-scenarios';
import { httpHarness } from './http-harness';

// The shared MCP roundtrip scenarios, over the HTTP transport and its
// authorization server. The OAuth-specific behaviour lives in http-oauth.test.ts.
registerCoreScenarios(httpHarness);
