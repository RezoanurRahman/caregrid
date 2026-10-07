import { html } from 'lit';
import {
  createFollowUp,
  listAppointments,
  listClients,
  listFollowUps,
  toApiError,
  updateFollowUpStatus,
} from '../api.js';
import { defineOnce } from '../lib/define.js';
import { CaregridView } from './view-base.js';
import '../components/state-panel.js';
import '../components/status-badge.js';
import { formatDayLabel, formatTimeRange, pluralise, todayDateOnly } from '../lib/format.js';
import {
  FOLLOW_UP_FILTER_LABELS,
  filterFollowUps,
  followUpDueText,
  followUpActions,
  followUpStatusLabel,
  followUpStatusTone,
  isFollowUpOverdue,
  priorityLabel,
  priorityTone,
  sortFollowUps,
} from '../lib/status.js';
import {
  emptyFollowUpForm,
  errorSummary,
  mapServerFieldErrors,
  validateFollowUpForm,
} from '../lib/validation.js';
import type { FieldErrors } from '../lib/validation.js';
import { FOLLOW_UP_FILTERS } from '../types.js';
import type {
  Appointment,
  Client,
  FollowUp,
  FollowUpFilter,
  FollowUpStatus,
  LoadState,
} from '../types.js';

const PRIORITY_OPTIONS = [
  { value: 'high', label: 'High priority' },
  { value: 'medium', label: 'Medium priority' },
  { value: 'low', label: 'Low priority' },
];

/**
 * Follow-ups: the work the clinic owes clients after a visit.
 *
 * `GET /api/followups` backs the filterable queue, `POST /api/followups` records new work and
 * `PATCH /api/followups/:id` moves it from open to in progress to done. Overdue work is called out
 * in words as well as colour.
 */
export class CaregridFollowUpsView extends CaregridView {
  static override properties = {
    filter: { state: true },
    loadState: { state: true },
    errorMessage: { state: true },
    followUps: { state: true },
    clients: { state: true },
    appointments: { state: true },
    statusMessage: { state: true },
    actionError: { state: true },
    busyAction: { state: true },
    form: { state: true },
    formErrors: { state: true },
    formAlert: { state: true },
    formSuccess: { state: true },
    submitting: { state: true },
    today: { state: true },
  };

  declare filter: FollowUpFilter;
  declare loadState: LoadState;
  declare errorMessage: string;
  declare followUps: FollowUp[];
  declare clients: Client[];
  declare appointments: Appointment[];
  declare statusMessage: string;
  declare actionError: string;
  declare busyAction: string;
  declare form: ReturnType<typeof emptyFollowUpForm>;
  declare formErrors: FieldErrors;
  declare formAlert: string;
  declare formSuccess: string;
  declare submitting: boolean;
  declare today: string;

  private controller: AbortController | null = null;
  private formSubmitted = false;

  constructor() {
    super();
    this.filter = 'all';
    this.loadState = 'idle';
    this.errorMessage = '';
    this.followUps = [];
    this.clients = [];
    this.appointments = [];
    this.statusMessage = '';
    this.actionError = '';
    this.busyAction = '';
    this.form = emptyFollowUpForm();
    this.formErrors = {};
    this.formAlert = '';
    this.formSuccess = '';
    this.submitting = false;
    this.today = todayDateOnly();
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

  private async load(): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.loadState = this.followUps.length === 0 ? 'loading' : 'ready';
    this.errorMessage = '';
    const today = todayDateOnly();
    this.today = today;
    try {
      const [followUps, clients, appointments] = await Promise.all([
        listFollowUps({ signal: controller.signal }),
        listClients({ signal: controller.signal }).catch(() => [] as Client[]),
        listAppointments({ signal: controller.signal }).catch(() => [] as Appointment[]),
      ]);
      if (!this.isCurrent(controller.signal)) {
        return;
      }
      this.followUps = followUps;
      this.clients = clients;
      this.appointments = appointments;
      this.loadState = 'ready';
      this.notifyRefreshed();
    } catch (error) {
      if (!this.isCurrent(controller.signal)) {
        return;
      }
      this.errorMessage = this.describeFailure(error, 'load the follow-up queue');
      this.loadState = 'error';
    }
  }

  private handlePanelAction(event: CustomEvent<{ action?: string }>): void {
    event.stopPropagation();
    void this.load();
  }

  private changeFilter(filter: FollowUpFilter): void {
    this.filter = filter;
    this.loadState = this.followUps.length === 0 ? 'loading' : 'ready';
    this.statusMessage = '';
  }

  private updateForm<K extends keyof ReturnType<typeof emptyFollowUpForm>>(
    field: K,
    value: ReturnType<typeof emptyFollowUpForm>[K],
  ): void {
    this.form = { ...this.form, [field]: value };
    this.formSuccess = '';
    if (this.formSubmitted) {
      this.formErrors = validateFollowUpForm(this.form).errors;
    }
  }

