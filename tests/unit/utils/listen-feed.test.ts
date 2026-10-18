import { describe, expect, it } from 'vitest';
import {
  createListenFeed,
  createListenWireObserver,
  type ListenFeed,
  listenedUris,
} from '../../../src/utils/listen-feed';

/** A feed with one attached sink recording `+uri` / `-uri`. */
const recorded = (feed: ListenFeed = createListenFeed()) => {
  const events: string[] = [];
  const detach = feed.attach({
    add: (uri) => events.push(`+${uri}`),
    remove: (uri) => events.push(`-${uri}`),
  });
  return { feed, events, detach };
};

describe('createListenFeed', () => {
  it('tells a sink when a URI gains its first listener and loses its last one', () => {
    const { feed, events } = recorded();
    feed.open('a', ['x', 'y']);
    feed.open('b', ['x']);
    expect(events).toEqual(['+x', '+y']);
    feed.close('a');
    expect(events).toEqual(['+x', '+y', '-y']);
    feed.close('b');
    expect(events).toEqual(['+x', '+y', '-y', '-x']);
  });

  it('counts a URI once per stream, however often the stream names it', () => {
    const { feed, events } = recorded();
    feed.open('a', ['x', 'x']);
    feed.open('b', ['x']);
    feed.close('b');
    expect(events).toEqual(['+x']);
    feed.close('a');
    expect(events).toEqual(['+x', '-x']);
  });

  it('ignores a key already open and a key never opened', () => {
    const { feed, events } = recorded();
    feed.open('a', ['x']);
    feed.open('a', ['y']);
    feed.close('nope');
    expect(events).toEqual(['+x']);
    feed.close('a');
    feed.close('a');
    expect(events).toEqual(['+x', '-x']);
  });

  it('replays the URIs listened to now to a sink attached late', () => {
    const feed = createListenFeed();
    feed.open('a', ['x', 'y']);
    feed.open('b', ['x']);
    expect(recorded(feed).events).toEqual(['+x', '+y']);
  });

  it('stops telling a detached sink, and keeps telling the others', () => {
    const first = recorded();
    const second = recorded(first.feed);
    first.detach();
    first.feed.open('a', ['x']);
    expect(first.events).toEqual([]);
    expect(second.events).toEqual(['+x']);
  });

  it('ends every stream on closeAll', () => {
    const { feed, events } = recorded();
    feed.open('a', ['x']);
    feed.open('b', ['y']);
    feed.closeAll();
    expect(events).toEqual(['+x', '+y', '-x', '-y']);
    feed.open('a', ['x']);
    expect(events).toEqual(['+x', '+y', '-x', '-y', '+x']);
  });
});

describe('createListenFeed with a throwing sink', () => {
  it('keeps its bookkeeping and the other sinks going, and never throws', () => {
    const feed = createListenFeed();
    feed.attach({
      add: () => {
        throw new Error('add');
      },
      remove: () => {
        throw new Error('remove');
      },
    });
    const { events } = recorded(feed);
    expect(() => feed.open('a', ['x', 'y'])).not.toThrow();
    expect(events).toEqual(['+x', '+y']);
    expect(() => feed.close('a')).not.toThrow();
    expect(events).toEqual(['+x', '+y', '-x', '-y']);
    feed.open('b', ['z']);
    expect(() => feed.closeAll()).not.toThrow();
    expect(events).toEqual(['+x', '+y', '-x', '-y', '+z', '-z']);
  });

  it('attaches a sink that throws on replay, and keeps telling it', () => {
    const feed = createListenFeed();
    feed.open('a', ['x', 'y']);
    const seen: string[] = [];
    expect(() =>
      feed.attach({
        add: (uri) => {
          seen.push(`+${uri}`);
          throw new Error('add');
        },
        remove: (uri) => seen.push(`-${uri}`),
      }),
    ).not.toThrow();
    feed.close('a');
    expect(seen).toEqual(['+x', '+y', '-x', '-y']);
  });
});

