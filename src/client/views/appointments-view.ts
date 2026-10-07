import { html } from 'lit';
import {
  createAppointment,
  listAppointments,
  listClients,
  listProviders,
  toApiError,
  updateAppointmentStatus,
} from '../api.js';
import { defineOnce } from '../lib/define.js';
import { CaregridView } from './view-base.js';
import '../components/app-dialog.js';
import '../components/state-panel.js';
import '../components/status-badge.js';
import {
  formatDayLabel,
  formatDuration,
  formatTimeRange,
  pluralise,
  todayDateOnly,
} from '../lib/format.js';
import {
  appointmentStatusDescription,
  appointmentStatusLabel,
  appointmentStatusTone,
  appointmentActions,
  deriveProviders,
  filterAppointments,
  sortAppointments,
} from '../lib/status.js';
import {
  emptyAppointmentForm,
  errorSummary,
  mapServerFieldErrors,
  validateAppointmentForm,
} from '../lib/validation.js';
import type { FieldErrors } from '../lib/validation.js';
import { APPOINTMENT_TYPES } from '../../shared/constants.js';
import type { AppointmentType } from '../../shared/constants.js';
import { APPOINTMENT_STATUSES } from '../types.js';
import type { Appointment, AppointmentStatus, Client, LoadState, Provider } from '../types.js';

/** Friendly labels for the API's appointment-type enum. */
const APPOINTMENT_TYPE_LABELS: Record<AppointmentType, string> = {
  intake: 'Intake',
  check_in: 'Check-in',
  follow_up: 'Follow-up',
  screening: 'Screening',
  other: 'Other',
};

/** New bookings open on a general check-in rather than the first enum value. */
const DEFAULT_APPOINTMENT_TYPE: AppointmentType = 'check_in';

/**
 * Display labels earlier builds wrote into `type`. The API only accepts the
 * enum values (`intake`, `check_in`, `follow_up`, `screening`, `other`), so any
 * other value is repaired before it reaches the select or the POST body.
 */
const APPOINTMENT_TYPE_ALIASES: Record<string, AppointmentType> = {
  'general check-up': 'check_in',
  vaccination: 'other',
  'wound care': 'other',
  'chronic care review': 'follow_up',
  'mental health support': 'follow_up',
  referral: 'other',
};

function isAppointmentType(value: string): value is AppointmentType {
  return (APPOINTMENT_TYPES as readonly string[]).includes(value);
}

/** Coerces any incoming `type`, including legacy display labels, to a valid API enum value. */
function toAppointmentType(value: string): AppointmentType {
  const normalised = value.trim().toLowerCase();
  if (isAppointmentType(normalised)) {
    return normalised;
  }
  return APPOINTMENT_TYPE_ALIASES[normalised] ?? DEFAULT_APPOINTMENT_TYPE;
}

/** Human-readable label for a stored appointment type, falling back to the raw value. */
function appointmentTypeLabel(value: string): string {
  const text = value.trim();
  if (isAppointmentType(text)) {
    return APPOINTMENT_TYPE_LABELS[text];
  }
  const alias = APPOINTMENT_TYPE_ALIASES[text.toLowerCase()];
  return alias ? APPOINTMENT_TYPE_LABELS[alias] : text;
}

interface Filters {
  date: string;
  status: string;
  providerId: string;
}

/**
 * Appointments: the clinic calendar for the day.
 *
 * `GET /api/appointments` backs the filterable list, `POST /api/appointments` books new visits and
 * `PATCH /api/appointments/:id` drives the status workflow. The booking dialog keeps the
 * coordinator's typed values when the server refuses a clash (409) or a session is full, and shows
 * the server's own wording in a prominent live alert.
 */
export class CaregridAppointmentsView extends CaregridView {
  static override properties = {
    intent: { type: String },
    filters: { state: true },
    loadState: { state: true },
    errorMessage: { state: true },
    appointments: { state: true },
    clients: { state: true },
    providers: { state: true },
    statusMessage: { state: true },
    actionError: { state: true },
    busyAction: { state: true },
    dialogOpen: { state: true },
    form: { state: true },
    formErrors: { state: true },
    formAlert: { state: true },
    formAlertDetail: { state: true },
    submitting: { state: true },
  };