  private async handleSubmit(event: Event): Promise<void> {
    event.preventDefault();
    this.formSubmitted = true;
    this.formAlert = '';
    this.formSuccess = '';
    const result = validateFollowUpForm(this.form);
    this.formErrors = result.errors;
    if (!result.valid) {
      this.formAlert = errorSummary(result.errors);
      return;
    }
    this.submitting = true;
    try {
      const created = await createFollowUp({
        clientId: this.form.clientId,
        appointmentId: this.form.appointmentId,
        title: this.form.title.trim(),
        priority: this.form.priority,
        dueDate: this.form.dueDate,
        assignee: this.form.assignee.trim(),
        detail: this.form.detail.trim(),
      });
      const label = created.title || this.form.title;
      this.formSuccess = `Follow-up "${label}" was added to the queue.`;
      this.statusMessage = this.formSuccess;
      this.announce(this.formSuccess, 'success');
      this.form = emptyFollowUpForm(this.today);
      this.formErrors = {};
      this.formSubmitted = false;
      await this.load();
    } catch (error) {
      const apiError = toApiError(error, 'We could not save that follow-up.');
      const mapped = mapServerFieldErrors(apiError.fieldErrors, [
        'clientId',
        'appointmentId',
        'title',
        'priority',
        'dueDate',
        'assignee',
        'detail',
      ]);
      if (Object.keys(mapped).length > 0) {
        this.formErrors = { ...this.formErrors, ...mapped };
      }
      this.formAlert = Object.keys(mapped).length > 0 ? errorSummary(mapped) : apiError.message;
    } finally {
      this.submitting = false;
    }
  }

  private async handleStatusAction(followUp: FollowUp, status: FollowUpStatus): Promise<void> {
    if (this.busyAction !== '') {
      return;
    }
    this.busyAction = `${followUp.id}:${status}`;
    this.actionError = '';
    try {
      await updateFollowUpStatus(followUp.id, status);
      const label = followUpStatusLabel(status).toLowerCase();
      this.statusMessage = `"${followUp.title}" is now ${label}.`;
      this.announce(`${followUp.title}: marked ${label}.`, 'success');
      await this.load();
    } catch (error) {
      this.actionError = this.describeFailure(error, 'update that follow-up');
    } finally {
      this.busyAction = '';
    }
  }

  private renderFilters() {
    return html`
      <div class="chip-row" role="group" aria-label="Filter follow-ups">
        ${FOLLOW_UP_FILTERS.map((filter) => {
          const active = this.filter === filter;
          const count = this.countFor(filter);
          return html`
            <button
              class="chip${active ? ' is-active' : ''}"
              type="button"
              data-testid=${`followup-filter-${filter}`}
              aria-pressed=${active ? 'true' : 'false'}
              @click=${() => this.changeFilter(filter)}
            >
              ${FOLLOW_UP_FILTER_LABELS[filter]}
              <span class="chip__count">${count}</span>
            </button>
          `;
        })}
      </div>
    `;
  }

  private countFor(filter: FollowUpFilter): number {
    return filterFollowUps(this.followUps, filter, this.today).length;
  }

  private renderRows() {
    if (this.loadState === 'loading' || this.loadState === 'idle') {
      return html`
        <caregrid-state-panel
          variant="loading"
          title="Loading follow-ups…"
          .rows=${4}
          data-testid="followups-loading"
        ></caregrid-state-panel>
      `;
    }
    if (this.loadState === 'error') {
      return html`
        <caregrid-state-panel
          variant="error"
          title="The follow-up queue could not be loaded"
          message=${this.errorMessage}
          actionLabel="Try again"
          action="retry"
          data-testid="followups-error"
        ></caregrid-state-panel>
      `;
    }
    const visible = sortFollowUps(
      filterFollowUps(this.followUps, this.filter, this.today),
      this.today,
    );
    if (visible.length === 0) {
      return html`
        <caregrid-state-panel
          variant="empty"
          title=${this.filter === 'all' ? 'No follow-ups yet' : `No ${FOLLOW_UP_FILTER_LABELS[this.filter].toLowerCase()} follow-ups`}
          message=${
            this.filter === 'all'
              ? 'Record the first call, check-in or referral using the form above.'
              : 'Try another filter to see the rest of the queue.'
          }
          data-testid="followups-empty"
        ></caregrid-state-panel>
      `;
    }
    return html`
      <div class="followup-list" role="list" aria-label="Follow-ups">
        ${visible.map((followUp) => this.renderRow(followUp))}
      </div>
    `;
  }

