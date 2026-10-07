import { html } from "lit";
import { CaregridElement } from "../lib/element.js";
import { defineOnce } from "../lib/define.js";
import type { StatusTone } from "../lib/status.js";

/** `<caregrid-metric-card>`: one headline number with a label and a supporting hint. */
export class CaregridMetricCard extends CaregridElement {
  static override properties = {
    label: { type: String },
    value: { type: String },
    hint: { type: String },
    tone: { type: String },
  };

  declare label: string;
  declare value: string;
  declare hint: string;
  declare tone: StatusTone;

  constructor() {
    super();
    this.label = "";
    this.value = "0";
    this.hint = "";
    this.tone = "neutral";
  }

  override render() {
    return html`
      <article class="metric-card metric-card--${this.tone}">
        <p class="metric-card__label">${this.label}</p>
        <p class="metric-card__value">${this.value}</p>
        ${this.hint ? html`<p class="metric-card__hint">${this.hint}</p>` : null}
      </article>
    `;
  }
}

defineOnce("caregrid-metric-card", CaregridMetricCard);

declare global {
  interface HTMLElementTagNameMap {
    "caregrid-metric-card": CaregridMetricCard;
  }
}
