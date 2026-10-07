import { describe, expect, it } from 'vitest';
import {
  APPOINTMENT_STATUSES,
  FOLLOW_UP_STATUSES,
  StoreError,
  assertAppointmentWindow,
  countAvailableCapacity,
  countBookedCapacity,
  isSessionFull,
  isValidAppointmentTransition,
  isValidFollowUpTransition,
  isStoreError,
  timesOverlap,
  type AppointmentStatus,
  type FollowUpStatus,
} from '../../src/server/domain.js';

const ALL_APPOINTMENT_STATUSES = APPOINTMENT_STATUSES;
const ALL_FOLLOW_UP_STATUSES = FOLLOW_UP_STATUSES;

/** The complete appointment transition table, written out independently of the implementation. */
const APPOINTMENT_ALLOWED: ReadonlySet<string> = new Set([
  'requested->confirmed',
  'requested->cancelled',
  'confirmed->checked_in',
  'confirmed->no_show',
  'confirmed->cancelled',
  'checked_in->completed',
  'checked_in->no_show',
]);

const FOLLOW_UP_ALLOWED: ReadonlySet<string> = new Set([
  'open->in_progress',
  'open->dismissed',
  'in_progress->open',
  'in_progress->done',
  'in_progress->dismissed',
]);

function captureStoreError(run: () => unknown): StoreError {
  try {
    run();
  } catch (error) {
    expect(isStoreError(error)).toBe(true);
    return error as StoreError;
  }
  throw new Error('Expected the call to throw a StoreError');
}

