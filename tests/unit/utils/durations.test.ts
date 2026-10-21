import { describe, expect, it } from 'vitest';
import { formatMinutes, notADuration, parseDuration } from '../../../src/utils/durations';

describe('parseDuration', () => {
  it.each([
    ['30m', 30],
    ['4h', 240],
    ['2d', 2880],
    ['1w', 10080],
    ['1h30m', 90],
    ['1d4h', 1680],
    ['  8H ', 480],
    ['0m', 0],
    ['10w', 100800],
    ['12d', 17280],
    ['24h', 1440],
    ['90m', 90],
  ])('reads %j as %i minutes', (raw, minutes) => {
    expect(parseDuration(raw)).toBe(minutes);
  });

  it.each(['', '4', 'h', '4x', '-1h', '1.5h', '4h 30m', '30m4h', '4h4h', 'h4'])(
    'rejects %j',
    (raw) => {
      expect(parseDuration(raw)).toBeUndefined();
    },
  );
});

describe('formatMinutes', () => {
  it.each([
    [0, '0m'],
    [45, '45m'],
    [60, '1h'],
    [90, '1h30m'],
    [1440, '1d'],
    [1500, '1d1h'],
    [2881, '2d1m'],
    [10080, '7d'],
  ])('renders %i minutes as %j', (minutes, text) => {
    expect(formatMinutes(minutes)).toBe(text);
  });

  it('renders a negative span by its magnitude', () => {
    expect(formatMinutes(-90)).toBe('1h30m');
  });

  it('round-trips through parseDuration', () => {
    for (const minutes of [0, 1, 59, 61, 1439, 1441, 4321]) {
      expect(parseDuration(formatMinutes(minutes))).toBe(minutes);
    }
  });
});

describe('notADuration', () => {
  it('names the text and the expected spelling', () => {
    expect(notADuration('soon')).toBe(
      '"soon" is not a duration. Use a number and a unit: 30m, 4h, 2d, 1w, or a mix like 1d4h.',
    );
  });
});