  private renderRow(followUp: FollowUp) {
    const overdue = isFollowUpOverdue(followUp, this.today);
    const actions = followUpActions(followUp.status);
    const appointment = this.appointments.find(
      (candidate) => candidate.id === followUp.appointmentId,
    );
    return html`
      <div
        class="followup-row${overdue ? ' is-overdue' : ''}"
        role="listitem"
        data-testid=${`followup-row-${followUp.id}`}
      >
        <div class="followup-row__main">
          <p class="followup-row__title">${followUp.title}</p>
          <p class="followup-row__meta">
            <span>${followUp.clientName || 'Unknown client'}</span>
            ${followUp.assignee ? html`<span class="muted"> · Owner: ${followUp.assignee}</span>` : null}
            ${
              appointment
                ? html`<span class="muted">
                    · Visit ${formatDayLabel(appointment.date, this.today)}
                    ${formatTimeRange(appointment.startTime, appointment.endTime)}
                  </span>`
                : null
            }
          </p>
          ${followUp.detail ? html`<p class="followup-row__detail">${followUp.detail}</p>` : null}
          <p class="followup-row__due ${overdue ? 'text-danger' : 'muted'}">
            ${followUpDueText(followUp, this.today)}
          </p>
        </div>
        <div class="followup-row__badges">
          <caregrid-status-badge
            label=${priorityLabel(followUp.priority, followUp.rawPriority)}
            tone=${priorityTone(followUp.priority)}
          ></caregrid-status-badge>
          <caregrid-status-badge
            label=${followUpStatusLabel(followUp.status, followUp.rawStatus)}
            tone=${followUpStatusTone(followUp.status)}
          ></caregrid-status-badge>
        </div>
        <div class="followup-row__actions">
          ${
            actions.length === 0
              ? html`<p class="muted muted--small">No further actions</p>`
              : actions.map(
                  (action) => html`
                    <button
                      class="button button--${action.tone} button--small"
                      type="button"
                      data-testid=${`followup-action-${action.status}`}
                      title=${action.description}
                      ?disabled=${this.busyAction !== ''}
                      @click=${() => this.handleStatusAction(followUp, action.status)}
                    >
                      ${this.busyAction === `${followUp.id}:${action.status}` ? 'Saving…' : action.label}
                    </button>
                  `,
                )
          }
        </div>
      </div>
    `;
  }

