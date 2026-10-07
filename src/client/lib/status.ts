/**
 * Status vocabulary, valid transitions and list filtering.
 *
 * The clinic desk only offers transitions the domain allows, so a coordinator can never pick an
 * impossible move. Everything here is pure and covered by unit tests.
 */

import type {
  Appointment,
  AppointmentStatus,
  Client,
  FollowUp,
  FollowUpFilter,
  FollowUpStatus,
  KnownFollowUpStatus,
  Priority,
  Provider,
} from '../types.js';
import { dueLabel, formatDayLabel, isPastDue, todayDateOnly } from './format.js';

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'muted';

export interface StatusAction<S extends string> {
  status: S;
  label: string;
  tone: 'primary' | 'neutral' | 'danger';
  description: string;
}

interface AppointmentStatusMeta {
  label: string;
  tone: StatusTone;
  description: string;
}

const APPOINTMENT_STATUS_META: Record<AppointmentStatus, AppointmentStatusMeta> = {
  scheduled: {
    label: 'Scheduled',
    tone: 'info',
    description: 'Booked, waiting for a confirmation call',
  },
  confirmed: {
    label: 'Confirmed',
    tone: 'neutral',
    description: 'Client confirmed they will attend',
  },
  checked_in: {
    label: 'Checked in',
    tone: 'success',
    description: 'Client is in the clinic',
  },
  completed: {
    label: 'Completed',
    tone: 'success',
    description: 'Visit finished and notes recorded',
  },
  no_show: {
    label: 'No-show',
    tone: 'warning',
    description: 'Client did not attend',
  },
  cancelled: {
    label: 'Cancelled',
    tone: 'muted',
    description: 'Visit was cancelled',
  },
  unknown: {
    label: 'Unrecognised',
    tone: 'muted',
    description: 'The clinic API returned an unfamiliar status',
  },
};

export function appointmentStatusLabel(status: AppointmentStatus, rawStatus = ''): string {
  if (status === 'unknown' && rawStatus.trim() !== '') {
    return rawStatus.trim();
  }
  return APPOINTMENT_STATUS_META[status].label;
}

export function appointmentStatusTone(status: AppointmentStatus): StatusTone {
  return APPOINTMENT_STATUS_META[status].tone;
}

export function appointmentStatusDescription(status: AppointmentStatus): string {
  return APPOINTMENT_STATUS_META[status].description;
}

const APPOINTMENT_ACTIONS: Record<AppointmentStatus, StatusAction<AppointmentStatus>[]> = {
  // The API's `requested` arrives as `scheduled`; both only allow confirm/cancel.
  scheduled: [
    {
      status: 'confirmed',
      label: 'Confirm',
      tone: 'primary',
      description: 'Mark that the client confirmed',
    },
    {
      status: 'cancelled',
      label: 'Cancel',
      tone: 'danger',
      description: 'Cancel this appointment',
    },
  ],
  confirmed: [
    {
      status: 'checked_in',
      label: 'Check in',
      tone: 'primary',
      description: 'Mark that the client arrived',
    },
    {
      status: 'no_show',
      label: 'No-show',
      tone: 'neutral',
      description: 'Mark that the client did not attend',
    },
    {
      status: 'cancelled',
      label: 'Cancel',
      tone: 'danger',
      description: 'Cancel this appointment',
    },
  ],
  checked_in: [
    {
      status: 'completed',
      label: 'Complete',
      tone: 'primary',
      description: 'Finish the visit',
    },
    {
      status: 'no_show',
      label: 'No-show',
      tone: 'neutral',
      description: 'Mark that the client did not attend',
    },
  ],
  completed: [],
  no_show: [],
  cancelled: [],
  unknown: [],
};

/** Only the transitions the domain allows for the row's current status. */
export function appointmentActions(status: AppointmentStatus): StatusAction<AppointmentStatus>[] {
  return APPOINTMENT_ACTIONS[status] ?? [];
}

const FOLLOW_UP_STATUS_META: Record<FollowUpStatus, { label: string; tone: StatusTone }> = {
  open: { label: 'Open', tone: 'info' },
  in_progress: { label: 'In progress', tone: 'warning' },
  done: { label: 'Done', tone: 'success' },
  dismissed: { label: 'Dismissed', tone: 'muted' },
  unknown: { label: 'Unrecognised', tone: 'muted' },
};

export function followUpStatusLabel(status: FollowUpStatus, rawStatus = ''): string {
  if (status === 'unknown' && rawStatus.trim() !== '') {
    return rawStatus.trim();
  }
  return FOLLOW_UP_STATUS_META[status].label;
}

export function followUpStatusTone(status: FollowUpStatus): StatusTone {
  return FOLLOW_UP_STATUS_META[status].tone;
}

const FOLLOW_UP_ACTIONS: Record<FollowUpStatus, StatusAction<KnownFollowUpStatus>[]> = {
  open: [
    {
      status: 'in_progress',
      label: 'Start',
      tone: 'primary',
      description: 'Start working on this follow-up',
    },
    {
      status: 'dismissed',
      label: 'Dismiss',
      tone: 'danger',
      description: 'Close this follow-up without further action',
    },
  ],
  in_progress: [
    {
      status: 'open',
      label: 'Reopen',
      tone: 'neutral',
      description: 'Move this follow-up back to the open queue',
    },
    {
      status: 'done',
      label: 'Mark done',
      tone: 'primary',
      description: 'Record this follow-up as done',
    },
    {
      status: 'dismissed',
      label: 'Dismiss',
      tone: 'danger',
      description: 'Close this follow-up without further action',
    },
  ],
  done: [],
  dismissed: [],
  unknown: [],
};

export function followUpActions(status: FollowUpStatus): StatusAction<KnownFollowUpStatus>[] {
  return FOLLOW_UP_ACTIONS[status] ?? [];
}

