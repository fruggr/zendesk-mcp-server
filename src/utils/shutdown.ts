import type { Logger } from './logger';

/**
 * How long a shutdown may take before the watchdog forces the exit.
 *
 * Generous enough for `server.close()` and an HTTP session drain, short enough
 * that a supervisor's own SIGTERM→SIGKILL grace (10s under systemd and Docker)
 * never expires first — a process killed by the supervisor is exactly the
 * unclean exit this module removes.
 */
export const SHUTDOWN_GRACE_MS = 3000;

/** A timer the shutdown owns: armed once, kept off the loop, cancelled on success. */
export interface ShutdownTimer {
  unref: () => void;
  clear: () => void;
}

/**
 * The slice of `process` this module touches, injected so tests never register
 * a listener on the real process or race a real clock.
 */
export interface ShutdownRuntime {
  on: (event: 'SIGINT' | 'SIGTERM', listener: () => void) => void;
  stdin: { on: (event: 'end', listener: () => void) => void };
  exit: (code: number) => void;
  setTimer: (fn: () => void, ms: number) => ShutdownTimer;
}

export interface ShutdownOptions {
  /** Releases what the transport holds: the MCP server, the token store, HTTP sessions. */
  cleanup: () => Promise<void> | void;
  logger: Logger;
  /**
   * Watch stdin for EOF. **stdio transport only.**
   *
   * Behind `npx`, the `npm exec` / `sh -c` chain does not relay signals, so EOF
   * on stdin is the only sign the client is gone. But a daemonised HTTP server
   * is routinely handed `/dev/null` on stdin, which reaches EOF immediately —
   * watching it there would shut the server down at boot.
   */
  watchStdin: boolean;
  graceMs?: number;
  runtime?: ShutdownRuntime;
}

/** The process API `createRuntime` adapts — narrowed to what is actually used. */
export interface ProcessLike {
  on: (event: string, listener: () => void) => unknown;
  stdin: { on: (event: string, listener: () => void) => unknown };
  exit: (code: number) => unknown;
}

/**
 * Adapt a `process` to a {@link ShutdownRuntime}. Takes the process as an
 * argument rather than closing over the global so the adapter itself is
 * testable — otherwise the one part of this module that touches the real
 * process would be the one part no test can reach.
 */
export const createRuntime = (proc: ProcessLike): ShutdownRuntime => ({
  on: (event, listener) => {
    proc.on(event, listener);
  },
  stdin: {
    on: (event, listener) => {
      proc.stdin.on(event, listener);
    },
  },
  exit: (code) => {
    proc.exit(code);
  },
  setTimer: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return { unref: () => void timer.unref(), clear: () => clearTimeout(timer) };
  },
});

const defaultRuntime: ShutdownRuntime = createRuntime(process);

/**
 * Install the process's one shutdown path and return its trigger.
 *
 * Registering a `SIGTERM` handler *removes* Node's default terminate, which
 * makes the exit our responsibility: a cleanup that stalls on an in-flight
 * request would otherwise leave a process SIGTERM cannot kill — the very
 * symptom this exists to remove. Hence the watchdog, which is load-bearing
 * rather than defensive, and the unconditional `exit` on every path.
 *
 * The exit is explicit rather than a drained event loop because the OAuth
 * callback server (`auth/browser-oauth.ts`) is a listening socket that is not
 * `unref()`'d: letting the loop drain would keep a disconnected session alive
 * for up to the 5-minute auth timeout.
 */
export const installShutdown = (options: ShutdownOptions): ((reason: string) => Promise<void>) => {
  const { cleanup, logger, watchStdin, graceMs = SHUTDOWN_GRACE_MS } = options;
  const runtime = options.runtime ?? defaultRuntime;

  // SIGTERM and stdin EOF genuinely both fire for a single client disconnect.
  let started = false;
  let exited = false;

  const exitOnce = (code: number): void => {
    if (exited) return;
    exited = true;
    runtime.exit(code);
  };

  const shutdown = async (reason: string): Promise<void> => {
    if (started) return;
    started = true;
    logger.info('shutdown_started', { reason });

    // Armed before cleanup so a cleanup that hangs is still bounded, and
    // unref'd so it never keeps the process alive for the full grace period
    // once cleanup has already finished.
    const watchdog = runtime.setTimer(() => {
      logger.warn('shutdown_forced', { graceMs });
      exitOnce(0);
    }, graceMs);
    watchdog.unref();

    try {
      await cleanup();
      logger.info('shutdown_complete', { reason });
    } catch (err) {
      logger.warn('shutdown_cleanup_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      watchdog.clear();
      exitOnce(0);
    }
  };

  runtime.on('SIGINT', () => void shutdown('SIGINT'));
  runtime.on('SIGTERM', () => void shutdown('SIGTERM'));
  if (watchStdin) runtime.stdin.on('end', () => void shutdown('stdin_eof'));

  return shutdown;
};