  private renderForm() {
    const errors = this.formErrors;
    const busy = this.submitting;
    const clientOptions = this.clients.filter((client) => client.id !== '');
    return html`
      <section class="card" aria-labelledby="followup-form-heading">
        <div class="card__header">
          <div>
            <h2 class="card__title" id="followup-form-heading">Add a follow-up</h2>
            <p class="card__subtitle">
              Link the task to a client and, when it follows a visit, to the appointment.
            </p>
          </div>
        </div>
        <form class="form" data-testid="followup-form" novalidate @submit=${this.handleSubmit}>
          <div class="alert-stack" aria-live="assertive">
            ${
              this.formAlert
                ? html`
                    <div class="alert alert--error" role="alert" data-testid="followup-error">
                      <p class="alert__title">This follow-up could not be saved</p>
                      <p class="alert__detail">${this.formAlert}</p>
                    </div>
                  `
                : null
            }
          </div>
          <p class="view__status view__status--success">${this.formSuccess}</p>
          <div class="field-grid">
            <p class="field">
              <label class="field__label" for="followup-client">Client</label>
              <select
                class="input"
                id="followup-client"
                data-testid="followup-client"
                required
                ?disabled=${busy}
                .value=${this.form.clientId}
                aria-invalid=${errors.clientId ? 'true' : 'false'}
                aria-describedby=${errors.clientId ? 'followup-client-error' : undefined}
                @change=${(event: Event) => this.updateForm('clientId', (event.target as HTMLSelectElement).value)}
              >
                <option value="">Select a client</option>
                ${clientOptions.map((client) => html`<option value=${client.id}>${client.fullName}</option>`)}
              </select>
              ${
                errors.clientId
                  ? html`<span class="field__error" id="followup-client-error"
                      >${errors.clientId}</span
                    >`
                  : null
              }
            </p>
            <p class="field">
              <label class="field__label" for="followup-appointment">Appointment (optional)</label>
              <select
                class="input"
                id="followup-appointment"
                data-testid="followup-appointment"
                ?disabled=${busy}
                .value=${this.form.appointmentId}
                @change=${(event: Event) => this.updateForm('appointmentId', (event.target as HTMLSelectElement).value)}
              >
                <option value="">Not linked to a visit</option>
                ${this.appointments.map(
                  (appointment) => html`
                    <option value=${appointment.id}>
                      ${appointment.clientName} · ${formatDayLabel(appointment.date, this.today)}
                      ${formatTimeRange(appointment.startTime, appointment.endTime)}
                    </option>
                  `,
                )}
              </select>
            </p>
            <p class="field field--wide">
              <label class="field__label" for="followup-title">Follow-up task</label>
              <input
                class="input"
                id="followup-title"
                type="text"
                required
                data-testid="followup-title"
                placeholder="Call to review blood pressure results"
                ?disabled=${busy}
                .value=${this.form.title}
                aria-invalid=${errors.title ? 'true' : 'false'}
                aria-describedby=${errors.title ? 'followup-title-error' : undefined}
                @input=${(event: Event) => this.updateForm('title', (event.target as HTMLInputElement).value)}
              />
              ${
                errors.title
                  ? html`<span class="field__error" id="followup-title-error"
                      >${errors.title}</span
                    >`
                  : null
              }
            </p>
            <p class="field">
              <label class="field__label" for="followup-priority">Priority</label>
              <select
                class="input"
                id="followup-priority"
                data-testid="followup-priority"
                ?disabled=${busy}
                .value=${this.form.priority}
                @change=${(event: Event) => this.updateForm('priority', (event.target as HTMLSelectElement).value)}
              >
                ${PRIORITY_OPTIONS.map((option) => html`<option value=${option.value}>${option.label}</option>`)}
              </select>
            </p>
            <p class="field">
              <label class="field__label" for="followup-due">Due date</label>
              <input
                class="input"
                id="followup-due"
                type="date"
                data-testid="followup-due"
                ?disabled=${busy}
                .value=${this.form.dueDate}
                aria-invalid=${errors.dueDate ? 'true' : 'false'}
                aria-describedby=${errors.dueDate ? 'followup-due-error' : undefined}
                @change=${(event: Event) => this.updateForm('dueDate', (event.target as HTMLInputElement).value)}
              />
              ${
                errors.dueDate
                  ? html`<span class="field__error" id="followup-due-error"
                      >${errors.dueDate}</span
                    >`
                  : null
              }
            </p>
            <p class="field">
              <label class="field__label" for="followup-assignee">Owner</label>
              <input
                class="input"
                id="followup-assignee"
                type="text"
                data-testid="followup-assignee"
                placeholder="Who will do this?"
                ?disabled=${busy}
                .value=${this.form.assignee}
                @input=${(event: Event) => this.updateForm('assignee', (event.target as HTMLInputElement).value)}
              />
            </p>
            <p class="field field--wide">
              <label class="field__label" for="followup-detail">Notes</label>
              <textarea
                class="input input--textarea"
                id="followup-detail"
                rows="3"
                data-testid="followup-detail"
                ?disabled=${busy}
                .value=${this.form.detail}
                @input=${(event: Event) => this.updateForm('detail', (event.target as HTMLTextAreaElement).value)}
              ></textarea>
            </p>
          </div>
          <div class="form__actions">
            <button
              class="button button--primary"
              type="submit"
              data-testid="followup-submit"
              ?disabled=${busy}
            >
              ${busy ? 'Saving…' : 'Add follow-up'}
            </button>
          </div>
        </form>
      </section>
    `;
  }

  override render() {
    return html`
      <section class="view" aria-labelledby="followups-heading">
        <header class="view__header">
          <div class="view__heading">
            <p class="view__eyebrow">Clinic desk</p>
            <h1 class="view__title" id="followups-heading" tabindex="-1">Follow-ups</h1>
            <p class="view__subtitle">
              ${
                this.loadState === 'ready'
                  ? `${pluralise(this.countFor('open'), 'open task')} · ${pluralise(this.countFor('overdue'), 'task')} overdue`
                  : 'Work owed to clients'
              }
            </p>
          </div>
          <div class="view__actions">
            <button
              class="button button--secondary"
              type="button"
              data-testid="refresh-followups"
              @click=${() => this.load()}
            >
              Refresh queue
            </button>
          </div>
        </header>
        <p class="view__status">${this.statusMessage}</p>
        ${
          this.actionError
            ? html`<p class="alert alert--error" role="alert" data-testid="followup-action-error">
                ${this.actionError}
              </p>`
            : null
        }
        ${this.renderForm()}
        <section class="card" aria-labelledby="followups-list-heading">
          <div class="card__header">
            <h2 class="card__title" id="followups-list-heading">Queue</h2>
          </div>
          ${this.renderFilters()}
          <div @caregrid:panel-action=${this.handlePanelAction}>${this.renderRows()}</div>
        </section>
      </section>
    `;
  }
}

defineOnce('caregrid-followups-view', CaregridFollowUpsView);

declare global {
  interface HTMLElementTagNameMap {
    'caregrid-followups-view': CaregridFollowUpsView;
  }
}
