import { html } from 'lit';
import { CaregridElement } from '../lib/element.js';
import { defineOnce } from '../lib/define.js';

export type StatePanelVariant = 'loading' | 'empty' | 'error' | 'info';

/**
 * `<caregrid-state-panel>`: the shared loading / empty / error / info block.
 *
 * Loading renders a skeleton with a real status message, empty and error states offer a labelled
 * action button, and the panel dispatches `caregrid:panel-action` so the owning view decides what
 * retry means.
 */
export class CaregridStatePanel extends CaregridElement {
  static override properties = {
    variant: { type: String },
    title: { type: String },
    message: { type: String },
    actionLabel: { type: String },
    rows: { type: Number },
    action: { type: String },
  };

  declare variant: StatePanelVariant;
  declare title: string;
  declare message: string;
  declare actionLabel: string;
  declare rows: number;
  declare action: string;

  constructor() {
    super();
    this.variant = 'info';
    this.title = '';
    this.message = '';
    this.actionLabel = '';
    this.rows = 3;
    this.action = '';
  }

  private emitAction(): void {
    this.dispatchEvent(
      new CustomEvent('caregrid:panel-action', {
        detail: { action: this.action },
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    if (this.variant === 'loading') {
      const rows = Math.max(1, Math.min(8, this.rows));
      return html`
        <div class="state-panel state-panel--loading" role="status" aria-live="polite">
          <p class="state-panel__title">${this.title || 'Loading clinic data…'}</p>
          ${this.message ? html`<p class="state-panel__message">${this.message}</p>` : null}
          <div class="skeleton-stack" aria-hidden="true">
            ${Array.from({ length: rows }, () => html`<span class="skeleton"></span>`)}
          </div>
        </div>
      `;
    }

    const role = this.variant === 'error' ? 'alert' : 'status';
    const icon = this.variant === 'error' ? '!' : this.variant === 'empty' ? '—' : 'i';
    return html`
      <div class="state-panel state-panel--${this.variant}" role=${role}>
        <p class="state-panel__icon" aria-hidden="true">${icon}</p>
        <p class="state-panel__title">${this.title}</p>
        ${this.message ? html`<p class="state-panel__message">${this.message}</p>` : null}
        ${
          this.actionLabel
            ? html`
                <button class="button button--secondary" type="button" @click=${this.emitAction}>
                  ${this.actionLabel}
                </button>
              `
            : null
        }
      </div>
    `;
  }
}

defineOnce('caregrid-state-panel', CaregridStatePanel);

declare global {
  interface HTMLElementTagNameMap {
    'caregrid-state-panel': CaregridStatePanel;
  }
}
