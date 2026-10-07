import { describe, expect, it } from 'vitest';
import {
  daysUntil,
  dueLabel,
  formatClock,
  formatDuration,
  formatDayLabel,
  formatFullDate,
  formatPercent,
  formatRatio,
  formatTimeRange,
  formatTimestamp,
  initials,
  isPastDue,
  pluralise,
} from './format.js';

const TODAY = '2026-10-07';

describe('clinic clock formatting', () => {
  it('formats 24h clocks as 12h times', () => {
    expect(formatClock('09:00')).toBe('9:00 AM');
    expect(formatClock('00:30')).toBe('12:30 AM');
    expect(formatClock('12:00')).toBe('12:00 PM');
    expect(formatClock('23:05')).toBe('11:05 PM');
  });

  it('echoes unparseable clocks instead of dropping them', () => {
    expect(formatClock('lunchtime')).toBe('lunchtime');
    expect(formatClock('')).toBe('');
  });

  it('shares the meridiem inside a session range', () => {
    expect(formatTimeRange('09:00', '09:30')).toBe('9:00 – 9:30 AM');
    expect(formatTimeRange('11:30', '13:00')).toBe('11:30 AM – 1:00 PM');
    expect(formatTimeRange('', '13:00')).toBe('1:00 PM');
    expect(formatTimeRange('', '')).toBe('Time to be confirmed');
  });

  it('describes a visit duration', () => {
    expect(formatDuration('09:00', '09:30')).toBe('30 min');
    expect(formatDuration('09:00', '11:00')).toBe('2 hr');
    expect(formatDuration('09:00', '10:30')).toBe('1 hr 30 min');
    expect(formatDuration('09:30', '09:00')).toBe('');
  });
});

describe('calendar formatting', () => {
  it('uses relative labels for the days around today', () => {
    expect(formatDayLabel(TODAY, TODAY)).toBe('Today');
    expect(formatDayLabel('2026-10-08', TODAY)).toBe('Tomorrow');
    expect(formatDayLabel('2026-10-06', TODAY)).toBe('Yesterday');
    expect(formatDayLabel('2026-10-12', TODAY)).toBe('Mon, Oct 12');
    expect(formatDayLabel('', TODAY)).toBe('No date');
  });

  it('writes out the full date', () => {
    expect(formatFullDate(TODAY)).toBe('Wednesday, October 7, 2026');
    expect(formatFullDate('not-a-date')).toBe('not-a-date');
  });

  it('counts days and describes due dates', () => {
    expect(daysUntil('2026-10-10', TODAY)).toBe(3);
    expect(daysUntil('2026-10-04', TODAY)).toBe(-3);
    expect(daysUntil('', TODAY)).toBe(0);
    expect(dueLabel('2026-10-04', TODAY)).toBe('3 days overdue');
    expect(dueLabel('2026-10-06', TODAY)).toBe('1 day overdue');
    expect(dueLabel(TODAY, TODAY)).toBe('Due today');
    expect(dueLabel('2026-10-08', TODAY)).toBe('Due tomorrow');
    expect(dueLabel('2026-10-12', TODAY)).toBe('Due in 5 days');
    expect(dueLabel('', TODAY)).toBe('No due date');
  });

  it('compares calendar days for overdue work', () => {
    expect(isPastDue('2026-10-06', TODAY)).toBe(true);
    expect(isPastDue(TODAY, TODAY)).toBe(false);
    expect(isPastDue('', TODAY)).toBe(false);
  });
});

describe('number formatting', () => {
  it('formats percentages without trailing zeros', () => {
    expect(formatPercent(82)).toBe('82%');
    expect(formatPercent(66.7)).toBe('66.7%');
    expect(formatPercent(0)).toBe('0%');
  });

  it('pluralises counts and shows capacity ratios', () => {
    expect(pluralise(1, 'client')).toBe('1 client');
    expect(pluralise(0, 'client')).toBe('0 clients');
    expect(pluralise(2, 'visit')).toBe('2 visits');
    expect(formatRatio(3, 8)).toBe('3 / 8');
    expect(formatRatio(3, 0)).toBe('3');
  });

  it('builds initials for the roster avatars', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('Ada')).toBe('A');
    expect(initials('')).toBe('?');
  });

  it('formats activity timestamps or falls back to the calendar day', () => {
    expect(formatTimestamp('')).toBe('');
    // The stamp is rendered in the coordinator's own timezone, so only the year is asserted.
    expect(formatTimestamp('2026-10-01T14:30:00Z')).toMatch(/2026/);
    expect(formatTimestamp('not-a-date')).toBe('not-a-date');
  });
});
