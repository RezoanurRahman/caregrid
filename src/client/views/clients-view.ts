import { html } from 'lit';
import { createClient, getClient, listClients, toApiError } from '../api.js';
import { defineOnce } from '../lib/define.js';
import { CaregridView } from './view-base.js';
import '../components/appointment-summary.js';
import '../components/app-dialog.js';
import '../components/followup-summary.js';
import '../components/state-panel.js';
import '../components/status-badge.js';
import { formatDayLabel, formatTimestamp, initials } from '../lib/format.js';
import {
  emptyClientForm,
  errorSummary,
  mapServerFieldErrors,
  validateClientForm,
} from '../lib/validation.js';
import type { FieldErrors } from '../lib/validation.js';
import { filterClients, sortAppointments, sortFollowUps } from '../lib/status.js';
import type { ClientDetail, Client, LoadState } from '../types.js';

const PREFERRED_CONTACT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'phone', label: 'Phone call' },
  { value: 'sms', label: 'Text message' },
  { value: 'email', label: 'Email' },
  { value: 'letter', label: 'Letter' },
  { value: 'in_person', label: 'In person at the clinic' },
];

/**
 * Clients: searchable roster, intake form and full client record.
 *
 * The list loads `GET /api/clients` (re-queried while typing), the record loads
 * `GET /api/clients/:id`, and intake posts to `POST /api/clients`. Loading, empty, not-found,
 * validation and mutation states are all first class.
 */
export class CaregridClientsView extends CaregridView {
  static override properties = {
    intent: { type: String },
    search: { state: true },
    listState: { state: true },
    listError: { state: true },
    clients: { state: true },
    selectedId: { state: true },
    detailState: { state: true },
    detailError: { state: true },
    detail: { state: true },
    dialogOpen: { state: true },
    form: { state: true },
    formErrors: { state: true },
    formAlert: { state: true },
    submitting: { state: true },
    statusMessage: { state: true },
  };

  declare intent: string;
  declare search: string;
  declare listState: LoadState;
  declare listError: string;
  declare clients: Client[];
  declare selectedId: string;
  declare detailState: LoadState;
  declare detailError: string;
  declare detail: ClientDetail | null;
  declare dialogOpen: boolean;
  declare form: ReturnType<typeof emptyClientForm>;
  declare formErrors: FieldErrors;
  declare formAlert: string;
  declare submitting: boolean;
  declare statusMessage: string;

  private listController: AbortController | null = null;
  private detailController: AbortController | null = null;
  private searchTimer: number | null = null;
  private formSubmitted = false;

  constructor() {
    super();
    this.intent = '';
    this.search = '';
    this.listState = 'idle';
    this.listError = '';
    this.clients = [];
    this.selectedId = '';
    this.detailState = 'idle';
    this.detailError = '';
    this.detail = null;
    this.dialogOpen = false;
    this.form = emptyClientForm();
    this.formErrors = {};
    this.formAlert = '';
    this.submitting = false;
    this.statusMessage = '';
  }

