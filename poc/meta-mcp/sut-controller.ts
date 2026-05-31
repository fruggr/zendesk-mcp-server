/**
 * SutController — the engine behind the meta-tools.
 *
 * It owns the lifecycle of a single SUT subprocess and acts as an MCP *client*
 * toward it: spawn (via `StdioClientTransport`), `initialize` handshake, list
 * tools, call tools, reload (kill + respawn), stop.
 *
 * Design invariants (mirror the PO's behavioural requirements):
 *  - The controller NEVER throws across the meta-tool boundary for SUT faults.
 *    Every method returns a structured result; callers turn it into a tool
 *    result. A SUT crash is data, not an exception that takes down the meta-MCP.
 *  - `reload()` guarantees the old process is fully gone before respawning
 *    (StdioClientTransport.close() does SIGTERM → SIGKILL with timeouts).
 *  - The SUT's stdout (JSON-RPC) and stderr (logs) are isolated: stderr is
 *    piped into a ring buffer; malformed stdout lines are captured as parse
 *    errors and never corrupt the protocol stream.
 */
import type { ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface SutSpawnParams {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface SutToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
}

export interface ToolsDiff {
  added: string[];
  removed: string[];
  /** Tools present before and after whose description changed. */
  changed: string[];
  before: string[];
  after: string[];
}

type RunState = 'stopped' | 'running' | 'error';

const STDERR_RING_MAX = 500;

/**
 * Captures the child process exit code, which `StdioClientTransport` does not
 * expose. We attach our own `exit` listener on top of the transport's own
 * `close` handling — purely additive, so the SDK's lifecycle is untouched.
 */
class TrackedStdioTransport extends StdioClientTransport {
  exitCode: number | null = null;
  exitSignal: NodeJS.Signals | null = null;

  override async start(): Promise<void> {
    await super.start();
    // `_process` is private in the SDK; reach it once to observe the exit code.
    const proc = (this as unknown as { _process?: ChildProcess })._process;
    proc?.once('exit', (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
    });
  }
}

export interface StartResult {
  ok: boolean;
  pid?: number | null;
  serverInfo?: { name: string; version: string } | undefined;
  capabilities?: unknown;
  instructions?: string | undefined;
  error?: string;
  recentLogs?: string[];
}

export class SutController {
  private client: TrackedClient | null = null;
  private transport: TrackedStdioTransport | null = null;
  private state: RunState = 'stopped';
  private params: SutSpawnParams;

  private pid: number | null = null;
  private lastError: string | null = null;
  private lastExitCode: number | null = null;
  private lastExitSignal: NodeJS.Signals | null = null;
  private serverInfo: { name: string; version: string } | null = null;

  private readonly stderrRing: string[] = [];
  /** Malformed stdout lines reported by the transport (AC-7 evidence). */
  private parseErrorCount = 0;
  private lastParseError: string | null = null;
  /** Snapshot of the last successful tools/list, used for reload diffs. */
  private lastTools: SutToolInfo[] = [];

  constructor(defaults: SutSpawnParams) {
    this.params = defaults;
  }

  isRunning(): boolean {
    return this.state === 'running' && this.client !== null;
  }

  /** Spawn the SUT and run the `initialize` handshake. */
  async start(override: Partial<SutSpawnParams> = {}): Promise<StartResult> {
    if (this.isRunning()) {
      return {
        ok: false,
        error: `SUT already running (pid ${this.pid}). Call sut_stop or sut_reload first.`,
      };
    }

    // Merge defaults with this call's overrides (Q2: default config + override).
    this.params = {
      command: override.command ?? this.params.command,
      args: override.args ?? this.params.args,
      cwd: override.cwd ?? this.params.cwd,
      env: override.env ?? this.params.env,
    };

    return this.spawnOnce();
  }

  private async spawnOnce(): Promise<StartResult> {
    this.lastError = null;
    this.parseErrorCount = 0;
    this.lastParseError = null;

    const transport = new TrackedStdioTransport({
      command: this.params.command,
      args: this.params.args,
      cwd: this.params.cwd,
      // Merge so the SUT keeps a usable env while honouring per-call overrides.
      env: { ...sanitizedParentEnv(), ...(this.params.env ?? {}) },
      // Isolate logs from protocol: stderr is piped, never inherited onto our own.
      stderr: 'pipe',
    });

    // Pipe SUT stderr into a bounded ring buffer.
    transport.stderr?.on('data', (chunk: Buffer) => this.appendStderr(chunk.toString('utf8')));

    const client = new TrackedClient({ name: 'meta-mcp', version: '0.1.0' });
    // Capture transport-level errors (incl. malformed stdout lines) without
    // letting them bubble up as exceptions. This is the AC-7 seam.
    client.onerror = (err: Error) => {
      this.parseErrorCount += 1;
      this.lastParseError = err.message;
      this.appendStderr(`[meta-mcp] transport error (ignored, SUT kept alive): ${err.message}`);
    };

    try {
      await client.connect(transport);
    } catch (err) {
      // Spawn failure / crash during handshake → structured error, stay alive.
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      this.state = 'error';
      this.pid = transport.pid ?? null;
      this.lastExitCode = transport.exitCode;
      this.lastExitSignal = transport.exitSignal;
      // Best-effort cleanup so we never leak a half-spawned process.
      await safeClose(transport);
      this.client = null;
      this.transport = null;
      return {
        ok: false,
        error: message,
        pid: this.pid,
        recentLogs: this.tailStderr(20),
      };
    }

    this.client = client;
    this.transport = transport;
    this.state = 'running';
    this.pid = transport.pid ?? null;

    const info = client.getServerVersion();
    this.serverInfo = info ? { name: info.name, version: info.version } : null;

    // Prime the tools snapshot so a later reload can diff against it.
    await this.refreshToolsSnapshot();

    return {
      ok: true,
      pid: this.pid,
      serverInfo: this.serverInfo ?? undefined,
      capabilities: client.getServerCapabilities(),
      instructions: client.getInstructions(),
      recentLogs: this.tailStderr(10),
    };
  }

  /** Stop the SUT cleanly (SIGTERM → SIGKILL fallback handled by the SDK). */
  async stop(): Promise<{
    ok: boolean;
    pid: number | null;
    exitCode: number | null;
    error?: string;
  }> {
    if (!this.client && !this.transport) {
      return { ok: true, pid: null, exitCode: this.lastExitCode, error: 'SUT was not running.' };
    }
    const pidBefore = this.pid;
    try {
      await safeClose(this.transport);
      await this.client?.close().catch(() => {});
    } finally {
      this.lastExitCode = this.transport?.exitCode ?? this.lastExitCode;
      this.lastExitSignal = this.transport?.exitSignal ?? this.lastExitSignal;
      this.client = null;
      this.transport = null;
      this.state = 'stopped';
    }
    return { ok: true, pid: pidBefore, exitCode: this.lastExitCode };
  }

  /**
   * Kill then respawn. Guarantees the old process is gone before the new one
   * starts, and returns the before/after tools diff when both lists are known.
   */
  async reload(): Promise<{
    ok: boolean;
    error?: string;
    diff?: ToolsDiff;
    pid?: number | null;
    recentLogs?: string[];
  }> {
    const before = this.isRunning() ? [...this.lastTools] : [];

    if (this.client || this.transport) {
      await this.stop();
    }

    const started = await this.spawnOnce();
    if (!started.ok) {
      return { ok: false, error: started.error, recentLogs: started.recentLogs };
    }

    const after = [...this.lastTools];
    return {
      ok: true,
      diff: diffTools(before, after),
      pid: this.pid,
      recentLogs: this.tailStderr(10),
    };
  }

  /** Proxy tools/list, refreshing the snapshot used for reload diffs. */
  async listTools(): Promise<{ ok: boolean; tools?: SutToolInfo[]; error?: string }> {
    if (!this.client) return { ok: false, error: 'SUT not running. Call sut_start first.' };
    try {
      const tools = await this.refreshToolsSnapshot();
      return { ok: true, tools };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Pass-through tools/call; returns the SUT's raw result (content + flags). */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    if (!this.client) return { ok: false, error: 'SUT not running. Call sut_start first.' };
    try {
      const result = await this.client.callTool({ name, arguments: args });
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  status(): {
    state: RunState;
    running: boolean;
    pid: number | null;
    lastExitCode: number | null;
    lastExitSignal: NodeJS.Signals | null;
    lastError: string | null;
    serverInfo: { name: string; version: string } | null;
    command: string;
    args: string[];
    cwd?: string;
    stderrLines: number;
    parseErrorCount: number;
    lastParseError: string | null;
  } {
    // Reconcile state with reality in case the child died on its own.
    if (this.transport && this.transport.exitCode !== null && this.state === 'running') {
      this.state = 'error';
      this.lastExitCode = this.transport.exitCode;
      this.lastExitSignal = this.transport.exitSignal;
    }
    return {
      state: this.state,
      running: this.isRunning(),
      pid: this.pid,
      lastExitCode: this.lastExitCode,
      lastExitSignal: this.lastExitSignal,
      lastError: this.lastError,
      serverInfo: this.serverInfo,
      command: this.params.command,
      args: this.params.args,
      cwd: this.params.cwd,
      stderrLines: this.stderrRing.length,
      parseErrorCount: this.parseErrorCount,
      lastParseError: this.lastParseError,
    };
  }

  logs(lines = 50): string[] {
    return this.tailStderr(lines);
  }

  private async refreshToolsSnapshot(): Promise<SutToolInfo[]> {
    if (!this.client) return [];
    const { tools } = await this.client.listTools();
    this.lastTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    }));
    return this.lastTools;
  }

  private appendStderr(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      if (line.length === 0) continue;
      this.stderrRing.push(line);
    }
    while (this.stderrRing.length > STDERR_RING_MAX) this.stderrRing.shift();
  }

  private tailStderr(n: number): string[] {
    return this.stderrRing.slice(Math.max(0, this.stderrRing.length - n));
  }
}

