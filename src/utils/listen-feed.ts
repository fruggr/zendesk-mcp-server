/** Told when a resource URI gains its first listener or loses its last one. */
export interface ListenSink {
  add: (uri: string) => void;
  remove: (uri: string) => void;
}

/**
 * The resource URIs a 2026-07-28 client listens to on one connection or grant.
 * The SDK serves `subscriptions/listen` itself and keeps the filter to itself
 * (docs/decisions/protocol-eras.md), so the transport reads it off the wire and
 * reports each stream here; a poller attaches as a sink.
 */
export interface ListenFeed {
  /** A listen stream opened, keyed by anything unique to it; a key already open is ignored. */
  open: (key: unknown, uris: readonly string[]) => void;
  /** A listen stream ended; an unknown key is ignored. */
  close: (key: unknown) => void;
  /** Every stream ended, as when the connection or grant closes. */
  closeAll: () => void;
  /** Tells `sink` the URIs listened to now, then every change. Returns the detach. */
  attach: (sink: ListenSink) => () => void;
}

// A sink runs inside the transport's message path: its failure must neither
// lose the feed's bookkeeping nor reach the transport.
const tell = (sink: ListenSink, change: 'add' | 'remove', uri: string): void => {
  try {
    sink[change](uri);
  } catch {
    // The sink owns its errors.
  }
};

export const createListenFeed = (): ListenFeed => {
  const streams = new Map<unknown, readonly string[]>();
  const listeners = new Map<string, number>();
  const sinks = new Set<ListenSink>();

  const close = (key: unknown): void => {
    const uris = streams.get(key);
    if (!uris) return;
    streams.delete(key);
    for (const uri of uris) {
      const count = (listeners.get(uri) ?? 0) - 1;
      if (count > 0) {
        listeners.set(uri, count);
        continue;
      }
      listeners.delete(uri);
      for (const sink of sinks) tell(sink, 'remove', uri);
    }
  };

  return {
    open: (key, uris) => {
      if (streams.has(key)) return;
      const unique = [...new Set(uris)];
      streams.set(key, unique);
      for (const uri of unique) {
        const count = (listeners.get(uri) ?? 0) + 1;
        listeners.set(uri, count);
        if (count === 1) for (const sink of sinks) tell(sink, 'add', uri);
      }
    },
    close,
    closeAll: () => {
      for (const key of [...streams.keys()]) close(key);
    },
    attach: (sink) => {
      sinks.add(sink);
      for (const uri of listeners.keys()) tell(sink, 'add', uri);
      return () => {
        sinks.delete(sink);
      };
    },
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * The resource URIs a `subscriptions/listen` request asks for, or `undefined`
 * when `message` is not one. A malformed filter reads as no URI: the SDK
 * refuses that request anyway.
 */
export const listenedUris = (message: unknown): string[] | undefined => {
  if (!isRecord(message) || message['method'] !== 'subscriptions/listen') return undefined;
  const params = isRecord(message['params']) ? message['params'] : {};
  const filter = isRecord(params['notifications']) ? params['notifications'] : {};
  const uris = filter['resourceSubscriptions'];
  return Array.isArray(uris) ? uris.filter((uri): uri is string => typeof uri === 'string') : [];
};

/**
 * Feeds `feed` from a JSON-RPC connection's traffic: a listen request opens a
 * stream under its id; the client cancelling it, or any response carrying that
 * id (the SDK's refusal or its closing result), ends it.
 */
export const createListenWireObserver = (feed: ListenFeed) => ({
  inbound: (message: unknown): void => {
    if (!isRecord(message)) return;
    const uris = listenedUris(message);
    if (uris && 'id' in message) {
      feed.open(message['id'], uris);
      return;
    }
    if (message['method'] === 'notifications/cancelled' && isRecord(message['params'])) {
      feed.close(message['params']['requestId']);
    }
  },
  outbound: (message: unknown): void => {
    if (isRecord(message) && !('method' in message) && 'id' in message) feed.close(message['id']);
  },
});
