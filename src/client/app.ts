import { html } from 'lit';
import { CaregridElement } from './lib/element.js';
import { defineOnce } from './lib/define.js';
import { formatFullDate, todayDateOnly } from './lib/format.js';
import './views/appointments-view.js';
import './views/clients-view.js';
import './views/followups-view.js';
import './views/overview-view.js';
import type { Notice, NoticeTone, ViewKey } from './types.js';

interface NavItem {
  key: ViewKey;
  label: string;
  testId: string;
  hint: string;
}

const NAV_ITEMS: NavItem[] = [
  {
    key: 'overview',
    label: 'Overview',
    testId: 'nav-overview',
    hint: 'Today at a glance',
  },
  {
    key: 'appointments',
    label: 'Appointments',
    testId: 'nav-appointments',
    hint: 'Calendar and visit status',
  },
  {
    key: 'clients',
    label: 'Clients',
    testId: 'nav-clients',
    hint: 'Roster, intake and records',
  },
  {
    key: 'followups',
    label: 'Follow-ups',
    testId: 'nav-followups',
    hint: 'Work owed to clients',
  },
];

const NOTICE_LIMIT = 3;
const NOTICE_TIMEOUT_MS = 7000;

interface ShellContext {
  clinicName: string;
  site: string;
  date: string;
  updatedAt: string;
}

/**
 * `<caregrid-app>`: the persistent clinic shell.
 *
 * It owns the wordmark, the primary navigation, the compact clinic/date context line, the single
 * polite live region for action feedback (also rendered as dismissible toasts) and the skip link.
 * Views stay independent: they announce outcomes, publish context and ask for navigation through
 * bubbling events, so the shell never needs to know how a view loads its data.
 */
export class CaregridApp extends CaregridElement {
  static override properties = {
    view: { state: true },
    intent: { state: true },
    context: { state: true },
    notices: { state: true },
  };

  declare view: ViewKey;
  declare intent: string;
  declare context: ShellContext;
  declare notices: Notice[];

  private noticeSeq = 0;
  private navigated = false;
  private noticeTimers = new Map<string, number>();