/** Thin alias so the type of `connect`/`listTools` is the SDK's, with our hooks. */
class TrackedClient extends Client {}

function diffTools(before: SutToolInfo[], after: SutToolInfo[]): ToolsDiff {
  const beforeNames = before.map((t) => t.name);
  const afterNames = after.map((t) => t.name);
  const beforeByName = new Map(before.map((t) => [t.name, t]));
  const added = afterNames.filter((n) => !beforeNames.includes(n));
  const removed = beforeNames.filter((n) => !afterNames.includes(n));
  const changed = after
    .filter(
      (t) => beforeByName.has(t.name) && beforeByName.get(t.name)?.description !== t.description,
    )
    .map((t) => t.name);
  return { added, removed, changed, before: beforeNames, after: afterNames };
}

async function safeClose(transport: StdioClientTransport | null): Promise<void> {
  if (!transport) return;
  try {
    await transport.close();
  } catch {
    // close() is best-effort; a dead child is exactly what we want here.
  }
}

/**
 * The SDK's StdioClientTransport already merges a safe default env, but we also
 * forward PATH-ish vars so `tsx`/`node` resolve. Secrets-by-env for SUT backend
 * mocks (Q3) would be added by the caller via `params.env`.
 */
function sanitizedParentEnv(): Record<string, string> {
  const keep = ['PATH', 'HOME', 'NODE_OPTIONS', 'TMPDIR', 'LANG', 'LC_ALL'];
  const out: Record<string, string> = {};
  for (const k of keep) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  return out;
}
