/**
 * Client side validation for the three clinic forms.
 *
 * The rules mirror the API contract: required fields, sane lengths, well formed email/phone and a
 * positive appointment duration. They are pure functions so the unit tests can cover the success,
 * boundary and failure cases without a browser.
 */

import { todayDateOnly } from './format.js';

export type FieldErrors = Record<string, string>;

export interface ValidationResult {
  valid: boolean;
  errors: FieldErrors;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_PATTERN = /^\d{1,2}:\d{2}$/;
const NAME_MAX = 80;
const TITLE_MAX = 120;

export interface ClientFormValues {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  preferredContact: string;
  consentGranted: boolean;
  notes: string;
}

export interface AppointmentFormValues {
  clientId: string;
  providerId: string;
  date: string;
  startTime: string;
  endTime: string;
  type: string;
  reason: string;
}

export interface FollowUpFormValues {
  clientId: string;
  appointmentId: string;
  title: string;
  priority: string;
  dueDate: string;
  assignee: string;
  detail: string;
}

export function emptyClientForm(): ClientFormValues {
  return {
    firstName: '',
    lastName: '',
    phone: '',
    email: '',
    preferredContact: 'phone',
    consentGranted: true,
    notes: '',
  };
}

export function emptyAppointmentForm(date: string = todayDateOnly()): AppointmentFormValues {
  return {
    clientId: '',
    providerId: '',
    date,
    startTime: '',
    endTime: '',
    type: 'General check-up',
    reason: '',
  };
}

export function emptyFollowUpForm(dueDate: string = todayDateOnly()): FollowUpFormValues {
  return {
    clientId: '',
    appointmentId: '',
    title: '',
    priority: 'medium',
    dueDate,
    assignee: '',
    detail: '',
  };
}

function required(value: string, label: string, errors: FieldErrors, field: string): void {
  if (value.trim() === '') {
    errors[field] = `${label} is required.`;
  }
}

function maxLength(
  value: string,
  max: number,
  label: string,
  errors: FieldErrors,
  field: string,
): void {
  if (value.trim().length > max) {
    errors[field] = `${label} must be ${max} characters or fewer.`;
  }
}

export function validateClientForm(values: ClientFormValues): ValidationResult {
  const errors: FieldErrors = {};
  required(values.firstName, 'First name', errors, 'firstName');
  maxLength(values.firstName, NAME_MAX, 'First name', errors, 'firstName');
  required(values.lastName, 'Last name', errors, 'lastName');
  maxLength(values.lastName, NAME_MAX, 'Last name', errors, 'lastName');

  const email = values.email.trim();
  if (email !== '' && !EMAIL_PATTERN.test(email)) {
    errors.email = 'Enter an email address such as name@example.org.';
  }
  const phone = values.phone.trim();
  if (phone !== '' && phone.replace(/\D/g, '').length < 7) {
    errors.phone = 'Enter a phone number with at least 7 digits.';
  }
  if (phone === '' && email === '') {
    errors.phone = 'Add a phone number or an email so the clinic can reach this client.';
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

export function validateAppointmentForm(values: AppointmentFormValues): ValidationResult {
  const errors: FieldErrors = {};
  required(values.clientId, 'Client', errors, 'clientId');
  required(values.providerId, 'Provider', errors, 'providerId');
  required(values.date, 'Date', errors, 'date');
  if (values.date.trim() !== '' && !DATE_PATTERN.test(values.date.trim())) {
    errors.date = 'Enter the date as YYYY-MM-DD.';
  }
  required(values.startTime, 'Start time', errors, 'startTime');
  required(values.endTime, 'End time', errors, 'endTime');
  if (values.startTime.trim() !== '' && !CLOCK_PATTERN.test(values.startTime.trim())) {
    errors.startTime = 'Enter the start time as HH:MM.';
  }
  if (values.endTime.trim() !== '' && !CLOCK_PATTERN.test(values.endTime.trim())) {
    errors.endTime = 'Enter the end time as HH:MM.';
  }
  if (
    CLOCK_PATTERN.test(values.startTime.trim()) &&
    CLOCK_PATTERN.test(values.endTime.trim()) &&
    toMinutes(values.endTime) <= toMinutes(values.startTime)
  ) {
    errors.endTime = 'The end time must be after the start time.';
  }
  required(values.type, 'Appointment type', errors, 'type');
  maxLength(values.reason, 400, 'Reason for visit', errors, 'reason');
  return { valid: Object.keys(errors).length === 0, errors };
}

export function validateFollowUpForm(values: FollowUpFormValues): ValidationResult {
  const errors: FieldErrors = {};
  required(values.clientId, 'Client', errors, 'clientId');
  required(values.title, 'Follow-up task', errors, 'title');
  maxLength(values.title, TITLE_MAX, 'Follow-up task', errors, 'title');
  if (values.dueDate.trim() !== '' && !DATE_PATTERN.test(values.dueDate.trim())) {
    errors.dueDate = 'Enter the due date as YYYY-MM-DD.';
  }
  if (values.priority.trim() === '') {
    errors.priority = 'Choose a priority.';
  }
  maxLength(values.detail, 400, 'Notes', errors, 'detail');
  return { valid: Object.keys(errors).length === 0, errors };
}

function toMinutes(clock: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!match) {
    return Number.NaN;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Maps server field names (`client_id`, `start-time`) onto the form's camelCase fields. */
export function mapServerFieldErrors(
  serverErrors: FieldErrors,
  knownFields: string[],
): FieldErrors {
  const mapped: FieldErrors = {};
  for (const [field, message] of Object.entries(serverErrors)) {
    const camel = field.replace(/[_-](\w)/g, (_match, letter: string) => letter.toUpperCase());
    const target = knownFields.find((known) => known.toLowerCase() === camel.toLowerCase());
    mapped[target ?? camel] = message;
  }
  return mapped;
}

export function firstError(errors: FieldErrors): string {
  const values = Object.values(errors);
  return values.length > 0 ? values[0] : '';
}

export function errorSummary(errors: FieldErrors): string {
  const count = Object.keys(errors).length;
  if (count === 0) {
    return '';
  }
  if (count === 1) {
    return firstError(errors);
  }
  return `${count} fields need attention before this can be saved.`;
}