  declare intent: string;
  declare filters: Filters;
  declare loadState: LoadState;
  declare errorMessage: string;
  declare appointments: Appointment[];
  declare clients: Client[];
  declare providers: Provider[];
  declare statusMessage: string;
  declare actionError: string;
  declare busyAction: string;
  declare dialogOpen: boolean;
  declare form: ReturnType<typeof emptyAppointmentForm>;
  declare formErrors: FieldErrors;
  declare formAlert: string;
  declare formAlertDetail: string;
  declare submitting: boolean;

  private controller: AbortController | null = null;
  private formSubmitted = false;

  constructor() {
    super();
    this.intent = '';
    this.filters = { date: '', status: '', providerId: '' };
    this.loadState = 'idle';
    this.errorMessage = '';
    this.appointments = [];
    this.clients = [];
    this.providers = [];
    this.statusMessage = '';
    this.actionError = '';
    this.busyAction = '';
    this.dialogOpen = false;
    this.form = this.newAppointmentForm();
    this.formErrors = {};
    this.formAlert = '';
    this.formAlertDetail = '';
    this.submitting = false;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.controller?.abort();
    this.controller = null;
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('intent') && this.intent === 'new' && !this.dialogOpen) {
      this.openDialog();
    }
  }

  private async load(): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.loadState = this.appointments.length === 0 ? 'loading' : 'ready';
    this.errorMessage = '';
    try {
      const [appointments, clients, providers] = await Promise.all([
        listAppointments({
          date: this.filters.date,
          status: this.filters.status,
          providerId: this.filters.providerId,
          signal: controller.signal,
        }),
        listClients({ signal: controller.signal }).catch(() => [] as Client[]),
        listProviders(controller.signal).catch(() => [] as Provider[]),
      ]);
      if (!this.isCurrent(controller.signal)) {
        return;
      }
      this.appointments = appointments;
      this.clients = clients;
      this.providers = providers.length > 0 ? providers : deriveProviders(appointments);
      this.loadState = 'ready';
      this.notifyRefreshed();
    } catch (error) {
      if (!this.isCurrent(controller.signal)) {
        return;
      }
      this.errorMessage = this.describeFailure(error, 'load the appointment list');
      this.loadState = 'error';
    }
  }

  private handlePanelAction(event: CustomEvent<{ action?: string }>): void {
    event.stopPropagation();
    void this.load();
  }

  private updateFilter(field: keyof Filters, value: string): void {
    this.filters = { ...this.filters, [field]: value };
    void this.load();
  }

  private clearFilters(): void {
    this.filters = { date: '', status: '', providerId: '' };
    void this.load();
  }

  private openDialog(): void {
    this.form = this.newAppointmentForm(this.filters.date || todayDateOnly());
    if (this.filters.providerId) {
      this.form = { ...this.form, providerId: this.filters.providerId };
    }
    this.formErrors = {};
    this.formAlert = '';
    this.formAlertDetail = '';
    this.formSubmitted = false;
    this.dialogOpen = true;
  }

  private closeDialog(): void {
    this.dialogOpen = false;
    this.formAlert = '';
    this.formAlertDetail = '';
    this.formErrors = {};
    this.formSubmitted = false;
  }

  /** Seeds a booking form whose `type` is always a value the API accepts. */
  private newAppointmentForm(
    date: string = todayDateOnly(),
  ): ReturnType<typeof emptyAppointmentForm> {
    const form = emptyAppointmentForm(date);
    return { ...form, type: toAppointmentType(form.type) };
  }

  private updateForm<K extends keyof ReturnType<typeof emptyAppointmentForm>>(
    field: K,
    value: ReturnType<typeof emptyAppointmentForm>[K],
  ): void {
    this.form = { ...this.form, [field]: value };
    if (this.formSubmitted) {
      this.formErrors = validateAppointmentForm(this.form).errors;
    }
  }

  private async handleSubmit(event: Event): Promise<void> {
    event.preventDefault();
    this.formSubmitted = true;
    this.formAlert = '';
    this.formAlertDetail = '';
    const result = validateAppointmentForm(this.form);
    this.formErrors = result.errors;
    if (!result.valid) {
      this.formAlert = errorSummary(result.errors);
      return;
    }
    this.submitting = true;
    try {
      await createAppointment({
        clientId: this.form.clientId,
        providerId: this.form.providerId,
        date: this.form.date,
        startTime: this.form.startTime,
        endTime: this.form.endTime,
        type: this.form.type,
        reason: this.form.reason.trim(),
      });
      const clientName = this.clientName(this.form.clientId);
      this.dialogOpen = false;
      this.formErrors = {};
      this.formSubmitted = false;
      this.statusMessage = `Appointment booked for ${clientName} on ${formatDayLabel(this.form.date)} at ${formatTimeRange(this.form.startTime, this.form.endTime)}.`;
      this.announce(this.statusMessage, 'success');
      this.form = this.newAppointmentForm(this.filters.date || todayDateOnly());
      await this.load();
    } catch (error) {
      const apiError = toApiError(error, 'We could not book that appointment.');
      const mapped = mapServerFieldErrors(apiError.fieldErrors, [
        'clientId',
        'providerId',
        'date',
        'startTime',
        'endTime',
        'type',
        'reason',
      ]);
      if (Object.keys(mapped).length > 0) {
        this.formErrors = { ...this.formErrors, ...mapped };
      }
      const clash = apiError.isSchedulingClash && !apiError.isValidation;
      this.formAlert = clash
        ? 'That slot could not be booked'
        : Object.keys(mapped).length > 0
          ? errorSummary(mapped)
          : 'That appointment could not be saved';
      this.formAlertDetail = apiError.message;
    } finally {
      this.submitting = false;
    }
  }

  private clientName(clientId: string): string {
    const client = this.clients.find((candidate) => candidate.id === clientId);
    return client ? client.fullName : 'this client';
  }

  private async handleStatusAction(
    appointment: Appointment,
    status: AppointmentStatus,
  ): Promise<void> {
    const key = `${appointment.id}:${status}`;
    if (this.busyAction !== '') {
      return;
    }
    this.busyAction = key;
    this.actionError = '';
    try {
      await updateAppointmentStatus(appointment.id, status);
      const label = appointmentStatusLabel(status);
      this.statusMessage = `${appointment.clientName} is now ${label.toLowerCase()}.`;
      this.announce(`${appointment.clientName}: ${label.toLowerCase()} recorded.`, 'success');
      await this.load();
    } catch (error) {
      this.actionError = this.describeFailure(error, 'update that appointment');
    } finally {
      this.busyAction = '';
    }
  }

  private renderFilters() {
    return html`
      <div class="toolbar toolbar--filters" role="search" aria-label="Filter appointments">
        <p class="field">
          <label class="field__label" for="appointment-filter-date">Date</label>
          <input
            class="input"
            id="appointment-filter-date"
            type="date"
            data-testid="appointment-filter-date"
            .value=${this.filters.date}
            @change=${(event: Event) => this.updateFilter('date', (event.target as HTMLInputElement).value)}
          />
        </p>
        <p class="field">
          <label class="field__label" for="appointment-filter-status">Status</label>
          <select
            class="input"
            id="appointment-filter-status"
            data-testid="appointment-filter-status"
            .value=${this.filters.status}
            @change=${(event: Event) => this.updateFilter('status', (event.target as HTMLSelectElement).value)}
          >
            <option value="">All statuses</option>
            ${APPOINTMENT_STATUSES.map(
              (status) => html`<option value=${status}>${appointmentStatusLabel(status)}</option>`,
            )}
          </select>
        </p>
        <p class="field">
          <label class="field__label" for="appointment-filter-provider">Provider</label>
          <select
            class="input"
            id="appointment-filter-provider"
            data-testid="appointment-filter-provider"
            .value=${this.filters.providerId}
            @change=${(event: Event) => this.updateFilter('providerId', (event.target as HTMLSelectElement).value)}
          >
            <option value="">All providers</option>
            ${this.providers.map(
              (provider) => html`<option value=${provider.id}>${provider.name}</option>`,
            )}
          </select>
        </p>
        <button class="button button--ghost" type="button" @click=${this.clearFilters}>
          Clear filters
        </button>
      </div>
    `;
  }

  private renderRows(appointments: Appointment[]) {
    if (this.loadState === 'loading' || this.loadState === 'idle') {
      return html`
        <caregrid-state-panel
          variant="loading"
          title="Loading appointments…"
          .rows=${4}
          data-testid="appointments-loading"
        ></caregrid-state-panel>
      `;
    }
    if (this.loadState === 'error') {
      return html`
        <caregrid-state-panel
          variant="error"
          title="The appointment list could not be loaded"
          message=${this.errorMessage}
          actionLabel="Try again"
          action="retry"
          data-testid="appointments-error"
        ></caregrid-state-panel>
      `;
    }
    if (appointments.length === 0) {
      const filtered =
        this.filters.date !== '' || this.filters.status !== '' || this.filters.providerId !== '';
      return html`
        <caregrid-state-panel
          variant="empty"
          title=${filtered ? 'No appointments match those filters' : 'No appointments booked yet'}
          message=${
            filtered
              ? 'Try another date, status or provider, or clear the filters to see the whole calendar.'
              : 'Book the first visit for today from the New appointment button.'
          }
          data-testid="appointments-empty"
        ></caregrid-state-panel>
      `;
    }
    return html`
      <div class="appointment-list" role="list" aria-label="Appointments">
        ${appointments.map((appointment) => this.renderRow(appointment))}
      </div>
    `;
  }

  private renderRow(appointment: Appointment) {
    const actions = appointmentActions(appointment.status);
    const busy = this.busyAction.startsWith(`${appointment.id}:`);
    return html`
      <div
        class="appointment-row"
        role="listitem"
        data-testid=${`appointment-row-${appointment.id}`}
      >
        <div class="appointment-row__time">
          <p class="appointment-row__clock">
            ${formatTimeRange(appointment.startTime, appointment.endTime)}
          </p>
          <p class="appointment-row__day">${formatDayLabel(appointment.date)}</p>
          ${
            formatDuration(appointment.startTime, appointment.endTime)
              ? html`<p class="appointment-row__duration">
                  ${formatDuration(appointment.startTime, appointment.endTime)}
                </p>`
              : null
          }
        </div>
        <div class="appointment-row__body">
          <p class="appointment-row__client">${appointment.clientName || 'Client to confirm'}</p>
          <p class="appointment-row__meta">
            ${
              [
                appointment.providerName,
                appointment.location,
                appointmentTypeLabel(appointment.type),
              ]
                .filter((part) => part.trim() !== '')
                .join(' · ') || 'No provider assigned'
            }
          </p>
          ${appointment.reason ? html`<p class="appointment-row__reason">${appointment.reason}</p>` : null}
        </div>
        <div class="appointment-row__status">
          <caregrid-status-badge
            label=${appointmentStatusLabel(appointment.status, appointment.rawStatus)}
            tone=${appointmentStatusTone(appointment.status)}
            detail=${appointmentStatusDescription(appointment.status)}
          ></caregrid-status-badge>
        </div>
        <div class="appointment-row__actions">
          ${
            actions.length === 0
              ? html`<p class="muted muted--small">No further actions</p>`
              : actions.map(
                  (action) => html`
                    <button
                      class="button button--${action.tone} button--small"
                      type="button"
                      data-testid=${`appointment-action-${action.status}`}
                      title=${action.description}
                      ?disabled=${this.busyAction !== ''}
                      @click=${() => this.handleStatusAction(appointment, action.status)}
                    >
                      ${busy && this.busyAction.endsWith(`:${action.status}`) ? 'Saving…' : action.label}
                    </button>
                  `,
                )
          }
        </div>
      </div>
    `;
  }

  private renderDialog() {
    if (!this.dialogOpen) {
      return null;
    }
    const errors = this.formErrors;
    const noProviders = this.providers.length === 0;
    const noClients = this.clients.length === 0;
    const busy = this.submitting;
    return html`
      <caregrid-dialog
        open
        label="Book appointment"
        heading-id="appointment-dialog-heading"
        size="wide"
        @caregrid:dialog-close=${this.closeDialog}
      >
        <h2 class="detail__title" id="appointment-dialog-heading">New appointment</h2>
        <p class="muted">
          Book a visit into an open slot. The clinic API checks clashes and capacity.
        </p>
        <form class="form" data-testid="appointment-form" novalidate @submit=${this.handleSubmit}>
          <div class="alert-stack" aria-live="assertive">
            ${
              this.formAlert
                ? html`
                    <div class="alert alert--error" role="alert" data-testid="appointment-error">
                      <p class="alert__title">${this.formAlert}</p>
                      ${this.formAlertDetail ? html`<p class="alert__detail">${this.formAlertDetail}</p>` : null}
                    </div>
                  `
                : null
            }
          </div>
          <div class="field-grid">
            <p class="field">
              <label class="field__label" for="appointment-client">Client</label>
              <select
                class="input"
                id="appointment-client"
                data-testid="appointment-client"
                required
                ?disabled=${busy || noClients}
                .value=${this.form.clientId}
                aria-invalid=${errors.clientId ? 'true' : 'false'}
                aria-describedby=${errors.clientId ? 'appointment-client-error' : undefined}
                @change=${(event: Event) => this.updateForm('clientId', (event.target as HTMLSelectElement).value)}
              >
                <option value="">Select a client</option>
                ${this.clients.map(
                  (client) => html`<option value=${client.id}>${client.fullName}</option>`,
                )}
              </select>
              ${
                errors.clientId
                  ? html`<span class="field__error" id="appointment-client-error"
                      >${errors.clientId}</span
                    >`
                  : noClients
                    ? html`<span class="field__hint">No clients yet — add a client first.</span>`
                    : null
              }
            </p>
            <p class="field">
              <label class="field__label" for="appointment-provider">Provider</label>
              <select
                class="input"
                id="appointment-provider"
                data-testid="appointment-provider"
                required
                ?disabled=${busy || noProviders}
                .value=${this.form.providerId}
                aria-invalid=${errors.providerId ? 'true' : 'false'}
                aria-describedby=${errors.providerId ? 'appointment-provider-error' : undefined}
                @change=${(event: Event) => this.updateForm('providerId', (event.target as HTMLSelectElement).value)}
              >
                <option value="">Select a provider</option>
                ${this.providers.map(
                  (provider) =>
                    html`<option value=${provider.id}>${providerOptionLabel(provider)}</option>`,
                )}
              </select>
              ${
                errors.providerId
                  ? html`<span class="field__error" id="appointment-provider-error"
                      >${errors.providerId}</span
                    >`
                  : noProviders
                    ? html`<span class="field__hint"
                        >No providers published by the clinic API.</span
                      >`
                    : null
              }
            </p>
            <p class="field">
              <label class="field__label" for="appointment-date">Date</label>
              <input
                class="input"
                id="appointment-date"
                type="date"
                required
                data-testid="appointment-date"
                ?disabled=${busy}
                .value=${this.form.date}
                aria-invalid=${errors.date ? 'true' : 'false'}
                aria-describedby=${errors.date ? 'appointment-date-error' : undefined}
                @change=${(event: Event) => this.updateForm('date', (event.target as HTMLInputElement).value)}
              />
              ${errors.date ? html`<span class="field__error" id="appointment-date-error">${errors.date}</span>` : null}
            </p>
            <p class="field">
              <label class="field__label" for="appointment-type">Appointment type</label>
              <select
                class="input"
                id="appointment-type"
                data-testid="appointment-type"
                ?disabled=${busy}
                .value=${this.form.type}
                aria-invalid=${errors.type ? 'true' : 'false'}
                aria-describedby=${errors.type ? 'appointment-type-error' : undefined}
                @change=${(event: Event) => this.updateForm('type', (event.target as HTMLSelectElement).value)}
              >
                ${APPOINTMENT_TYPES.map(
                  // Lit commits the select's `.value` before these nested option
                  // templates exist, so bind `selected` too or the browser falls
                  // back to the first option while the form state says otherwise.
                  (type) =>
                    html`<option value=${type} .selected=${type === this.form.type}>
                      ${APPOINTMENT_TYPE_LABELS[type]}
                    </option>`,
                )}
              </select>
              ${
                errors.type
                  ? html`<span class="field__error" id="appointment-type-error"
                      >${errors.type}</span
                    >`
                  : null
              }
            </p>
            <p class="field">
              <label class="field__label" for="appointment-start">Start time</label>
              <input
                class="input"
                id="appointment-start"
                type="time"
                required
                data-testid="appointment-start"
                ?disabled=${busy}
                .value=${this.form.startTime}
                aria-invalid=${errors.startTime ? 'true' : 'false'}
                aria-describedby=${errors.startTime ? 'appointment-start-error' : undefined}
                @change=${(event: Event) => this.updateForm('startTime', (event.target as HTMLInputElement).value)}
              />
              ${
                errors.startTime
                  ? html`<span class="field__error" id="appointment-start-error"
                      >${errors.startTime}</span
                    >`
                  : null
              }
            </p>
            <p class="field">
              <label class="field__label" for="appointment-end">End time</label>
              <input
                class="input"
                id="appointment-end"
                type="time"
                required
                data-testid="appointment-end"
                ?disabled=${busy}
                .value=${this.form.endTime}
                aria-invalid=${errors.endTime ? 'true' : 'false'}
                aria-describedby=${errors.endTime ? 'appointment-end-error' : undefined}
                @change=${(event: Event) => this.updateForm('endTime', (event.target as HTMLInputElement).value)}
              />
              ${
                errors.endTime
                  ? html`<span class="field__error" id="appointment-end-error"
                      >${errors.endTime}</span
                    >`
                  : null
              }
            </p>
            <p class="field field--wide">
              <label class="field__label" for="appointment-reason">Reason for visit</label>
              <textarea
                class="input input--textarea"
                id="appointment-reason"
                rows="3"
                data-testid="appointment-reason"
                ?disabled=${busy}
                .value=${this.form.reason}
                aria-invalid=${errors.reason ? 'true' : 'false'}
                aria-describedby=${errors.reason ? 'appointment-reason-error' : undefined}
                @input=${(event: Event) => this.updateForm('reason', (event.target as HTMLTextAreaElement).value)}
              ></textarea>
              ${
                errors.reason
                  ? html`<span class="field__error" id="appointment-reason-error"
                      >${errors.reason}</span
                    >`
                  : null
              }
            </p>
          </div>
          <div class="form__actions">
            <button
              class="button button--primary"
              type="submit"
              data-testid="appointment-submit"
              ?disabled=${busy}
            >
              ${busy ? 'Booking…' : 'Book appointment'}
            </button>
            <button
              class="button button--secondary"
              type="button"
              ?disabled=${busy}
              @click=${this.closeDialog}
            >
              Cancel
            </button>
          </div>
        </form>
      </caregrid-dialog>
    `;
  }

  override render() {
    const visible = sortAppointments(filterAppointments(this.appointments, this.filters));
    return html`
      <section class="view" aria-labelledby="appointments-heading">
        <header class="view__header">
          <div class="view__heading">
            <p class="view__eyebrow">Clinic desk</p>
            <h1 class="view__title" id="appointments-heading" tabindex="-1">Appointments</h1>
            <p class="view__subtitle">
              ${this.loadState === 'ready' ? pluralise(visible.length, 'appointment') : 'Clinic calendar'}
            </p>
          </div>
          <div class="view__actions">
            <button
              class="button button--primary"
              type="button"
              data-testid="new-appointment"
              @click=${this.openDialog}
            >
              New appointment
            </button>
            <button class="button button--secondary" type="button" @click=${() => this.load()}>
              Refresh list
            </button>
          </div>
        </header>
        <p class="view__status">${this.statusMessage}</p>
        ${
          this.actionError
            ? html`<p
                class="alert alert--error"
                role="alert"
                data-testid="appointment-action-error"
              >
                ${this.actionError}
              </p>`
            : null
        }
        <section class="card" aria-labelledby="appointments-list-heading">
          <div class="card__header">
            <h2 class="card__title" id="appointments-list-heading">Calendar</h2>
          </div>
          ${this.renderFilters()}
          <div @caregrid:panel-action=${this.handlePanelAction}>${this.renderRows(visible)}</div>
        </section>
        ${this.renderDialog()}
      </section>
    `;
  }
}

function providerOptionLabel(provider: Provider): string {
  const extras = [provider.role, provider.specialty]
    .filter((part) => part.trim() !== '')
    .join(', ');
  return extras ? `${provider.name} (${extras})` : provider.name;
}

defineOnce('caregrid-appointments-view', CaregridAppointmentsView);

declare global {
  interface HTMLElementTagNameMap {
    'caregrid-appointments-view': CaregridAppointmentsView;
  }
}