  override connectedCallback(): void {
    super.connectedCallback();
    void this.loadClients();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.listController?.abort();
    this.detailController?.abort();
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('intent') && this.intent === 'new' && !this.dialogOpen) {
      this.openCreateDialog();
    }
  }

  private async loadClients(): Promise<void> {
    this.listController?.abort();
    const controller = new AbortController();
    this.listController = controller;
    this.listState = this.clients.length === 0 ? 'loading' : 'ready';
    this.listError = '';
    try {
      const clients = await listClients({
        search: this.search.trim(),
        signal: controller.signal,
      });
      if (!this.isCurrent(controller.signal)) {
        return;
      }
      this.clients = clients;
      this.listState = 'ready';
      if (this.selectedId !== '' && !clients.some((client) => client.id === this.selectedId)) {
        this.selectedId = '';
        this.detail = null;
        this.detailState = 'idle';
      }
    } catch (error) {
      if (!this.isCurrent(controller.signal)) {
        return;
      }
      this.listError = this.describeFailure(error, 'load the client list');
      this.listState = 'error';
    }
  }

  private async loadDetail(id: string): Promise<void> {
    this.detailController?.abort();
    const controller = new AbortController();
    this.detailController = controller;
    this.detailState = 'loading';
    this.detailError = '';
    try {
      const detail = await getClient(id, controller.signal);
      if (!this.isCurrent(controller.signal) || this.selectedId !== id) {
        return;
      }
      this.detail = detail;
      this.detailState = 'ready';
    } catch (error) {
      if (!this.isCurrent(controller.signal) || this.selectedId !== id) {
        return;
      }
      this.detail = null;
      this.detailError = this.describeFailure(error, 'load that client record');
      this.detailState = 'error';
    }
  }

  private selectClient(client: Client): void {
    if (this.selectedId === client.id) {
      this.selectedId = '';
      this.detail = null;
      this.detailState = 'idle';
      return;
    }
    this.selectedId = client.id;
    this.detailState = 'loading';
    this.detail = null;
    void this.loadDetail(client.id);
  }

  private handleSearchInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.search = input.value;
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
    }
    this.searchTimer = window.setTimeout(() => {
      this.searchTimer = null;
      void this.loadClients();
    }, 250);
  }

  private clearSearch(): void {
    this.search = '';
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    void this.loadClients();
  }

  private openCreateDialog(): void {
    this.form = emptyClientForm();
    this.formErrors = {};
    this.formAlert = '';
    this.formSubmitted = false;
    this.dialogOpen = true;
  }

  private closeDialog(): void {
    this.dialogOpen = false;
    this.formAlert = '';
    this.formErrors = {};
    this.formSubmitted = false;
  }

  private handlePanelAction(event: CustomEvent<{ action?: string }>): void {
    event.stopPropagation();
    if (event.detail?.action === 'detail-retry' && this.selectedId !== '') {
      void this.loadDetail(this.selectedId);
      return;
    }
    void this.loadClients();
  }

  private handleFieldInput(field: keyof ReturnType<typeof emptyClientForm>, value: string): void {
    this.form = { ...this.form, [field]: value };
    if (this.formSubmitted) {
      this.formErrors = validateClientForm(this.form).errors;
    }
  }

  private async handleSubmit(event: Event): Promise<void> {
    event.preventDefault();
    this.formSubmitted = true;
    this.formAlert = '';
    const result = validateClientForm(this.form);
    this.formErrors = result.errors;
    if (!result.valid) {
      this.formAlert = errorSummary(result.errors);
      return;
    }
    this.submitting = true;
    try {
      const created = await createClient({
        firstName: this.form.firstName.trim(),
        lastName: this.form.lastName.trim(),
        phone: this.form.phone.trim(),
        email: this.form.email.trim(),
        preferredContact: this.form.preferredContact,
        consentGranted: this.form.consentGranted,
        notes: this.form.notes.trim(),
      });
      const name = created.fullName || `${this.form.firstName} ${this.form.lastName}`.trim();
      this.dialogOpen = false;
      this.form = emptyClientForm();
      this.formErrors = {};
      this.formSubmitted = false;
      this.statusMessage = `${name} was added to the client roster.`;
      this.announce(`${name} was added to the client roster.`, 'success');
      await this.loadClients();
      if (created.id !== '') {
        this.selectedId = created.id;
        void this.loadDetail(created.id);
      }
    } catch (error) {
      const apiError = toApiError(error, 'We could not save that client.');
      const mapped = mapServerFieldErrors(apiError.fieldErrors, [
        'firstName',
        'lastName',
        'phone',
        'email',
        'preferredContact',
        'consentGranted',
        'notes',
      ]);
      if (Object.keys(mapped).length > 0) {
        this.formErrors = { ...this.formErrors, ...mapped };
      }
      this.formAlert = Object.keys(mapped).length > 0 ? errorSummary(mapped) : apiError.message;
    } finally {
      this.submitting = false;
    }
  }

  private renderList() {
    if (this.listState === 'loading' || this.listState === 'idle') {
      return html`
        <caregrid-state-panel
          variant="loading"
          title="Loading clients…"
          .rows=${4}
          data-testid="clients-loading"
        ></caregrid-state-panel>
      `;
    }
    if (this.listState === 'error') {
      return html`
        <caregrid-state-panel
          variant="error"
          title="The client list could not be loaded"
          message=${this.listError}
          actionLabel="Try again"
          action="list-retry"
          data-testid="clients-error"
        ></caregrid-state-panel>
      `;
    }
    const visible = filterClients(this.clients, this.search);
    if (visible.length === 0) {
      return html`
        <caregrid-state-panel
          variant="empty"
          title=${this.search.trim() === '' ? 'No clients yet' : 'No clients match that search'}
          message=${
            this.search.trim() === ''
              ? 'Add the first client to start booking appointments and follow-ups.'
              : 'Try a different name, phone number or email address.'
          }
          data-testid="clients-empty"
        ></caregrid-state-panel>
      `;
    }
    return html`
      <div class="summary-list" role="list" aria-label="Client roster">
        ${visible.map((client) => this.renderClientRow(client))}
      </div>
    `;
  }

  private renderClientRow(client: Client) {
    const selected = client.id === this.selectedId;
    return html`
      <div role="listitem">
        <button
          class="client-row${selected ? ' is-selected' : ''}"
          type="button"
          data-testid=${`client-row-${client.id}`}
          aria-expanded=${selected ? 'true' : 'false'}
          @click=${() => this.selectClient(client)}
        >
          <span class="client-row__avatar" aria-hidden="true">${initials(client.fullName)}</span>
          <span class="client-row__body">
            <span class="client-row__name">${client.fullName}</span>
            <span class="client-row__meta">
              ${[client.phone, client.email].filter((part) => part.trim() !== '').join(' · ') || 'No contact details'}
            </span>
            <span class="client-row__badges">
              <caregrid-status-badge
                label=${client.status || 'active'}
                tone="neutral"
                size="small"
                detail="Client status"
              ></caregrid-status-badge>
              <caregrid-status-badge
                label=${client.consent.granted ? 'Consent on file' : 'Consent missing'}
                tone=${client.consent.granted ? 'success' : 'warning'}
                size="small"
              ></caregrid-status-badge>
            </span>
          </span>
          <span class="client-row__hint">${selected ? 'Hide record' : 'Open record'}</span>
        </button>
      </div>
    `;
  }

  private renderDetail() {
    if (this.selectedId === '') {
      return html`
        <caregrid-state-panel
          variant="empty"
          title="Select a client"
          message="Choose a client from the roster to see contact details, appointments, follow-ups and activity."
          data-testid="client-detail-empty"
        ></caregrid-state-panel>
      `;
    }
    if (this.detailState === 'loading') {
      return html`
        <caregrid-state-panel
          variant="loading"
          title="Loading client record…"
          .rows=${5}
          data-testid="client-detail-loading"
        ></caregrid-state-panel>
      `;
    }
    if (this.detailState === 'error' || this.detail === null) {
      return html`
        <caregrid-state-panel
          variant="error"
          title="That client record is not available"
          message=${this.detailError}
          actionLabel="Try again"
          action="detail-retry"
          data-testid="client-detail-error"
        ></caregrid-state-panel>
      `;
    }
    const detail = this.detail;
    const appointments = sortAppointments(detail.appointments);
    const followUps = sortFollowUps(detail.followUps);
    return html`
      <article class="detail" aria-labelledby="client-detail-heading" data-testid="client-detail">
        <header class="detail__header">
          <div>
            <p class="view__eyebrow">Client record</p>
            <h2 class="detail__title" id="client-detail-heading">${detail.fullName}</h2>
            <p class="detail__meta">
              ${detail.since ? `Registered ${formatDayLabel(detail.since)}` : 'Registration date not recorded'}
            </p>
          </div>
          <div class="detail__badges">
            <caregrid-status-badge
              label=${detail.status || 'active'}
              tone="neutral"
              detail="Client status"
            ></caregrid-status-badge>
            <caregrid-status-badge
              label=${detail.consent.granted ? 'Consent on file' : 'Consent missing'}
              tone=${detail.consent.granted ? 'success' : 'warning'}
              detail=${detail.consent.date ? `Recorded ${formatDayLabel(detail.consent.date)}` : detail.consent.label}
            ></caregrid-status-badge>
          </div>
        </header>
        <div class="detail__grid">
          <section class="detail__block" aria-labelledby="client-contact-heading">
            <h3 class="detail__subheading" id="client-contact-heading">Contact</h3>
            <dl class="detail-list">
              <div>
                <dt>Phone</dt>
                <dd>${detail.phone || 'Not recorded'}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>${detail.email || 'Not recorded'}</dd>
              </div>
              <div>
                <dt>Preferred contact</dt>
                <dd>${preferredContactLabel(detail.preferredContact)}</dd>
              </div>
              <div>
                <dt>Language</dt>
                <dd>${detail.language || 'Not recorded'}</dd>
              </div>
            </dl>
          </section>
          <section class="detail__block" aria-labelledby="client-consent-heading">
            <h3 class="detail__subheading" id="client-consent-heading">Consent</h3>
            <dl class="detail-list">
              <div>
                <dt>Care coordination</dt>
                <dd>${detail.consent.granted ? 'Recorded' : 'Not recorded'}</dd>
              </div>
              <div>
                <dt>Recorded on</dt>
                <dd>
                  ${detail.consent.date ? formatDayLabel(detail.consent.date) : 'Not recorded'}
                </dd>
              </div>
              <div>
                <dt>Notes</dt>
                <dd>${detail.notes || 'No intake notes'}</dd>
              </div>
            </dl>
          </section>
        </div>
        <section class="detail__block" aria-labelledby="client-appointments-heading">
          <h3 class="detail__subheading" id="client-appointments-heading">
            Appointments (${appointments.length})
          </h3>
          ${
            appointments.length === 0
              ? html`<p class="muted">No appointments booked for this client yet.</p>`
              : html`
                  <div class="summary-list" role="list" aria-label="Client appointments">
                    ${appointments.map(
                      (appointment) => html`
                        <caregrid-appointment-summary
                          .appointment=${appointment}
                          showDate
                        ></caregrid-appointment-summary>
                      `,
                    )}
                  </div>
                `
          }
        </section>
        <section class="detail__block" aria-labelledby="client-followups-heading">
          <h3 class="detail__subheading" id="client-followups-heading">
            Follow-ups (${followUps.length})
          </h3>
          ${
            followUps.length === 0
              ? html`<p class="muted">No follow-ups recorded for this client.</p>`
              : html`
                  <div class="summary-list" role="list" aria-label="Client follow-ups">
                    ${followUps.map(
                      (followUp) => html`
                        <caregrid-followup-summary
                          .followUp=${followUp}
                          .showClient=${false}
                        ></caregrid-followup-summary>
                      `,
                    )}
                  </div>
                `
          }
        </section>
        <section class="detail__block" aria-labelledby="client-activity-heading">
          <h3 class="detail__subheading" id="client-activity-heading">Activity timeline</h3>
          ${
            detail.activity.length === 0
              ? html`<p class="muted">No activity recorded for this client yet.</p>`
              : html`
                  <ol class="timeline">
                    ${detail.activity.map(
                      (entry) => html`
                        <li class="timeline__item">
                          <p class="timeline__summary">${entry.summary}</p>
                          ${entry.detail ? html`<p class="timeline__detail">${entry.detail}</p>` : null}
                          <p class="timeline__stamp">${formatTimestamp(entry.at)}</p>
                        </li>
                      `,
                    )}
                  </ol>
                `
          }
        </section>
      </article>
    `;
  }

  private renderDialog() {
    if (!this.dialogOpen) {
      return null;
    }
    const errors = this.formErrors;
    return html`
      <caregrid-dialog
        open
        label="New client intake"
        heading-id="client-dialog-heading"
        size="wide"
        @caregrid:dialog-close=${this.closeDialog}
      >
        <h2 class="detail__title" id="client-dialog-heading">Add a client</h2>
        <p class="muted">
          Record the details the clinic needs to coordinate care. Name and phone are required; email
          is optional.
        </p>
        <form class="form" data-testid="client-form" novalidate @submit=${this.handleSubmit}>
          ${
            this.formAlert
              ? html`
                  <p class="alert alert--error" role="alert" data-testid="client-form-error">
                    ${this.formAlert}
                  </p>
                `
              : null
          }
          <div class="field-grid">
            <p class="field">
              <label class="field__label" for="client-first-name">First name</label>
              <input
                class="input"
                id="client-first-name"
                name="firstName"
                type="text"
                autocomplete="given-name"
                required
                data-testid="client-first-name"
                .value=${this.form.firstName}
                aria-invalid=${errors.firstName ? 'true' : 'false'}
                aria-describedby=${errors.firstName ? 'client-first-name-error' : undefined}
                @input=${(event: Event) => this.handleFieldInput('firstName', (event.target as HTMLInputElement).value)}
              />
              ${
                errors.firstName
                  ? html`<span class="field__error" id="client-first-name-error"
                      >${errors.firstName}</span
                    >`
                  : null
              }
            </p>
            <p class="field">
              <label class="field__label" for="client-last-name">Last name</label>
              <input
                class="input"
                id="client-last-name"
                name="lastName"
                type="text"
                autocomplete="family-name"
                required
                data-testid="client-last-name"
                .value=${this.form.lastName}
                aria-invalid=${errors.lastName ? 'true' : 'false'}
                aria-describedby=${errors.lastName ? 'client-last-name-error' : undefined}
                @input=${(event: Event) => this.handleFieldInput('lastName', (event.target as HTMLInputElement).value)}
              />
              ${
                errors.lastName
                  ? html`<span class="field__error" id="client-last-name-error"
                      >${errors.lastName}</span
                    >`
                  : null
              }
            </p>
            <p class="field">
              <label class="field__label" for="client-phone">Phone (required)</label>
              <input
                class="input"
                id="client-phone"
                name="phone"
                type="tel"
                autocomplete="tel"
                required
                placeholder="555 0100"
                data-testid="client-phone"
                .value=${this.form.phone}
                aria-invalid=${errors.phone ? 'true' : 'false'}
                aria-describedby=${errors.phone ? 'client-phone-error' : 'client-phone-hint'}
                @input=${(event: Event) => this.handleFieldInput('phone', (event.target as HTMLInputElement).value)}
              />
              ${
                errors.phone
                  ? html`<span class="field__error" id="client-phone-error">${errors.phone}</span>`
                  : html`<span class="field__hint" id="client-phone-hint"
                      >Required. Include an area code where possible.</span
                    >`
              }
            </p>
            <p class="field">
              <label class="field__label" for="client-email">Email</label>
              <input
                class="input"
                id="client-email"
                name="email"
                type="email"
                autocomplete="email"
                data-testid="client-email"
                .value=${this.form.email}
                aria-invalid=${errors.email ? 'true' : 'false'}
                aria-describedby=${errors.email ? 'client-email-error' : undefined}
                @input=${(event: Event) => this.handleFieldInput('email', (event.target as HTMLInputElement).value)}
              />
              ${
                errors.email
                  ? html`<span class="field__error" id="client-email-error">${errors.email}</span>`
                  : null
              }
            </p>
            <p class="field">
              <label class="field__label" for="client-preferred-contact">Preferred contact</label>
              <select
                class="input"
                id="client-preferred-contact"
                name="preferredContact"
                data-testid="client-preferred-contact"
                .value=${this.form.preferredContact}
                @change=${(event: Event) =>
                  this.handleFieldInput(
                    'preferredContact',
                    (event.target as HTMLSelectElement).value,
                  )}
              >
                ${PREFERRED_CONTACT_OPTIONS.map(
                  (option) => html`<option value=${option.value}>${option.label}</option>`,
                )}
              </select>
            </p>
            <p class="field field--wide">
              <label class="field__label" for="client-notes">Intake notes</label>
              <textarea
                class="input input--textarea"
                id="client-notes"
                name="notes"
                rows="3"
                data-testid="client-notes"
                .value=${this.form.notes}
                @input=${(event: Event) => this.handleFieldInput('notes', (event.target as HTMLTextAreaElement).value)}
              ></textarea>
            </p>
            <p class="field field--wide">
              <label class="checkbox" for="client-consent">
                <input
                  type="checkbox"
                  id="client-consent"
                  name="consentGranted"
                  data-testid="client-consent"
                  .checked=${this.form.consentGranted}
                  @change=${(event: Event) =>
                    this.handleConsentChange((event.target as HTMLInputElement).checked)}
                />
                <span>Consent recorded for care coordination and follow-up contact</span>
              </label>
            </p>
          </div>
          <div class="form__actions">
            <button
              class="button button--primary"
              type="submit"
              data-testid="client-submit"
              ?disabled=${this.submitting}
            >
              ${this.submitting ? 'Saving…' : 'Save client'}
            </button>
            <button class="button button--secondary" type="button" @click=${this.closeDialog}>
              Cancel
            </button>
          </div>
        </form>
      </caregrid-dialog>
    `;
  }

  private handleConsentChange(checked: boolean): void {
    this.form = { ...this.form, consentGranted: checked };
  }

  override render() {
    const visible = filterClients(this.clients, this.search);
    const countLabel =
      this.listState === 'ready'
        ? `${visible.length} of ${this.clients.length} clients shown`
        : 'Client roster';
    return html`
      <section class="view" aria-labelledby="clients-heading">
        <header class="view__header">
          <div class="view__heading">
            <p class="view__eyebrow">Clinic desk</p>
            <h1 class="view__title" id="clients-heading" tabindex="-1">Clients</h1>
            <p class="view__subtitle">${countLabel}</p>
          </div>
          <div class="view__actions">
            <button
              class="button button--primary"
              type="button"
              data-testid="new-client"
              @click=${this.openCreateDialog}
            >
              Add client
            </button>
            <button
              class="button button--secondary"
              type="button"
              @click=${() => this.loadClients()}
            >
              Refresh list
            </button>
          </div>
        </header>
        <p class="view__status">${this.statusMessage}</p>
        <div class="split">
          <section class="card split__list" aria-labelledby="clients-list-heading">
            <div class="card__header">
              <h2 class="card__title" id="clients-list-heading">Roster</h2>
            </div>
            <div class="toolbar">
              <p class="field field--grow">
                <label class="field__label" for="client-search">Search clients</label>
                <input
                  class="input"
                  id="client-search"
                  type="search"
                  data-testid="client-search"
                  placeholder="Name, phone or email"
                  .value=${this.search}
                  @input=${this.handleSearchInput}
                />
              </p>
              ${
                this.search.trim() !== ''
                  ? html`<button
                      class="button button--ghost"
                      type="button"
                      @click=${this.clearSearch}
                    >
                      Clear search
                    </button>`
                  : null
              }
            </div>
            <div class="split__scroll" @caregrid:panel-action=${this.handlePanelAction}>
              ${this.renderList()}
            </div>
          </section>
          <section class="card split__detail" aria-labelledby="clients-detail-heading">
            <div class="card__header">
              <h2 class="card__title" id="clients-detail-heading">Client record</h2>
              ${
                this.selectedId !== ''
                  ? html`
                      <button
                        class="button button--ghost button--small"
                        type="button"
                        @click=${this.clearSelection}
                      >
                        Close record
                      </button>
                    `
                  : null
              }
            </div>
            <div class="split__scroll" @caregrid:panel-action=${this.handlePanelAction}>
              ${this.renderDetail()}
            </div>
          </section>
        </div>
        ${this.renderDialog()}
      </section>
    `;
  }

  private clearSelection(): void {
    this.selectedId = '';
    this.detail = null;
    this.detailState = 'idle';
    this.detailError = '';
  }
}

function preferredContactLabel(value: string): string {
  const match = PREFERRED_CONTACT_OPTIONS.find((option) => option.value === value);
  if (match) {
    return match.label;
  }
  return value.trim() === '' ? 'Not recorded' : value;
}

defineOnce('caregrid-clients-view', CaregridClientsView);

declare global {
  interface HTMLElementTagNameMap {
    'caregrid-clients-view': CaregridClientsView;
  }
}
