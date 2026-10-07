import { html } from "lit";
import { exportCsv, getDashboard } from "../api.js";
import { defineOnce } from "../lib/define.js";
import { CaregridView } from "./view-base.js";
import "../components/appointment-summary.js";
import "../components/capacity-bar.js";
import "../components/followup-summary.js";
import "../components/metric-card.js";
import "../components/state-panel.js";
import { triggerDownload } from "../lib/download.js";
import {
  formatFullDate,
  formatPercent,
  formatRatio,
  pluralise,
  todayDateOnly,
} from "../lib/format.js";
import { sortFollowUps, upcomingAppointments } from "../lib/status.js";
import type {
  CsvKind,
  DashboardData,
  LoadState,
  NoticeTone,
} from "../types.js";

const FOLLOW_UP_PREVIEW_LIMIT = 4;

/**
 * Overview: today at a glance.
 *
 * Loads `GET /api/dashboard` and renders the metric cards, the remaining appointments, the session
 * capacity bars and a follow-up preview, with loading, empty, error and refreshed states. Quick
 * actions hand off to the other views, and the export buttons download the API's own CSV.
 */
export class CaregridOverviewView extends CaregridView {
  static override properties = {
    loadState: { state: true },
    errorMessage: { state: true },
    data: { state: true },
    refreshing: { state: true },
    busyExport: { state: true },
    exportMessage: { state: true },
    exportTone: { state: true },
    today: { state: true },
  };

  declare loadState: LoadState;
  declare errorMessage: string;
  declare data: DashboardData | null;
  declare refreshing: boolean;
  declare busyExport: string;
  declare exportMessage: string;
  declare exportTone: NoticeTone;
  declare today: string;

  private controller: AbortController | null = null;

  constructor() {
    super();
    this.loadState = "idle";
    this.errorMessage = "";
    this.data = null;
    this.refreshing = false;
    this.busyExport = "";
    this.exportMessage = "";
    this.exportTone = "success";
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

  private async load(): Promise<boolean> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const firstLoad = this.data === null;
    this.loadState = firstLoad ? "loading" : "ready";
    this.refreshing = !firstLoad;
    this.errorMessage = "";
    try {
      const data = await getDashboard(controller.signal);
      if (!this.isCurrent(controller.signal)) {
        return false;
      }
      this.data = data;
      this.today = data.date || todayDateOnly();
      this.loadState = "ready";
      this.publishContext({
        clinicName: data.clinicName,
        site: data.site,
        date: data.date,
      });
      this.notifyRefreshed();
      return true;
    } catch (error) {
      if (!this.isCurrent(controller.signal)) {
        return false;
      }
      this.errorMessage = this.describeFailure(
        error,
        "load the clinic overview",
      );
      this.loadState = "error";
      return false;
    } finally {
      if (this.controller === controller) {
        this.controller = null;
        this.refreshing = false;
      }
    }
  }

  private handleRefresh(): void {
    void this.refreshWithFeedback();
  }

  /** Manual refresh confirms itself through the shell's live region and toast stack. */
  private async refreshWithFeedback(): Promise<void> {
    const ok = await this.load();
    if (ok && this.isConnected) {
      this.announce("Overview refreshed.", "info");
    }
  }

  private handlePanelAction(event: CustomEvent<{ action?: string }>): void {
    event.stopPropagation();
    if (event.detail?.action !== "export") {
      void this.load();
    }
  }

  private async handleExport(kind: CsvKind): Promise<void> {
    if (this.busyExport !== "") {
      return;
    }
    this.busyExport = kind;
    this.exportMessage = "";
    try {
      const download = await exportCsv(kind);
      triggerDownload(download.blob, download.filename);
      this.exportTone = "success";
      this.exportMessage = `Downloaded ${download.filename} with ${pluralise(download.rowCount, "row")}.`;
      this.announce(this.exportMessage, "success");
    } catch (error) {
      this.exportTone = "error";
      this.exportMessage = this.describeFailure(
        error,
        `export the ${kind} CSV`,
      );
    } finally {
      this.busyExport = "";
    }
  }

