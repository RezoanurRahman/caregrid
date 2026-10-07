import { html } from "lit";
import { CaregridElement } from "../lib/element.js";
import { defineOnce } from "../lib/define.js";
import { formatRatio, formatTimeRange } from "../lib/format.js";

/**
 * `<caregrid-capacity-bar>`: session capacity as a real progress bar.
 *
 * The bar exposes `role="progressbar"` with value semantics, and the same numbers are printed as
 * text, so the information survives screen readers, greyscale printing and failed CSS loads.
 */
export class CaregridCapacityBar extends CaregridElement {
  static override properties = {
    label: { type: String },
    booked: { type: Number },
    capacity: { type: Number },
    startTime: { type: String },
    endTime: { type: String },
    meta: { type: String },
  };

  declare label: string;
  declare booked: number;
  declare capacity: number;
  declare startTime: string;
  declare endTime: string;
  declare meta: string;

  constructor() {
    super();
    this.label = "";
    this.booked = 0;
    this.capacity = 0;
    this.startTime = "";
    this.endTime = "";
    this.meta = "";
  }

  private get fill(): number {
    if (this.capacity <= 0) {
      return 0;
    }
    return Math.min(100, Math.round((this.booked / this.capacity) * 100));
  }

  private get tone(): string {
    if (this.capacity > 0 && this.booked >= this.capacity) {
      return "full";
    }
    return this.fill >= 80 ? "busy" : "open";
  }

  override render() {
    const time = formatTimeRange(this.startTime, this.endTime);
    const description =
      this.capacity > 0
        ? `${formatRatio(this.booked, this.capacity)} slots booked (${this.fill}% full)`
        : `${this.booked} appointments booked, no capacity published`;
    return html`
      <div class="capacity-row" role="listitem">
        <div class="capacity-row__head">
          <p class="capacity-row__label">${this.label || "Session"}</p>
          <p class="capacity-row__numbers">${description}</p>
        </div>
        <div
          class="capacity-row__track"
          role="progressbar"
          aria-label=${`${this.label || "Session"} capacity`}
          aria-valuemin="0"
          aria-valuemax=${this.capacity > 0 ? String(this.capacity) : "0"}
          aria-valuenow=${this.capacity > 0 ? String(this.booked) : "0"}
          aria-valuetext=${description}
        >
          <span
            class="capacity-row__fill capacity-row__fill--${this.tone}"
            style=${`width:${this.fill}%`}
          ></span>
        </div>
        ${
          time || this.meta
            ? html`<p class="capacity-row__meta">
                ${[time, this.meta].filter(Boolean).join(" · ")}
              </p>`
            : null
        }
      </div>
    `;
  }
}

defineOnce("caregrid-capacity-bar", CaregridCapacityBar);

declare global {
  interface HTMLElementTagNameMap {
    "caregrid-capacity-bar": CaregridCapacityBar;
  }
}
