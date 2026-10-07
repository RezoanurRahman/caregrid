import { html } from 'lit';
import { CaregridElement } from '../lib/element.js';
import { defineOnce } from '../lib/define.js';
import type { StatusTone } from '../lib/status.js';

/**
 * `<caregrid-status-badge label="Confirmed" tone="success" detail="…">`
 *
 * The tone is never the only signal: the badge always carries its text label, and the optional
 * `detail` becomes the accessible description.
 */
export class CaregridStatusBadge extends CaregridElement {
  static override properties = {
    label: { type: String },
    tone: { type: String },
    detail: { type: String },
    size: { type: String },
  };

  declare label: string;
  declare tone: StatusTone;
  declare detail: string;
  declare size: string;

  constructor() {
    super();
    this.label = '';
    this.tone = 'neutral';
    this.detail = '';
    this.size = 'regular';
  }

  override render() {
    const className = `badge badge--${this.tone}${this.size === 'small' ? ' badge--small' : ''}`;
    return html`
      <span class=${className} title=${this.detail || undefined}>
        <span class="badge__dot" aria-hidden="true"></span>
        ${this.label}
      </span>
    `;
  }
}

defineOnce('caregrid-status-badge', CaregridStatusBadge);

declare global {
  interface HTMLElementTagNameMap {
    'caregrid-status-badge': CaregridStatusBadge;
  }
}