  private renderMetrics(data: DashboardData) {
    const metrics = data.metrics;
    const slotsLeft = Math.max(0, metrics.capacity - metrics.booked);
    const overdueTone = metrics.overdueFollowUps > 0 ? "danger" : "success";
    return html`
      <div class="metric-grid">
        <caregrid-metric-card
          data-testid="metric-today-appointments"
          label="Today's appointments"
          value=${String(metrics.appointmentsToday)}
          hint="Booked for today's clinic"
          tone="info"
        ></caregrid-metric-card>
        <caregrid-metric-card
          data-testid="metric-booked-capacity"
          label="Booked / capacity"
          value=${formatRatio(metrics.booked, metrics.capacity)}
          hint=${
            metrics.capacity > 0
              ? slotsLeft > 0
                ? `${pluralise(slotsLeft, "slot")} still open`
                : "Session fully booked"
              : "No capacity published"
          }
          tone=${metrics.capacity > 0 && slotsLeft === 0 ? "warning" : "neutral"}
        ></caregrid-metric-card>
        <caregrid-metric-card
          data-testid="metric-completion-rate"
          label="Completion rate"
          value=${formatPercent(metrics.completionRate)}
          hint=${`${pluralise(metrics.completedToday, "visit")} completed today`}
          tone="success"
        ></caregrid-metric-card>
        <caregrid-metric-card
          data-testid="metric-open-followups"
          label="Open follow-ups"
          value=${String(metrics.openFollowUps)}
          hint=${`Across ${pluralise(metrics.activeClients, "active client")}`}
          tone="info"
        ></caregrid-metric-card>
        <caregrid-metric-card
          data-testid="metric-overdue-followups"
          label="Overdue follow-ups"
          value=${String(metrics.overdueFollowUps)}
          hint=${metrics.overdueFollowUps > 0 ? "Needs attention today" : "Nothing overdue"}
          tone=${overdueTone}
        ></caregrid-metric-card>
      </div>
    `;
  }

  private renderUpcoming(data: DashboardData) {
    // Re-sorted and trimmed to today onwards, so a stale or unsorted API list still reads well.
    const upcoming = upcomingAppointments(data.upcoming, this.today);
    return html`
      <section class="card" aria-labelledby="overview-upcoming-heading">
        <div class="card__header">
          <div>
            <h2 class="card__title" id="overview-upcoming-heading">
              Upcoming appointments
            </h2>
            <p class="card__subtitle">
              ${pluralise(upcoming.length, "appointment")} still open for
              ${formatFullDate(this.today)}
            </p>
          </div>
          <button
            class="button button--secondary button--small"
            type="button"
            data-testid="overview-open-appointments"
            @click=${() => this.navigate("appointments")}
          >
            Open appointments
          </button>
        </div>
        ${
          upcoming.length === 0
            ? html`
                <caregrid-state-panel
                  variant="empty"
                  title="No appointments left today"
                  message="Everything booked for today has been seen or cancelled. Schedule the next visit from the Appointments tab."
                  data-testid="overview-upcoming-empty"
                ></caregrid-state-panel>
              `
            : html`
                <div
                  class="summary-list"
                  role="list"
                  aria-label="Upcoming appointments"
                >
                  ${upcoming.map(
                    (appointment) => html`
                      <caregrid-appointment-summary
                        .appointment=${appointment}
                      ></caregrid-appointment-summary>
                    `,
                  )}
                </div>
              `
        }
      </section>
    `;
  }

  private renderCapacity(data: DashboardData) {
    return html`
      <section class="card" aria-labelledby="overview-capacity-heading">
        <div class="card__header">
          <div>
            <h2 class="card__title" id="overview-capacity-heading">
              Session capacity
            </h2>
            <p class="card__subtitle">
              How full each clinic session is running
            </p>
          </div>
        </div>
        ${
          data.sessions.length === 0
            ? html`
                <caregrid-state-panel
                  variant="empty"
                  title="No sessions published"
                  message="The clinic API has no session capacity for today yet."
                  data-testid="overview-capacity-empty"
                ></caregrid-state-panel>
              `
            : html`
                <div
                  class="capacity-list"
                  role="list"
                  aria-label="Session capacity"
                >
                  ${data.sessions.map(
                    (session) => html`
                      <caregrid-capacity-bar
                        .booked=${session.booked}
                        .capacity=${session.capacity}
                        label=${session.label || "Session"}
                        startTime=${session.startTime}
                        endTime=${session.endTime}
                        meta=${[session.providerName, session.location].filter(Boolean).join(" · ")}
                      ></caregrid-capacity-bar>
                    `,
                  )}
                </div>
              `
        }
      </section>
    `;
  }

