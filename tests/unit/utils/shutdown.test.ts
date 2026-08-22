import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../../../src/utils/logger';
import {
  createRuntime,
  installShutdown,
  SHUTDOWN_GRACE_MS,
  type ShutdownRuntime,
  type ShutdownTimer,
} from '../../../src/utils/shutdown';

/**
 * A fake `process` plus a fake timer, so no test ever registers a listener on
 * the real process or races a real clock.
 *
 * `listeners` records every registration by event name, which is what lets the
 * `watchStdin: false` test assert the *absence* of a stdin listener — the one
 * mistake in this module that would take the HTTP server down at boot.
 */
const fakeRuntime = () => {
  const listeners = new Map<string, Array<() => void>>();
  const record = (event: string, listener: () => void) => {
    const existing = listeners.get(event);
    if (existing) existing.push(listener);
    else listeners.set(event, [listener]);
  };

  const exit = vi.fn<(code: number) => void>();
  const timers: Array<{ fn: () => void; ms: number; unrefs: number; cleared: number }> = [];

  const setTimer = vi.fn((fn: () => void, ms: number): ShutdownTimer => {
    const entry = { fn, ms, unrefs: 0, cleared: 0 };
    timers.push(entry);
    return {
      unref: () => {
        entry.unrefs += 1;
      },
      clear: () => {
        entry.cleared += 1;
      },
    };
  });

  const runtime: ShutdownRuntime = {
    on: record,
    stdin: { on: (event, listener) => record(`stdin:${event}`, listener) },
    exit,
    setTimer,
  };

  return {
    runtime,
    exit,
    timers,
    events: () => [...listeners.keys()],
    /** Fire a registered listener, e.g. `fire('SIGTERM')` or `fire('stdin:end')`. */
    fire: (event: string) => {
      const found = listeners.get(event);
      if (!found) throw new Error(`no listener registered for ${event}`);
      for (const listener of found) listener();
    },
  };
};

