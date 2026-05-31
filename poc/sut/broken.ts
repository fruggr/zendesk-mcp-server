/**
 * Broken SUT — throws during startup, before the stdio handshake can complete.
 * Used for AC-6: `sut_start`/`sut_reload` must surface a structured error and
 * the meta-MCP must stay alive (still answering `sut_status` / `sut_logs`).
 */
console.error('[demo-sut broken] about to crash on purpose…');
throw new Error('demo-sut-broken: intentional startup crash for robustness testing');
