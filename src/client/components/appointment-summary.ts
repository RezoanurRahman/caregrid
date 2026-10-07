import { html } from "lit";
import { CaregridElement } from "../lib/element.js";
import { defineOnce } from "../lib/define.js";
import { formatDayLabel, formatTimeRange } from "../lib/format.js";
import {
  appointmentStatusDescription,
  appointmentStatusLabel,
  appointmentStatusTone,
} from "../lib/status.js";
import type { Appointment } from "../types.js";
import "./status-badge.js";

/** Read-only appointment row used by the Overview, the client detail and search results. */
export class CaregridAppointmentSummary extends CaregridElement {
  static override properties = {
    appointment: { attribute: false },
    showDate: { type: Boolean },
    heading: { type: String },
  };

  declare appointment: Appointment | null;
  declare showDate: boolean;
  declare heading: string;

  constructor() {
    super();
    this.appointment = null;
    this.showDate = false;
    this.heading = "";
  }

  override render() {
    const appointment = this.appointment;
    if (!appointment) {
      return null;
    }
    const meta = [
      appointment.providerName,
      appointment.type,
      appointment.location,
    ]
      .filter((part) => part.trim() !== "")
      .join(" · ");
    return html`
      <div
        class="summary-row"
        role="listitem"
        data-testid=${`appointment-summary-${appointment.id}`}
      >
        <p class="summary-row__time">
          <span class="summary-row__clock"
            >${formatTimeRange(appointment.startTime, appointment.endTime)}</span
          >
          ${this.showDate ? html`<span class="summary-row__day">${formatDayLabel(appointment.date)}</span>` : null}
        </p>
        <div class="summary-row__body">
          <p class="summary-row__title">
            ${this.heading || appointment.clientName || "Client"}
          </p>
          ${meta ? html`<p class="summary-row__meta">${meta}</p>` : null}
        </div>
        <p class="summary-row__status">
          <caregrid-status-badge
            label=${appointmentStatusLabel(appointment.status, appointment.rawStatus)}
            tone=${appointmentStatusTone(appointment.status)}
            detail=${appointmentStatusDescription(appointment.status)}
            size="small"
          ></caregrid-status-badge>
        </p>
      </div>
    `;
  }
}

defineOnce("caregrid-appointment-summary", CaregridAppointmentSummary);

declare global {
  interface HTMLElementTagNameMap {
    "caregrid-appointment-summary": CaregridAppointmentSummary;
  }
}
