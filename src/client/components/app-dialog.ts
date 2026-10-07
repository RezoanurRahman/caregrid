import { css, html, LitElement } from 'lit';
import { defineOnce } from '../lib/define.js';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  "[tabindex]:not([tabindex='-1'])",
].join(',');

/**
 * `<caregrid-dialog>`: an accessible modal.
 *
 * Keyboard rules: Escape closes, Tab cycles inside the panel, focus moves into the panel when it
 * opens and returns to the trigger when it closes. Closing is always possible through the labelled
 * "Close" button, so the backdrop is never the only way out. The panel uses a slot, which keeps
 * the form markup in the light DOM where labels, ids and test ids behave normally.
 */
export class CaregridDialog extends LitElement {
  static override properties = {
    open: { type: Boolean, reflect: true },
    label: { type: String },
    headingId: { type: String },
    size: { type: String },
  };

  static override styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: block;
    }
    :host([hidden]) {
      display: none;
    }
    .dialog__backdrop {
      position: absolute;
      inset: 0;
      background: rgba(19, 43, 74, 0.45);
      backdrop-filter: blur(2px);
    }
    .dialog__panel {
      position: relative;
      margin: min(6vh, 48px) auto;
      width: min(640px, calc(100vw - 32px));
      max-height: min(86vh, 900px);
      display: flex;
      flex-direction: column;
      background: var(--cg-surface, #fff);
      border-radius: var(--cg-radius, 16px);
      box-shadow: 0 24px 60px -24px rgba(19, 43, 74, 0.55);
      outline: none;
    }
    .dialog__panel--wide {
      width: min(820px, calc(100vw - 32px));
    }
    .dialog__header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 20px 12px;
      border-bottom: 1px solid var(--cg-line, #e4dbcd);
    }
    .dialog__eyebrow {
      margin: 0;
      font-size: 0.75rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--cg-muted, #5f6f80);
    }
    .dialog__close {
      flex: none;
      font: inherit;
      font-size: 0.875rem;
      padding: 6px 12px;
      border-radius: 999px;
      border: 1px solid var(--cg-line, #e4dbcd);
      background: var(--cg-cream-2, #f4ece0);
      color: var(--cg-navy, #132b4a);
      cursor: pointer;
    }
    .dialog__close:hover {
      background: #ece1d0;
    }
    .dialog__body {
      padding: 20px;
      overflow: auto;
    }
    :host([data-mobile='true']) .dialog__panel {
      margin: 0;
      width: 100vw;
      max-height: 100vh;
      height: 100%;
      border-radius: 0;
    }
    @media (max-width: 640px) {
      .dialog__panel {
        margin: 0;
        width: 100vw;
        max-height: 100vh;
        height: 100%;
        border-radius: 0;
      }
    }
  `;

  declare open: boolean;
  declare label: string;
  declare headingId: string;
  declare size: string;

  private restoreFocus: HTMLElement | null = null;

  constructor() {
    super();
    this.open = false;
    this.label = 'Dialog';
    this.headingId = '';
    this.size = 'regular';
  }

  private focusable(): HTMLElement[] {
    const shadow = this.shadowRoot
      ? Array.from(this.shadowRoot.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      : [];
    const light = Array.from(this.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    return [...shadow, ...light].filter(
      (element) => element.offsetParent !== null || element === document.activeElement,
    );
  }

  private focusFirst(): void {
    const items = this.focusable();
    const target = items[0] ?? this.shadowRoot?.querySelector<HTMLElement>('.dialog__panel');
    target?.focus();
  }

  override updated(changed: Map<string, unknown>): void {
    if (!changed.has('open')) {
      return;
    }
    if (this.open) {
      this.restoreFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      window.requestAnimationFrame(() => this.focusFirst());
    } else {
      this.restoreFocus?.focus();
      this.restoreFocus = null;
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.open) {
      this.restoreFocus?.focus();
      this.restoreFocus = null;
    }
  }

  private requestClose(): void {
    this.open = false;
    this.dispatchEvent(
      new CustomEvent('caregrid:dialog-close', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.requestClose();
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const items = this.focusable();
    if (items.length === 0) {
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !this.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !this.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  override render() {
    if (!this.open) {
      return null;
    }
    return html`
      <div class="dialog__backdrop" aria-hidden="true"></div>
      <div
        class="dialog__panel${this.size === 'wide' ? ' dialog__panel--wide' : ''}"
        role="dialog"
        aria-modal="true"
        aria-label=${this.headingId ? undefined : this.label}
        aria-labelledby=${this.headingId || undefined}
        tabindex="-1"
        @keydown=${this.handleKeydown}
      >
        <header class="dialog__header">
          <p class="dialog__eyebrow">${this.label}</p>
          <button class="dialog__close" type="button" @click=${this.requestClose}>Close</button>
        </header>
        <div class="dialog__body"><slot></slot></div>
      </div>
    `;
  }
}

defineOnce('caregrid-dialog', CaregridDialog);

declare global {
  interface HTMLElementTagNameMap {
    'caregrid-dialog': CaregridDialog;
  }
}
