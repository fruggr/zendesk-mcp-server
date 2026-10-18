export interface AlertPollerOptions {
  intervalMs: number;
  /** The alert set's fingerprint for a subscribed URI (see `alertFingerprint`). */
  check: (uri: string) => Promise<string>;
  /** Tells the client the resource at `uri` changed. */
  notify: (uri: string) => Promise<void>;
  /** A failed check or notification; polling goes on. */
  onError?: (uri: string, error: unknown) => void;
}

export interface AlertPoller {
  subscribe: (uri: string) => void;
  unsubscribe: (uri: string) => void;
  /** Ends every subscription, as on session close. */
  stop: () => void;
  /** The URIs subscribed to, for tests and diagnostics. */
  subscriptions: () => string[];
  /** One polling round; the timer calls it, tests may too. */
  tick: () => Promise<void>;
}

/**
 * Polls the subscribed alert resources while there is at least one, and
 * notifies a URI only when its alert set changed: which tickets, metrics and
 * levels. The fingerprint at subscription time is the baseline, so the first
 * round never notifies on its own. The timer is unref'd and stops with the
 * last subscription.
 */
export const createAlertPoller = (options: AlertPollerOptions): AlertPoller => {
  const { intervalMs, check, notify, onError = () => undefined } = options;
  const fingerprints = new Map<string, string | undefined>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  const refresh = async (uri: string): Promise<void> => {
    try {
      const next = await check(uri);
      // Unsubscribed while the check ran: no previous fingerprint, so no notification.
      const previous = fingerprints.get(uri);
      if (previous !== undefined && previous !== next) await notify(uri);
      // Recorded once announced, so a failed notification is retried next round,
      // and only while still subscribed.
      if (fingerprints.has(uri)) fingerprints.set(uri, next);
    } catch (error) {
      onError(uri, error);
    }
  };

  const tick = async (): Promise<void> => {
    // A slow round must not overlap the next one.
    if (running) return;
    running = true;
    try {
      for (const uri of [...fingerprints.keys()]) await refresh(uri);
    } finally {
      running = false;
    }
  };

  const stopTimer = (): void => {
    clearInterval(timer);
    timer = undefined;
  };

  return {
    subscribe: (uri) => {
      if (fingerprints.has(uri)) return;
      fingerprints.set(uri, undefined);
      void refresh(uri);
      if (!timer) {
        timer = setInterval(() => void tick(), intervalMs);
        timer.unref();
      }
    },
    unsubscribe: (uri) => {
      fingerprints.delete(uri);
      if (fingerprints.size === 0) stopTimer();
    },
    stop: () => {
      fingerprints.clear();
      stopTimer();
    },
    subscriptions: () => [...fingerprints.keys()],
    tick,
  };
};
