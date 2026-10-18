const MINUTES_PER_UNIT = { w: 10080, d: 1440, h: 60, m: 1 } as const;

// Units in strictly decreasing order, each at most once: `1d4h` reads, `4h1d`
// and `4h4h` do not, so one duration has one spelling.
const DURATION = /^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/;

/**
 * Reads a readable duration (`30m`, `4h`, `2d`, `1w`, `1d4h`) as whole minutes,
 * case-insensitive. `undefined` for anything else, including a bare number: a
 * unit-less `4` is ambiguous between minutes and hours.
 */
export const parseDuration = (raw: string): number | undefined => {
  const text = raw.trim().toLowerCase();
  const match = DURATION.exec(text);
  if (!match || text === '') return undefined;
  const [, w, d, h, m] = match;
  return (
    Number(w ?? 0) * MINUTES_PER_UNIT.w +
    Number(d ?? 0) * MINUTES_PER_UNIT.d +
    Number(h ?? 0) * MINUTES_PER_UNIT.h +
    Number(m ?? 0)
  );
};

/** Why `raw` was refused, with the spelling `parseDuration` reads. */
export const notADuration = (raw: string): string =>
  `"${raw}" is not a duration. Use a number and a unit: 30m, 4h, 2d, 1w, or a mix like 1d4h.`;

/**
 * Renders a span of minutes in the same spelling `parseDuration` reads, days
 * being the largest unit (`2d1h`, `45m`). The sign is dropped: callers say
 * "overdue" or "due" themselves.
 */
export const formatMinutes = (minutes: number): string => {
  let rest = Math.abs(Math.round(minutes));
  const parts: string[] = [];
  for (const [unit, size] of [
    ['d', MINUTES_PER_UNIT.d],
    ['h', MINUTES_PER_UNIT.h],
  ] as const) {
    if (rest >= size) {
      parts.push(`${Math.floor(rest / size)}${unit}`);
      rest %= size;
    }
  }
  if (rest > 0 || parts.length === 0) parts.push(`${rest}m`);
  return parts.join('');
};