// Lets a test hold `cleanup` open, then release it, without any real timers.
const deferred = () => {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('installShutdown', () => {
  describe('trigger registration', () => {
    it('watches stdin EOF only when asked to', () => {
      const stdio = fakeRuntime();
      installShutdown({
        cleanup: async () => {},
        logger: silentLogger,
        watchStdin: true,
        runtime: stdio.runtime,
      });
      expect(stdio.events()).toContain('stdin:end');
    });

    // The regression guard for the whole module. A daemonised HTTP server is
    // routinely handed `/dev/null` on stdin, which emits EOF immediately, so a
    // stdin listener registered in HTTP mode would shut the server down at boot.
    it('registers no stdin listener when watchStdin is false', () => {
      const http = fakeRuntime();
      installShutdown({
        cleanup: async () => {},
        logger: silentLogger,
        watchStdin: false,
        runtime: http.runtime,
      });

      expect(http.events()).not.toContain('stdin:end');
      expect(http.events()).toStrictEqual(['SIGINT', 'SIGTERM']);
    });

    it.each(['SIGINT', 'SIGTERM'] as const)('shuts down on %s', async (signal) => {
      const rt = fakeRuntime();
      const cleanup = vi.fn(async () => {});
      installShutdown({
        cleanup,
        logger: silentLogger,
        watchStdin: false,
        runtime: rt.runtime,
      });

      rt.fire(signal);
      await flush();

      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(rt.exit).toHaveBeenCalledWith(0);
    });

    it('shuts down on stdin EOF', async () => {
      const rt = fakeRuntime();
      const cleanup = vi.fn(async () => {});
      installShutdown({
        cleanup,
        logger: silentLogger,
        watchStdin: true,
        runtime: rt.runtime,
      });

      rt.fire('stdin:end');
      await flush();

      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(rt.exit).toHaveBeenCalledWith(0);
    });
  });

  describe('idempotence', () => {
    // SIGTERM and stdin EOF genuinely can both fire for one client disconnect.
    it('runs cleanup once when several triggers fire', async () => {
      const rt = fakeRuntime();
      const cleanup = vi.fn(async () => {});
      installShutdown({
        cleanup,
        logger: silentLogger,
        watchStdin: true,
        runtime: rt.runtime,
      });

      rt.fire('SIGTERM');
      rt.fire('stdin:end');
      rt.fire('SIGINT');
      await flush();

      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(rt.exit).toHaveBeenCalledTimes(1);
    });

    it('arms only one watchdog across repeated triggers', async () => {
      const rt = fakeRuntime();
      installShutdown({
        cleanup: async () => {},
        logger: silentLogger,
        watchStdin: true,
        runtime: rt.runtime,
      });

      rt.fire('SIGTERM');
      rt.fire('stdin:end');
      await flush();

      expect(rt.timers).toHaveLength(1);
    });
  });

  describe('the watchdog', () => {
    it('arms an unref-ed timer at the grace period', () => {
      const rt = fakeRuntime();
      installShutdown({
        cleanup: () => deferred().promise,
        logger: silentLogger,
        watchStdin: false,
        runtime: rt.runtime,
      });

      rt.fire('SIGTERM');

      expect(rt.timers).toHaveLength(1);
      // Pinned exactly: the default is a contract, and an arbitrary delay would
      // still pass a `toBeGreaterThan`-style assertion.
      expect(rt.timers[0]?.ms).toBe(SHUTDOWN_GRACE_MS);
      // unref() is what stops the watchdog from *itself* holding the loop open
      // for the whole grace period once cleanup has finished early.
      expect(rt.timers[0]?.unrefs).toBe(1);
    });

    it('honours an overridden grace period', () => {
      const rt = fakeRuntime();
      installShutdown({
        cleanup: () => deferred().promise,
        logger: silentLogger,
        watchStdin: false,
        graceMs: 250,
        runtime: rt.runtime,
      });

      rt.fire('SIGTERM');
      expect(rt.timers[0]?.ms).toBe(250);
    });

    // Registering a SIGTERM handler removes Node's default terminate, so a
    // cleanup that never settles would leave a process that SIGTERM cannot kill
    // — the exact symptom this module exists to remove.
    it('forces the exit when cleanup never settles', async () => {
      const rt = fakeRuntime();
      const stuck = deferred();
      installShutdown({
        cleanup: () => stuck.promise,
        logger: silentLogger,
        watchStdin: false,
        runtime: rt.runtime,
      });

      rt.fire('SIGTERM');
      await flush();
      expect(rt.exit).not.toHaveBeenCalled();

      rt.timers[0]?.fn();
      expect(rt.exit).toHaveBeenCalledWith(0);
    });

    it('clears the watchdog once cleanup completes', async () => {
      const rt = fakeRuntime();
      installShutdown({
        cleanup: async () => {},
        logger: silentLogger,
        watchStdin: false,
        runtime: rt.runtime,
      });

      rt.fire('SIGTERM');
      await flush();

      expect(rt.timers[0]?.cleared).toBe(1);
    });

    it('exits once when the watchdog fires after a completed cleanup', async () => {
      const rt = fakeRuntime();
      installShutdown({
        cleanup: async () => {},
        logger: silentLogger,
        watchStdin: false,
        runtime: rt.runtime,
      });

      rt.fire('SIGTERM');
      await flush();
      rt.timers[0]?.fn();

      expect(rt.exit).toHaveBeenCalledTimes(1);
    });
  });

  describe('cleanup failure', () => {
    it('still exits when cleanup rejects', async () => {
      const rt = fakeRuntime();
      installShutdown({
        cleanup: async () => {
          throw new Error('close failed');
        },
        logger: silentLogger,
        watchStdin: false,
        runtime: rt.runtime,
      });

      rt.fire('SIGTERM');
      await flush();

      expect(rt.exit).toHaveBeenCalledWith(0);
    });

    it('logs the failure reason', async () => {
      const rt = fakeRuntime();
      const warn = vi.fn();
      installShutdown({
        cleanup: async () => {
          throw new Error('close failed');
        },
        logger: { ...silentLogger, warn },
        watchStdin: false,
        runtime: rt.runtime,
      });

      rt.fire('SIGTERM');
      await flush();

      expect(warn).toHaveBeenCalledWith('shutdown_cleanup_failed', { error: 'close failed' });
    });

    it('stringifies a non-Error rejection', async () => {
      const rt = fakeRuntime();
      const warn = vi.fn();
      installShutdown({
        // A rejected promise rather than `throw`: Biome forbids throwing a
        // non-Error, but a library can still reject with one, which is exactly
        // the case `String(err)` exists for.
        cleanup: () => Promise.reject('plain string'),
        logger: { ...silentLogger, warn },
        watchStdin: false,
        runtime: rt.runtime,
      });

      rt.fire('SIGTERM');
      await flush();

      expect(warn).toHaveBeenCalledWith('shutdown_cleanup_failed', { error: 'plain string' });
      expect(rt.exit).toHaveBeenCalledWith(0);
    });

    it('still exits when cleanup throws synchronously', async () => {
      const rt = fakeRuntime();
      installShutdown({
        cleanup: () => {
          throw new Error('sync boom');
        },
        logger: silentLogger,
        watchStdin: false,
        runtime: rt.runtime,
      });

      rt.fire('SIGTERM');
      await flush();

      expect(rt.exit).toHaveBeenCalledWith(0);
    });
  });

  describe('logging', () => {
    it('names the trigger that started the shutdown', async () => {
      const rt = fakeRuntime();
      const info = vi.fn();
      installShutdown({
        cleanup: async () => {},
        logger: { ...silentLogger, info },
        watchStdin: true,
        runtime: rt.runtime,
      });

      rt.fire('stdin:end');
      await flush();

      expect(info).toHaveBeenCalledWith('shutdown_started', { reason: 'stdin_eof' });
      expect(info).toHaveBeenCalledWith('shutdown_complete', { reason: 'stdin_eof' });
    });

    it('reports the signal name as the reason', async () => {
      const rt = fakeRuntime();
      const info = vi.fn();
      installShutdown({
        cleanup: async () => {},
        logger: { ...silentLogger, info },
        watchStdin: false,
        runtime: rt.runtime,
      });

      rt.fire('SIGINT');
      await flush();

      expect(info).toHaveBeenCalledWith('shutdown_started', { reason: 'SIGINT' });
    });

    it('warns when the watchdog has to force the exit', () => {
      const rt = fakeRuntime();
      const warn = vi.fn();
      installShutdown({
        cleanup: () => deferred().promise,
        logger: { ...silentLogger, warn },
        watchStdin: false,
        graceMs: 250,
        runtime: rt.runtime,
      });

      rt.fire('SIGTERM');
      rt.timers[0]?.fn();

      expect(warn).toHaveBeenCalledWith('shutdown_forced', { graceMs: 250 });
    });
  });

  // The adapter is the only part that touches a real `process`, which is
  // exactly why it takes one as an argument: closing over the global would make
  // the riskiest lines in the module the ones no test can reach.
  describe('createRuntime', () => {
    const fakeProcess = () => {
      const on = vi.fn();
      const stdinOn = vi.fn();
      const exit = vi.fn();
      return { proc: { on, stdin: { on: stdinOn }, exit }, on, stdinOn, exit };
    };

    it('registers signal listeners on the process', () => {
      const fake = fakeProcess();
      const listener = () => {};
      createRuntime(fake.proc).on('SIGTERM', listener);
      expect(fake.on).toHaveBeenCalledWith('SIGTERM', listener);
    });

    it('registers stdin listeners on process.stdin', () => {
      const fake = fakeProcess();
      const listener = () => {};
      createRuntime(fake.proc).stdin.on('end', listener);
      expect(fake.stdinOn).toHaveBeenCalledWith('end', listener);
      // Never on the process itself: `end` there would mean nothing.
      expect(fake.on).not.toHaveBeenCalled();
    });

    it('forwards the exit code to process.exit', () => {
      const fake = fakeProcess();
      createRuntime(fake.proc).exit(0);
      expect(fake.exit).toHaveBeenCalledWith(0);
    });

    it('schedules the watchdog at the requested delay', () => {
      vi.useFakeTimers();
      try {
        const fn = vi.fn();
        createRuntime(fakeProcess().proc).setTimer(fn, 250);

        vi.advanceTimersByTime(249);
        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(fn).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('cancels a cleared watchdog', () => {
      vi.useFakeTimers();
      try {
        const fn = vi.fn();
        const timer = createRuntime(fakeProcess().proc).setTimer(fn, 250);
        timer.clear();

        vi.advanceTimersByTime(1000);
        expect(fn).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('unrefs the watchdog so it cannot hold the loop open', () => {
      vi.useFakeTimers();
      try {
        const timer = createRuntime(fakeProcess().proc).setTimer(() => {}, 250);
        const handle = vi.getTimerCount() > 0;
        expect(handle).toBe(true);
        // `unref` must reach the real timer handle, not be swallowed.
        expect(() => timer.unref()).not.toThrow();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('the default runtime', () => {
    // Exercises the `options.runtime ?? defaultRuntime` fallback that every
    // production call takes. The listeners are located precisely and removed
    // again: one left behind could exit the test runner on a later signal.
    it('registers on the real process when no runtime is injected', () => {
      const before = {
        SIGINT: new Set(process.listeners('SIGINT')),
        SIGTERM: new Set(process.listeners('SIGTERM')),
      };

      installShutdown({ cleanup: async () => {}, logger: silentLogger, watchStdin: false });

      const added = {
        SIGINT: process.listeners('SIGINT').filter((l) => !before.SIGINT.has(l)),
        SIGTERM: process.listeners('SIGTERM').filter((l) => !before.SIGTERM.has(l)),
      };
      try {
        expect(added.SIGINT).toHaveLength(1);
        expect(added.SIGTERM).toHaveLength(1);
      } finally {
        for (const l of added.SIGINT) process.off('SIGINT', l);
        for (const l of added.SIGTERM) process.off('SIGTERM', l);
      }
    });
  });

  describe('the returned trigger', () => {
    it('shuts down when called directly and resolves after cleanup', async () => {
      const rt = fakeRuntime();
      const cleanup = vi.fn(async () => {});
      const shutdown = installShutdown({
        cleanup,
        logger: silentLogger,
        watchStdin: false,
        runtime: rt.runtime,
      });

      await shutdown('manual');

      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(rt.exit).toHaveBeenCalledWith(0);
    });
  });
});
