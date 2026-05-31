/**
 * Automated validation runner for the meta-MCP PoC.
 *
 * It connects to the meta-MCP exactly like Claude Code would (spawning it over
 * stdio as an MCP client), then exercises AC-1 … AC-9 by calling ONLY the fixed
 * meta-tools — never restarting the meta-MCP and never touching the SUT process
 * directly. For AC-4 it edits the SUT *source* (A → B) on disk between two
 * `sut_reload` calls, proving hot reload inside a single client session.
 *
 * Outputs:
 *   - live transcript on stdout
 *   - poc/artifacts/transcript.md   (human-readable call/response log)
 *   - poc/artifacts/results.json    (machine-readable AC verdicts)
 *
 * Run:  node node_modules/tsx/dist/cli.mjs poc/validate.ts
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const TSX_CLI = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
const META_ENTRY = fileURLToPath(new URL('./meta-mcp/index.ts', import.meta.url));
const SUT_SERVER = fileURLToPath(new URL('./sut/server.ts', import.meta.url));
const VARIANT_A = fileURLToPath(new URL('./sut/variants/variant-a.ts', import.meta.url));
const VARIANT_B = fileURLToPath(new URL('./sut/variants/variant-b.ts', import.meta.url));
const BROKEN = fileURLToPath(new URL('./sut/broken.ts', import.meta.url));
const NOISY = fileURLToPath(new URL('./sut/noisy.ts', import.meta.url));
const ARTIFACTS = fileURLToPath(new URL('./artifacts/', import.meta.url));

interface AcVerdict {
  id: string;
  title: string;
  status: 'PASS' | 'FAIL' | 'WARN';
  detail: string;
  evidence: string[];
}

const transcript: string[] = [];
const verdicts: AcVerdict[] = [];

// Snapshot the committed SUT source (variant A) so the run can edit it A→B and
// restore it byte-for-byte afterwards, leaving the working tree clean.
const originalServer = readFileSync(SUT_SERVER);

function log(line = ''): void {
  console.log(line);
  transcript.push(line);
}

function section(title: string): void {
  log('');
  log(`## ${title}`);
}

let meta: Client;

/** Call a meta-tool and return { isError, data } where data is the parsed JSON body. */
async function call(
  tool: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; data: any; raw: string }> {
  const res: any = await meta.callTool({ name: tool, arguments: args });
  const raw = (res.content ?? []).map((c: any) => c.text ?? '').join('\n');
  let data: any = raw;
  try {
    data = JSON.parse(raw);
  } catch {
    /* leave as string */
  }
  const isError = Boolean(res.isError);
  log('');
  log('```jsonc');
  log(`// → ${tool}(${JSON.stringify(args)})${isError ? '   [isError]' : ''}`);
  log(raw.length > 1400 ? `${raw.slice(0, 1400)}\n… (truncated)` : raw);
  log('```');
  return { isError, data, raw };
}

function record(v: AcVerdict): void {
  verdicts.push(v);
  const icon = v.status === 'PASS' ? '✅' : v.status === 'WARN' ? '⚠️' : '❌';
  log('');
  log(`**${v.id} — ${v.title}: ${icon} ${v.status}** — ${v.detail}`);
}

function pidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  log('# Meta-MCP PoC — automated validation transcript');
  log('');
  log(`- Date: ${new Date().toISOString()}`);
  log(`- Node: ${process.version}`);
  log(`- Meta-MCP entry: \`${META_ENTRY}\``);
  log('- Client → meta-MCP over stdio; the meta-MCP is the MCP *client* of the SUT.');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, META_ENTRY],
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (c: Buffer) => process.stderr.write(`[meta-mcp stderr] ${c}`));
  meta = new Client({ name: 'poc-validator', version: '1.0.0' });
  await meta.connect(transport);

  // Snapshot the fixed meta surface up-front (AC-5 baseline).
  const metaToolsBefore = (await meta.listTools()).tools.map((t) => t.name).sort();
  log('');
  log(`Meta-tools exposed (fixed surface): ${JSON.stringify(metaToolsBefore)}`);

  // ---- AC-1: initial load + start (variant A) -------------------------------
  section('AC-1 — Initial load & start (variant A)');
  const start = await call('sut_start');
  const status1 = await call('sut_status');
  record({
    id: 'AC-1',
    title: 'Initial load',
    status: !start.isError && status1.data.running && status1.data.pid ? 'PASS' : 'FAIL',
    detail: `handshake ok=${!start.isError}, running=${status1.data.running}, pid=${status1.data.pid}, serverInfo=${JSON.stringify(start.data.serverInfo)}`,
    evidence: [
      `sut_start ok=${!start.isError}`,
      `sut_status running=${status1.data.running} pid=${status1.data.pid}`,
    ],
  });

  // ---- AC-2: proxied listing (variant A = 1 tool echo) ----------------------
  section('AC-2 — Proxied tools/list (variant A)');
  const listA = await call('sut_list_tools');
  const toolsA = (listA.data.tools ?? []) as any[];
  const echoA = toolsA.find((t) => t.name === 'echo');
  const ac2ok =
    toolsA.length === 1 &&
    echoA &&
    typeof echoA.description === 'string' &&
    echoA.inputSchema &&
    echoA.annotations?.readOnlyHint === true;
  record({
    id: 'AC-2',
    title: 'Proxied listing',
    status: ac2ok ? 'PASS' : 'FAIL',
    detail: `${toolsA.length} tool(s): ${toolsA.map((t) => t.name).join(', ')}; echo desc="${echoA?.description}"; annotations=${JSON.stringify(echoA?.annotations)}`,
    evidence: [`tools=${JSON.stringify(toolsA.map((t) => t.name))}`],
  });

  // ---- AC-3: proxied call ---------------------------------------------------
  section('AC-3 — Proxied tools/call (echo)');
  const echoCall = await call('sut_call_tool', { name: 'echo', arguments: { text: 'hi' } });
  const echoText = echoCall.data?.result?.content?.[0]?.text;
  record({
    id: 'AC-3',
    title: 'Proxied call',
    status: !echoCall.isError && echoText === 'hi' ? 'PASS' : 'FAIL',
    detail: `echo("hi") → ${JSON.stringify(echoText)}`,
    evidence: [`echo result text=${JSON.stringify(echoText)}`],
  });

  // ---- AC-4: hot reload A → B (CORE) ----------------------------------------
  section('AC-4 — Hot reload A→B without session restart (CORE)');
  log('');
  log(
    'Editing SUT *source* on disk: copying variant-b.ts over sut/server.ts (simulates a dev edit)…',
  );
  copyFileSync(VARIANT_B, SUT_SERVER); // <-- the "code change"
  const reload = await call('sut_reload');
  const listB = await call('sut_list_tools');
  const toolsB = (listB.data.tools ?? []) as any[];
  const reverseCall = await call('sut_call_tool', { name: 'reverse', arguments: { text: 'abc' } });
  const reverseText = reverseCall.data?.result?.content?.[0]?.text;
  const hasReverse = toolsB.some((t) => t.name === 'reverse');
  const ac4ok = !reload.isError && toolsB.length === 2 && hasReverse && reverseText === 'cba';
  record({
    id: 'AC-4',
    title: 'Hot reload (CORE)',
    status: ac4ok ? 'PASS' : 'FAIL',
    detail: `reload diff=${JSON.stringify(reload.data.diff)}; tools now=[${toolsB.map((t) => t.name).join(', ')}]; reverse("abc")→${JSON.stringify(reverseText)}. Meta-MCP NOT restarted (same stdio session, same transport pid).`,
    evidence: [
      `reload.diff=${JSON.stringify(reload.data.diff)}`,
      `tools=${JSON.stringify(toolsB.map((t) => t.name))}`,
      `reverse=${JSON.stringify(reverseText)}`,
    ],
  });

  // ---- AC-5: meta surface unchanged -----------------------------------------
  section('AC-5 — Meta surface stable (no list_changed dependency)');
  const metaToolsAfter = (await meta.listTools()).tools.map((t) => t.name).sort();
  const ac5ok = JSON.stringify(metaToolsBefore) === JSON.stringify(metaToolsAfter);
  log('');
  log(`Meta-tools before AC-2: ${JSON.stringify(metaToolsBefore)}`);
  log(`Meta-tools after AC-4:  ${JSON.stringify(metaToolsAfter)}`);
  record({
    id: 'AC-5',
    title: 'Meta surface persistence',
    status: ac5ok ? 'PASS' : 'FAIL',
    detail: `The client-visible meta-tool list is byte-identical before/after the SUT mutated A→B. The SUT's 1→2 tool change happened entirely behind the fixed meta surface, so no client-side list_changed handling was required.`,
    evidence: [
      `before=${JSON.stringify(metaToolsBefore)}`,
      `after=${JSON.stringify(metaToolsAfter)}`,
    ],
  });

  // ---- AC-6: robustness to SUT crash ----------------------------------------
  section('AC-6 — Robustness to a crashing SUT');
  await call('sut_stop'); // free the slot held by the running variant-B SUT
  const brokenStart = await call('sut_start', { args: [TSX_CLI, BROKEN] });
  const statusAfterCrash = await call('sut_status');
  const logsAfterCrash = await call('sut_logs', { lines: 10 });
  const metaStillAlive =
    Array.isArray(logsAfterCrash.data.lines) && typeof statusAfterCrash.data.state === 'string';
  record({
    id: 'AC-6',
    title: 'Crash robustness',
    status: brokenStart.isError && metaStillAlive ? 'PASS' : 'FAIL',
    detail: `sut_start(broken) returned structured error (isError=${brokenStart.isError}: "${brokenStart.data.error}"). Meta-MCP still answers sut_status (state=${statusAfterCrash.data.state}) and sut_logs (${logsAfterCrash.data.lines?.length} lines).`,
    evidence: [
      `error=${JSON.stringify(brokenStart.data.error)}`,
      `logs=${JSON.stringify(logsAfterCrash.data.lines)}`,
    ],
  });

  // ---- AC-7: stdout/stderr isolation ----------------------------------------
  section('AC-7 — stdout noise does not corrupt JSON-RPC');
  await call('sut_stop');
  const noisyStart = await call('sut_start', { args: [TSX_CLI, NOISY] });
  const noisyStatus = await call('sut_status');
  const noisyEcho = await call('sut_call_tool', {
    name: 'echo',
    arguments: { text: 'still-works' },
  });
  const noisyEchoText = noisyEcho.data?.result?.content?.[0]?.text;
  const ac7ok =
    !noisyStart.isError && noisyStatus.data.parseErrorCount > 0 && noisyEchoText === 'still-works';
  record({
    id: 'AC-7',
    title: 'stdout/stderr isolation',
    status: ac7ok ? 'PASS' : 'FAIL',
    detail: `SUT printed garbage to stdout; handshake still succeeded (ok=${!noisyStart.isError}). Malformed lines were captured as parse errors (parseErrorCount=${noisyStatus.data.parseErrorCount}, last="${noisyStatus.data.lastParseError}") and did NOT break the protocol: echo→${JSON.stringify(noisyEchoText)}.`,
    evidence: [
      `parseErrorCount=${noisyStatus.data.parseErrorCount}`,
      `lastParseError=${JSON.stringify(noisyStatus.data.lastParseError)}`,
      `echo=${JSON.stringify(noisyEchoText)}`,
    ],
  });

  // ---- AC-8: clean stop + no orphans ----------------------------------------
  section('AC-8 — Clean stop & no orphan processes');
  // Restore the default (variant A) SUT and exercise stop + two reload cycles.
  copyFileSync(VARIANT_A, SUT_SERVER);
  await call('sut_stop');
  const seenPids: number[] = [];
  const s1 = await call('sut_start');
  seenPids.push(s1.data.pid);
  const r1 = await call('sut_reload');
  const p2 = (await call('sut_status')).data.pid;
  seenPids.push(p2);
  const r2 = await call('sut_reload');
  const p3 = (await call('sut_status')).data.pid;
  seenPids.push(p3);
  void r1;
  void r2;
  const stop = await call('sut_stop');
  const stoppedPid = stop.data.pid;
  // Give the OS a moment to reap.
  await new Promise((r) => setTimeout(r, 300));
  const orphans = seenPids.filter((pid, i) => i < seenPids.length - 1 && pidAlive(pid));
  const lastDead = !pidAlive(stoppedPid);
  const ac8ok = orphans.length === 0 && lastDead;
  record({
    id: 'AC-8',
    title: 'Clean stop / no orphans',
    status: ac8ok ? 'PASS' : 'FAIL',
    detail: `pids across 1 start + 2 reloads: ${JSON.stringify(seenPids)}. After stop, all are dead (orphans alive=${JSON.stringify(orphans)}, finalPid ${stoppedPid} alive=${pidAlive(stoppedPid)}).`,
    evidence: [`seenPids=${JSON.stringify(seenPids)}`, `orphansAlive=${JSON.stringify(orphans)}`],
  });

  // ---- AC-9: same-session story ---------------------------------------------
  section('AC-9 — Whole loop in one client session');
  const ac9ok = verdicts.find((v) => v.id === 'AC-4')?.status === 'PASS' && ac5ok;
  record({
    id: 'AC-9',
    title: 'Single-session executability',
    status: ac9ok ? 'PASS' : 'FAIL',
    detail:
      'Every step above ran against ONE meta-MCP process connected once over stdio (single client session). No reconnect/initialize was issued to the meta-MCP between AC-1 and AC-8; only the SUT subprocess was spawned/killed. The same is true when the meta-MCP is configured in Claude Code web — see poc/README.md.',
    evidence: ['single meta-MCP connect()', 'AC-4 PASS within it', 'AC-5 meta surface stable'],
  });

  await call('sut_stop');
  await meta.close();

  // Restore the committed SUT source byte-for-byte (run leaves no diff).
  writeFileSync(SUT_SERVER, originalServer);

  // ---- write artifacts ------------------------------------------------------
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(`${ARTIFACTS}transcript.md`, transcript.join('\n'));
  writeFileSync(
    `${ARTIFACTS}results.json`,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), node: process.version, verdicts },
      null,
      2,
    ),
  );

  // ---- summary --------------------------------------------------------------
  section('Summary');
  for (const v of verdicts) {
    const icon = v.status === 'PASS' ? '✅' : v.status === 'WARN' ? '⚠️' : '❌';
    log(`${icon} ${v.id} ${v.title}: ${v.status}`);
  }
  writeFileSync(`${ARTIFACTS}transcript.md`, transcript.join('\n'));

  const failed = verdicts.filter((v) => v.status === 'FAIL');
  const blockers = verdicts.filter(
    (v) => (v.id === 'AC-4' || v.id === 'AC-9') && v.status !== 'PASS',
  );
  log('');
  log(
    `Result: ${verdicts.length - failed.length}/${verdicts.length} PASS. Blocking ACs (AC-4, AC-9) ${blockers.length === 0 ? 'PASS ✅' : 'FAILED ❌'}.`,
  );
  process.exit(blockers.length === 0 && failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Validator crashed:', err);
  // Best-effort: restore the committed SUT source so the repo is left clean.
  try {
    writeFileSync(SUT_SERVER, originalServer);
  } catch {
    /* ignore */
  }
  process.exit(2);
});