  constructor() {
    super();
    this.view = 'overview';
    this.intent = '';
    this.context = {
      clinicName: 'Caregrid Community Clinic',
      site: '',
      date: todayDateOnly(),
      updatedAt: '',
    };
    this.notices = [];
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const timer of this.noticeTimers.values()) {
      window.clearTimeout(timer);
    }
    this.noticeTimers.clear();
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has('view') && this.navigated) {
      window.requestAnimationFrame(() => {
        const heading = this.querySelector<HTMLElement>('main h1');
        heading?.focus();
      });
    }
  }

  private go(view: ViewKey, intent = ''): void {
    this.navigated = true;
    this.view = view;
    this.intent = intent;
    document.title = `${NAV_ITEMS.find((item) => item.key === view)?.label ?? 'Overview'} · Caregrid`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  private handleNavigate(event: CustomEvent<{ view?: ViewKey; intent?: string }>): void {
    event.stopPropagation();
    const view = event.detail?.view;
    if (!view || !NAV_ITEMS.some((item) => item.key === view)) {
      return;
    }
    this.go(view, event.detail?.intent ?? '');
  }

  private handleAnnounce(event: CustomEvent<{ message?: string; tone?: NoticeTone }>): void {
    event.stopPropagation();
    const message = (event.detail?.message ?? '').trim();
    if (message === '') {
      return;
    }
    this.pushNotice(message, event.detail?.tone ?? 'success');
  }

  private handleContext(event: CustomEvent<Record<string, string>>): void {
    event.stopPropagation();
    const detail = event.detail ?? {};
    this.context = {
      clinicName: detail.clinicName || this.context.clinicName,
      site: detail.site ?? this.context.site,
      date: detail.date || this.context.date,
      updatedAt: this.context.updatedAt,
    };
  }

  private handleRefreshed(event: Event): void {
    event.stopPropagation();
    const now = new Date();
    this.context = {
      ...this.context,
      updatedAt: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    };
  }

  private pushNotice(message: string, tone: NoticeTone): void {
    this.noticeSeq += 1;
    const id = `notice-${this.noticeSeq}`;
    const notices = [...this.notices, { id, message, tone }].slice(-NOTICE_LIMIT);
    for (const stale of this.notices) {
      if (!notices.some((notice) => notice.id === stale.id)) {
        this.clearNoticeTimer(stale.id);
      }
    }
    this.notices = notices;
    const timer = window.setTimeout(() => this.dismissNotice(id), NOTICE_TIMEOUT_MS);
    this.noticeTimers.set(id, timer);
  }

  private clearNoticeTimer(id: string): void {
    const timer = this.noticeTimers.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.noticeTimers.delete(id);
    }
  }

  private dismissNotice(id: string): void {
    this.clearNoticeTimer(id);
    this.notices = this.notices.filter((notice) => notice.id !== id);
  }

  private renderNav() {
    return html`
      <nav class="nav" aria-label="Primary">
        ${NAV_ITEMS.map(
          (item) => html`
            <button
              class="nav__button${this.view === item.key ? ' is-active' : ''}"
              type="button"
              data-testid=${item.testId}
              aria-current=${this.view === item.key ? 'page' : 'false'}
              title=${item.hint}
              @click=${() => this.go(item.key)}
            >
              ${item.label}
            </button>
          `,
        )}
      </nav>
    `;
  }

  private renderContextLine() {
    const parts = [this.context.site, formatFullDate(this.context.date)].filter(
      (part) => part.trim() !== '',
    );
    return html`
      <p class="context-line">
        <span class="context-line__clinic">${this.context.clinicName}</span>
        <span class="context-line__sep" aria-hidden="true">·</span>
        <span class="context-line__part">${parts.join(' · ')}</span>
        ${
          this.context.updatedAt
            ? html`<span class="context-line__updated">Updated ${this.context.updatedAt}</span>`
            : null
        }
      </p>
    `;
  }

  private renderView() {
    switch (this.view) {
      case 'appointments':
        return html`<caregrid-appointments-view
          .intent=${this.intent}
        ></caregrid-appointments-view>`;
      case 'clients':
        return html`<caregrid-clients-view .intent=${this.intent}></caregrid-clients-view>`;
      case 'followups':
        return html`<caregrid-followups-view></caregrid-followups-view>`;
      default:
        return html`<caregrid-overview-view></caregrid-overview-view>`;
    }
  }

  override render() {
    return html`
      <a class="skip-link" href="#main-content">Skip to main content</a>
      <div
        class="app-shell"
        @caregrid:navigate=${this.handleNavigate}
        @caregrid:announce=${this.handleAnnounce}
        @caregrid:context=${this.handleContext}
        @caregrid:refreshed=${this.handleRefreshed}
      >
        <header class="app-header">
          <div class="app-header__bar">
            <p class="wordmark">
              <svg class="wordmark__mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <rect x="9" y="2" width="6" height="20" rx="2"></rect>
                <rect x="2" y="9" width="20" height="6" rx="2"></rect>
              </svg>
              <span class="wordmark__text">Caregrid</span>
              <span class="wordmark__tagline">Community clinic desk</span>
            </p>
            ${this.renderNav()}
          </div>
          ${this.renderContextLine()}
        </header>
        <main class="app-main" id="main-content" tabindex="-1">${this.renderView()}</main>
        <footer class="app-footer">
          <p>
            Caregrid runs locally: client records, appointments and follow-ups are stored on this
            machine and served from the
            <code>/api</code> endpoints.
          </p>
        </footer>
        <div class="toast-region" role="status" aria-live="polite" data-testid="toast-region">
          ${this.notices.map(
            (notice) => html`
              <div class="toast toast--${notice.tone}" data-testid="toast">
                <p class="toast__message">${notice.message}</p>
                <button
                  class="button button--ghost button--small"
                  type="button"
                  @click=${() => this.dismissNotice(notice.id)}
                >
                  Dismiss
                </button>
              </div>
            `,
          )}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'caregrid-app': CaregridApp;
  }
}

// Both registrations are idempotent, so importing this module twice is safe.
defineOnce('caregrid-app', CaregridApp);