describe('appointment transition rules', () => {
  it('matches the complete allowed transition table', () => {
    for (const from of ALL_APPOINTMENT_STATUSES) {
      for (const to of ALL_APPOINTMENT_STATUSES) {
        const expected = APPOINTMENT_ALLOWED.has(`${from}->${to}`);
        expect(isValidAppointmentTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it('allows the happy path from requested to completed', () => {
    expect(isValidAppointmentTransition('requested', 'confirmed')).toBe(true);
    expect(isValidAppointmentTransition('confirmed', 'checked_in')).toBe(true);
    expect(isValidAppointmentTransition('checked_in', 'completed')).toBe(true);
  });

  it('allows cancellations from requested, confirmed and checked-in but not from terminal states', () => {
    expect(isValidAppointmentTransition('requested', 'cancelled')).toBe(true);
    expect(isValidAppointmentTransition('confirmed', 'cancelled')).toBe(true);
    expect(isValidAppointmentTransition('checked_in', 'cancelled')).toBe(false);
    expect(isValidAppointmentTransition('completed', 'cancelled')).toBe(false);
    expect(isValidAppointmentTransition('no_show', 'cancelled')).toBe(false);
    expect(isValidAppointmentTransition('cancelled', 'cancelled')).toBe(false);
  });

  it('rejects skipping states and moving backwards', () => {
    expect(isValidAppointmentTransition('requested', 'completed')).toBe(false);
    expect(isValidAppointmentTransition('requested', 'checked_in')).toBe(false);
    expect(isValidAppointmentTransition('requested', 'no_show')).toBe(false);
    expect(isValidAppointmentTransition('confirmed', 'requested')).toBe(false);
    expect(isValidAppointmentTransition('checked_in', 'confirmed')).toBe(false);
  });

  it('treats completed, no_show and cancelled as terminal', () => {
    for (const status of ['completed', 'no_show', 'cancelled'] as const) {
      for (const target of ALL_APPOINTMENT_STATUSES) {
        expect(isValidAppointmentTransition(status, target), `${status} -> ${target}`).toBe(false);
      }
    }
  });

  it('supports a no-show path from confirmed or checked-in', () => {
    expect(isValidAppointmentTransition('confirmed', 'no_show')).toBe(true);
    expect(isValidAppointmentTransition('checked_in', 'no_show')).toBe(true);
    expect(isValidAppointmentTransition('requested', 'no_show')).toBe(false);
  });
});

describe('follow-up transition rules', () => {
  it('matches the complete allowed transition table', () => {
    for (const from of ALL_FOLLOW_UP_STATUSES) {
      for (const to of ALL_FOLLOW_UP_STATUSES) {
        const expected = FOLLOW_UP_ALLOWED.has(`${from}->${to}`);
        expect(isValidFollowUpTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it('allows starting, pausing and closing work', () => {
    expect(isValidFollowUpTransition('open', 'in_progress')).toBe(true);
    expect(isValidFollowUpTransition('in_progress', 'done')).toBe(true);
    expect(isValidFollowUpTransition('in_progress', 'open')).toBe(true);
    expect(isValidFollowUpTransition('open', 'dismissed')).toBe(true);
    expect(isValidFollowUpTransition('in_progress', 'dismissed')).toBe(true);
  });

  it('rejects skipping straight from open to done and reopening closed work', () => {
    expect(isValidFollowUpTransition('open', 'done')).toBe(false);
    expect(isValidFollowUpTransition('done', 'open')).toBe(false);
    expect(isValidFollowUpTransition('done', 'in_progress')).toBe(false);
    expect(isValidFollowUpTransition('dismissed', 'open')).toBe(false);
    expect(isValidFollowUpTransition('dismissed', 'done')).toBe(false);
  });

  it('treats done and dismissed as terminal', () => {
    for (const status of ['done', 'dismissed'] as const) {
      for (const target of ALL_FOLLOW_UP_STATUSES) {
        expect(isValidFollowUpTransition(status, target), `${status} -> ${target}`).toBe(false);
      }
    }
  });
});

describe('time overlap', () => {
  it('detects genuine overlaps', () => {
    expect(timesOverlap('09:00', '10:00', '09:30', '10:30')).toBe(true);
    expect(timesOverlap('09:30', '10:30', '09:00', '10:00')).toBe(true);
    expect(timesOverlap('09:00', '12:00', '10:00', '11:00')).toBe(true);
    expect(timesOverlap('10:00', '11:00', '09:00', '12:00')).toBe(true);
    expect(timesOverlap('09:00', '10:00', '09:00', '10:00')).toBe(true);
  });

  it('treats touching endpoints as free', () => {
    expect(timesOverlap('09:00', '10:00', '10:00', '11:00')).toBe(false);
    expect(timesOverlap('10:00', '11:00', '09:00', '10:00')).toBe(false);
    expect(timesOverlap('09:00', '09:30', '09:30', '10:00')).toBe(false);
  });

  it('treats disjoint windows as free', () => {
    expect(timesOverlap('09:00', '09:30', '11:00', '11:30')).toBe(false);
    expect(timesOverlap('14:00', '15:00', '09:00', '10:00')).toBe(false);
  });

  it('never conflicts with a zero-length or inverted window', () => {
    expect(timesOverlap('10:00', '10:00', '09:00', '11:00')).toBe(false);
    expect(timesOverlap('10:30', '10:00', '10:00', '10:30')).toBe(false);
  });
});

describe('assertAppointmentWindow', () => {
  const session = { date: '2026-10-07', startTime: '09:00', endTime: '17:00' };

  it('accepts a window inside the session hours', () => {
    expect(() =>
      assertAppointmentWindow({ startTime: '09:30', endTime: '10:00' }, session),
    ).not.toThrow();
    expect(() =>
      assertAppointmentWindow(
        { date: '2026-10-07', startTime: '09:30', endTime: '10:00' },
        session,
      ),
    ).not.toThrow();
  });

  it('accepts windows that exactly touch the session boundaries', () => {
    expect(() =>
      assertAppointmentWindow({ startTime: '09:00', endTime: '09:30' }, session),
    ).not.toThrow();
    expect(() =>
      assertAppointmentWindow({ startTime: '16:30', endTime: '17:00' }, session),
    ).not.toThrow();
    expect(() =>
      assertAppointmentWindow({ startTime: '09:00', endTime: '17:00' }, session),
    ).not.toThrow();
  });

  it('rejects an end time before or equal to the start time', () => {
    const backwards = captureStoreError(() =>
      assertAppointmentWindow({ startTime: '11:00', endTime: '10:30' }, session),
    );
    expect(backwards.code).toBe('VALIDATION');
    expect(backwards.message).toMatch(/after the start/i);

    const zeroLength = captureStoreError(() =>
      assertAppointmentWindow({ startTime: '11:00', endTime: '11:00' }, session),
    );
    expect(zeroLength.code).toBe('VALIDATION');
    expect(zeroLength.message).toMatch(/after the start/i);
  });

  it('rejects windows that leave the session hours', () => {
    const late = captureStoreError(() =>
      assertAppointmentWindow({ startTime: '16:30', endTime: '17:30' }, session),
    );
    expect(late.code).toBe('VALIDATION');
    expect(late.message).toMatch(/outside the session hours/i);

    const early = captureStoreError(() =>
      assertAppointmentWindow({ startTime: '08:30', endTime: '09:15' }, session),
    );
    expect(early.code).toBe('VALIDATION');
    expect(early.message).toMatch(/outside the session hours/i);
  });

  it('rejects a date that does not match the session date', () => {
    const mismatch = captureStoreError(() =>
      assertAppointmentWindow(
        { date: '2026-10-08', startTime: '09:30', endTime: '10:00' },
        session,
      ),
    );
    expect(mismatch.code).toBe('VALIDATION');
    expect(mismatch.message).toMatch(/does not match the session date/i);
  });

  it('normalises H:MM input but rejects malformed times and dates', () => {
    expect(() =>
      assertAppointmentWindow({ startTime: '9:00', endTime: '10:00' }, session),
    ).not.toThrow();
    expect(() =>
      assertAppointmentWindow({ startTime: 'ab:cd', endTime: '10:00' }, session),
    ).toThrow(StoreError);
    expect(() =>
      assertAppointmentWindow({ startTime: '09:00', endTime: '25:00' }, session),
    ).toThrow(StoreError);
    expect(() =>
      assertAppointmentWindow(
        { date: '10/07/2026', startTime: '09:00', endTime: '10:00' },
        session,
      ),
    ).toThrow(StoreError);
  });

  it('treats StoreError instances as structured errors', () => {
    const error = captureStoreError(() =>
      assertAppointmentWindow({ startTime: '12:00', endTime: '11:00' }, session),
    );
    expect(error).toBeInstanceOf(StoreError);
    expect(error.name).toBe('StoreError');
    expect(error.code).toBe('VALIDATION');
    expect(isStoreError(error)).toBe(true);
    expect(isStoreError(new Error('plain'))).toBe(false);
  });
});

describe('session capacity counting', () => {
  const statuses = (list: AppointmentStatus[]) => list.map((status) => ({ status }));

  it('counts every capacity-consuming status and excludes cancelled', () => {
    const appointments = statuses([
      'requested',
      'confirmed',
      'checked_in',
      'completed',
      'no_show',
      'cancelled',
      'cancelled',
    ]);
    expect(countBookedCapacity(appointments)).toBe(5);
  });

  it('computes remaining capacity from the booked seats', () => {
    const booked = statuses(['requested', 'confirmed', 'cancelled']);
    expect(countAvailableCapacity({ capacity: 4 }, booked)).toBe(2);
    expect(countAvailableCapacity({ capacity: 4 }, statuses([]))).toBe(4);
  });

  it('counts no_show as consuming but cancelled as free', () => {
    expect(countAvailableCapacity({ capacity: 1 }, statuses(['no_show']))).toBe(0);
    expect(countAvailableCapacity({ capacity: 1 }, statuses(['cancelled']))).toBe(1);
  });

  it('reports a session as full when the remaining capacity reaches zero', () => {
    expect(isSessionFull({ capacity: 2 }, statuses(['confirmed', 'requested']))).toBe(true);
    expect(isSessionFull({ capacity: 2 }, statuses(['confirmed', 'cancelled']))).toBe(false);
    expect(isSessionFull({ capacity: 1 }, statuses(['no_show']))).toBe(true);
    expect(isSessionFull({ capacity: 3 }, statuses([]))).toBe(false);
  });

  it('rejects a non-positive or non-integer capacity', () => {
    expect(() => countAvailableCapacity({ capacity: 0 }, statuses([]))).toThrow(StoreError);
    expect(() => countAvailableCapacity({ capacity: -1 }, statuses([]))).toThrow(StoreError);
    expect(() => countAvailableCapacity({ capacity: 2.5 }, statuses([]))).toThrow(StoreError);
  });
});

describe('status vocabulary coverage', () => {
  it('exposes every documented status', () => {
    expect([...ALL_APPOINTMENT_STATUSES]).toEqual([
      'requested',
      'confirmed',
      'checked_in',
      'completed',
      'no_show',
      'cancelled',
    ]);
    expect([...ALL_FOLLOW_UP_STATUSES]).toEqual(['open', 'in_progress', 'done', 'dismissed']);
  });

  it('types the transition helpers with the public status unions', () => {
    const appointmentFrom: AppointmentStatus = 'requested';
    const followUpFrom: FollowUpStatus = 'open';
    expect(isValidAppointmentTransition(appointmentFrom, 'confirmed')).toBe(true);
    expect(isValidFollowUpTransition(followUpFrom, 'in_progress')).toBe(true);
  });
});