describe('listenedUris', () => {
  it('reads the resource URIs of a subscriptions/listen request', () => {
    expect(
      listenedUris({
        jsonrpc: '2.0',
        id: 1,
        method: 'subscriptions/listen',
        params: { notifications: { resourceSubscriptions: ['a', 7, 'b'] } },
      }),
    ).toEqual(['a', 'b']);
  });

  it('reads no URI from a listen request without resource subscriptions', () => {
    expect(listenedUris({ method: 'subscriptions/listen' })).toEqual([]);
    expect(listenedUris({ method: 'subscriptions/listen', params: 'x' })).toEqual([]);
    expect(
      listenedUris({ method: 'subscriptions/listen', params: { notifications: 'x' } }),
    ).toEqual([]);
    expect(
      listenedUris({
        method: 'subscriptions/listen',
        params: { notifications: { resourceSubscriptions: 'a' } },
      }),
    ).toEqual([]);
  });

  it('is undefined for anything but a listen request', () => {
    expect(listenedUris({ method: 'tools/call' })).toBeUndefined();
    expect(listenedUris(null)).toBeUndefined();
    expect(listenedUris('subscriptions/listen')).toBeUndefined();
  });
});

describe('createListenWireObserver', () => {
  const listen = (id: unknown, uris: string[]) => ({
    jsonrpc: '2.0',
    id,
    method: 'subscriptions/listen',
    params: { notifications: { resourceSubscriptions: uris } },
  });

  it('opens a stream on a listen request and ends it when the client cancels it', () => {
    const { feed, events } = recorded();
    const wire = createListenWireObserver(feed);
    wire.inbound(listen('l1', ['x']));
    expect(events).toEqual(['+x']);
    wire.inbound({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'l2' },
    });
    expect(events).toEqual(['+x']);
    wire.inbound({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'l1' },
    });
    expect(events).toEqual(['+x', '-x']);
  });

  it('ends a stream on any response carrying its id, refusal or closing result', () => {
    const { feed, events } = recorded();
    const wire = createListenWireObserver(feed);
    wire.inbound(listen('l1', ['x']));
    wire.inbound(listen('l2', ['y']));
    wire.outbound({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: {} });
    wire.outbound({ jsonrpc: '2.0', id: 'l3', result: {} });
    expect(events).toEqual(['+x', '+y']);
    wire.outbound({ jsonrpc: '2.0', id: 'l1', result: {} });
    wire.outbound({ jsonrpc: '2.0', id: 'l2', error: { code: -32602, message: 'no' } });
    expect(events).toEqual(['+x', '+y', '-x', '-y']);
  });

  it('ignores a listen notification, a cancellation without params, and non-objects', () => {
    const { feed, events } = recorded();
    const wire = createListenWireObserver(feed);
    wire.inbound({ jsonrpc: '2.0', method: 'subscriptions/listen', params: {} });
    wire.inbound(listen('l1', ['x']));
    wire.inbound({ jsonrpc: '2.0', method: 'notifications/cancelled' });
    wire.inbound({ jsonrpc: '2.0', method: 'tools/call', params: { requestId: 'l1' } });
    wire.inbound('l1');
    wire.inbound(null);
    wire.outbound('l1');
    wire.outbound(null);
    expect(events).toEqual(['+x']);
  });

  it('opens nothing for another request, so its id stays free for a listen', () => {
    const { feed, events } = recorded();
    const wire = createListenWireObserver(feed);
    wire.inbound({ jsonrpc: '2.0', id: 'l1', method: 'tools/call', params: {} });
    wire.inbound(listen('l1', ['x']));
    expect(events).toEqual(['+x']);
  });

  it('keeps a stream open across a server request that reuses its id', () => {
    const { feed, events } = recorded();
    const wire = createListenWireObserver(feed);
    wire.inbound(listen('l1', ['x']));
    wire.outbound({ jsonrpc: '2.0', id: 'l1', method: 'elicitation/create', params: {} });
    expect(events).toEqual(['+x']);
  });
});