const PRIORITY_META: Record<Priority, { label: string; tone: StatusTone; weight: number }> = {
  high: { label: 'High priority', tone: 'danger', weight: 0 },
  medium: { label: 'Medium priority', tone: 'warning', weight: 1 },
  low: { label: 'Low priority', tone: 'neutral', weight: 2 },
  unknown: { label: 'No priority', tone: 'muted', weight: 3 },
};

export function priorityLabel(priority: Priority, rawPriority = ''): string {
  if (priority === 'unknown' && rawPriority.trim() !== '') {
    return rawPriority.trim();
  }
  return PRIORITY_META[priority].label;
}

export function priorityTone(priority: Priority): StatusTone {
  return PRIORITY_META[priority].tone;
}

export function priorityWeight(priority: Priority): number {
  return PRIORITY_META[priority].weight;
}

/** Terminal follow-ups (done or dismissed) are finished work, never "late". */
function isFinishedFollowUp(status: FollowUpStatus): boolean {
  return status === 'done' || status === 'dismissed';
}

export function isFollowUpOverdue(followUp: FollowUp, today: string = todayDateOnly()): boolean {
  if (isFinishedFollowUp(followUp.status)) {
    return false;
  }
  return isPastDue(followUp.dueDate, today);
}

/**
 * Due-date wording for a follow-up row.
 *
 * Finished work is never labelled "overdue": the row states when it was due instead, so a
 * coordinator reading a done task is not told it is late.
 */
export function followUpDueText(followUp: FollowUp, today: string = todayDateOnly()): string {
  if (isFinishedFollowUp(followUp.status)) {
    return followUp.dueDate ? `Was due ${formatDayLabel(followUp.dueDate, today)}` : 'No due date';
  }
  return dueLabel(followUp.dueDate, today);
}

export const FOLLOW_UP_FILTER_LABELS: Record<FollowUpFilter, string> = {
  all: 'All',
  open: 'Open',
  in_progress: 'In progress',
  done: 'Done',
  overdue: 'Overdue',
};

export function followUpMatchesFilter(
  followUp: FollowUp,
  filter: FollowUpFilter,
  today: string = todayDateOnly(),
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'overdue':
      return isFollowUpOverdue(followUp, today);
    default:
      return followUp.status === filter;
  }
}

export function filterFollowUps(
  followUps: FollowUp[],
  filter: FollowUpFilter,
  today: string = todayDateOnly(),
): FollowUp[] {
  return followUps.filter((followUp) => followUpMatchesFilter(followUp, filter, today));
}

export interface AppointmentFilters {
  date?: string;
  status?: string;
  providerId?: string;
}

/** Local mirror of the server filters, so the list still narrows if a query param is ignored. */
export function appointmentMatchesFilters(
  appointment: Appointment,
  filters: AppointmentFilters,
): boolean {
  if (filters.date && filters.date !== '' && appointment.date !== filters.date) {
    return false;
  }
  if (filters.status && filters.status !== '' && appointment.status !== filters.status) {
    return false;
  }
  if (
    filters.providerId &&
    filters.providerId !== '' &&
    appointment.providerId !== '' &&
    appointment.providerId !== filters.providerId
  ) {
    return false;
  }
  return true;
}

export function filterAppointments(
  appointments: Appointment[],
  filters: AppointmentFilters,
): Appointment[] {
  return appointments.filter((appointment) => appointmentMatchesFilters(appointment, filters));
}

export function matchesClientSearch(client: Client, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return true;
  }
  return [
    client.fullName,
    client.firstName,
    client.lastName,
    client.email,
    client.phone,
    client.status,
  ]
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

export function filterClients(clients: Client[], query: string): Client[] {
  return clients.filter((client) => matchesClientSearch(client, query));
}

export function sortAppointments(appointments: Appointment[]): Appointment[] {
  return [...appointments].sort((left, right) => {
    const day = left.date.localeCompare(right.date);
    if (day !== 0) {
      return day;
    }
    const start = left.startTime.localeCompare(right.startTime);
    if (start !== 0) {
      return start;
    }
    return left.clientName.localeCompare(right.clientName);
  });
}

export function sortFollowUps(followUps: FollowUp[], today: string = todayDateOnly()): FollowUp[] {
  return [...followUps].sort((left, right) => {
    const overdue =
      Number(isFollowUpOverdue(right, today)) - Number(isFollowUpOverdue(left, today));
    if (overdue !== 0) {
      return overdue;
    }
    const leftDue = left.dueDate === '' ? '9999-12-31' : left.dueDate;
    const rightDue = right.dueDate === '' ? '9999-12-31' : right.dueDate;
    const due = leftDue.localeCompare(rightDue);
    if (due !== 0) {
      return due;
    }
    const weight = priorityWeight(left.priority) - priorityWeight(right.priority);
    if (weight !== 0) {
      return weight;
    }
    return left.title.localeCompare(right.title);
  });
}

export function upcomingAppointments(
  appointments: Appointment[],
  today: string = todayDateOnly(),
): Appointment[] {
  return sortAppointments(appointments.filter((appointment) => appointment.date >= today));
}

/** Providers derived from appointments, used when the API exposes no provider directory. */
export function deriveProviders(appointments: Appointment[]): Provider[] {
  const seen = new Map<string, Provider>();
  for (const appointment of appointments) {
    if (appointment.providerId === '' || seen.has(appointment.providerId)) {
      continue;
    }
    seen.set(appointment.providerId, {
      id: appointment.providerId,
      name: appointment.providerName || 'Unassigned provider',
      role: '',
      specialty: '',
    });
  }
  return [...seen.values()].sort((left, right) => left.name.localeCompare(right.name));
}
