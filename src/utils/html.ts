/**
 * Escape a string for safe interpolation into HTML text/attribute context.
 * Both the stdio callback page and the HTTP consent page echo
 * attacker-controllable values (an OAuth `error_description`, a client name
 * from a fetched metadata document); without escaping these are an XSS sink.
 */
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
