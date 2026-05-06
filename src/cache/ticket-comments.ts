import type { ZendeskComment } from '../types';

const TTL_MS = 5 * 60 * 1000;

const cache = new Map<number, { comments: ZendeskComment[]; expiresAt: number }>();

export const getCachedTicketCommentsEntry = (ticketId: number): ZendeskComment[] | null => {
  const entry = cache.get(ticketId);
  if (!entry || entry.expiresAt <= Date.now()) {
    cache.delete(ticketId);
    return null;
  }
  return entry.comments;
};

export const setCachedTicketCommentsEntry = (
  ticketId: number,
  comments: ZendeskComment[],
): void => {
  cache.set(ticketId, { comments, expiresAt: Date.now() + TTL_MS });
};

export const clearTicketCommentsCache = (): void => {
  cache.clear();
};