  private renderFollowUps(data: DashboardData) {
    const preview = sortFollowUps(data.followUps, this.today).slice(
      0,
      FOLLOW_UP_PREVIEW_LIMIT,
    );
    return html`
      <section class="card" aria-labelledby="overview-followups-heading">
        <div class="card__header">
          <div>
            <h2 class="card__title" id="overview-followups-heading">
              Follow-up preview
            </h2>
            <p class="card__subtitle">
              The next calls and checks the clinic owes clients
            </p>
          </div>
          <button
            class="button button--secondary button--small"
            type="button"
            data-testid="overview-open-followups"
            @click=${() => this.navigate("followups")}
          >
            Open follow-ups
          </button>
        </div>
        ${
          preview.length === 0
            ? html`
                <caregrid-state-panel
                  variant="empty"
                  title="No follow-ups waiting"
                  message="Nothing is owed to clients right now."
                  data-testid="overview-followups-empty"
                ></caregrid-state-panel>
              `
            : html`
                <div
                  class="summary-list"
                  role="list"
                  aria-label="Follow-up preview"
                >
                  ${preview.map(
                    (followUp) => html`
                      <caregrid-followup-summary
                        .followUp=${followUp}
                        .today=${this.today}
                      ></caregrid-followup-summary>
                    `,
                  )}
                </div>
              `
        }
      </section>
    `;
  }

  private renderBody() {
    if (this.loadState === "loading" || this.loadState === "idle") {
      return html`
        <div class="stack">
          <caregrid-state-panel
            variant="loading"
            title="Loading today's clinic data…"
            message="Fetching appointments, capacity and follow-ups from the clinic API."
            .rows=${4}
            data-testid="overview-loading"
          ></caregrid-state-panel>
        </div>
      `;
    }
    if (this.loadState === "error" || this.data === null) {
      return html`
        <caregrid-state-panel
          variant="error"
          title="The overview could not be loaded"
          message=${this.errorMessage || "The clinic API did not answer. Try again in a moment."}
          actionLabel="Try again"
          action="retry"
          data-testid="overview-error"
        ></caregrid-state-panel>
      `;
    }
    const data = this.data;
    return html`
      ${this.renderMetrics(data)}
      <div class="overview-columns">
        ${this.renderUpcoming(data)} ${this.renderCapacity(data)}
      </div>
      ${this.renderFollowUps(data)}
    `;
  }

  override render() {
    const subtitleParts = [formatFullDate(this.data?.date || this.today)];
    if (this.data?.site) {
      subtitleParts.push(this.data.site);
    }
    return html`
      <section class="view" aria-labelledby="overview-heading">
        <header class="view__header">
          <div class="view__heading">
            <p class="view__eyebrow">Clinic desk</p>
            <h1 class="view__title" id="overview-heading" tabindex="-1">
              Overview
            </h1>
            <p class="view__subtitle">${subtitleParts.join(" · ")}</p>
          </div>
          <div class="view__actions">
            <button
              class="button button--primary"
              type="button"
              data-testid="refresh-dashboard"
              ?disabled=${this.refreshing || this.loadState === "loading"}
              @click=${this.handleRefresh}
            >
              ${this.refreshing ? "Refreshing…" : "Refresh dashboard"}
            </button>
            <button
              class="button button--secondary"
              type="button"
              data-testid="overview-new-appointment"
              @click=${() => this.navigate("appointments", "new")}
            >
              New appointment
            </button>
            <button
              class="button button--secondary"
              type="button"
              data-testid="overview-new-client"
              @click=${() => this.navigate("clients", "new")}
            >
              Add client
            </button>
            <button
              class="button button--secondary"
              type="button"
              data-testid="export-clients"
              ?disabled=${this.busyExport !== ""}
              @click=${() => this.handleExport("clients")}
            >
              ${this.busyExport === "clients" ? "Exporting…" : "Export clients CSV"}
            </button>
            <button
              class="button button--secondary"
              type="button"
              data-testid="export-appointments"
              ?disabled=${this.busyExport !== ""}
              @click=${() => this.handleExport("appointments")}
            >
              ${this.busyExport === "appointments" ? "Exporting…" : "Export appointments CSV"}
            </button>
          </div>
        </header>
        <p class="view__status" role="status" aria-live="polite">
          ${this.refreshing ? "Refreshing clinic data…" : ""}
        </p>
        ${
          this.exportMessage
            ? html`
                <p
                  class="view__status view__status--${this.exportTone}"
                  role=${this.exportTone === "error" ? "alert" : "note"}
                >
                  ${this.exportMessage}
                </p>
              `
            : null
        }
        <div @caregrid:panel-action=${this.handlePanelAction}>
          ${this.renderBody()}
        </div>
      </section>
    `;
  }
}

defineOnce("caregrid-overview-view", CaregridOverviewView);

declare global {
  interface HTMLElementTagNameMap {
    "caregrid-overview-view": CaregridOverviewView;
  }
}
