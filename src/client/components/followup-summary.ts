import { html } from 'lit';
import { CaregridElement } from '../lib/element.js';
import { defineOnce } from '../lib/define.js';
import {
  followUpDueText,
  followUpStatusLabel,
  followUpStatusTone,
  isFollowUpOverdue,
  priorityLabel,
  priorityTone,
} from '../lib/status.js';
import type { FollowUp } from '../types.js';
import './status-badge.js';

/** Read-only follow-up row used by the Overview preview and the client detail. */
export class CaregridFollowUpSummary extends CaregridElement {
  static override properties = {
    followUp: { attribute: false },
    showClient: { type: Boolean },
    today: { type: String },
  };

  declare followUp: FollowUp | null;
  declare showClient: boolean;
  declare today: string;

  constructor() {
    super();
    this.followUp = null;
    this.showClient = true;
    this.today = '';
  }

  override render() {
    const followUp = this.followUp;
    if (!followUp) {
      return null;
    }
    const overdue = isFollowUpOverdue(followUp, this.today || undefined);
    const meta = [
      this.showClient ? followUp.clientName : '',
      followUp.assignee ? `Owner: ${followUp.assignee}` : '',
    ]
      .filter((part) => part.trim() !== '')
      .join(' · ');
    return html`
      <div
        class="summary-row summary-row--followup${overdue ? ' is-overdue' : ''}"
        role="listitem"
        data-testid=${`followup-summary-${followUp.id}`}
      >
        <div class="summary-row__body">
          <p class="summary-row__title">${followUp.title}</p>
          <p class="summary-row__meta">
            <span class=${overdue ? 'text-danger' : 'muted'}>
              ${followUpDueText(followUp, this.today || undefined)}
            </span>
            ${meta ? html`<span class="muted"> · ${meta}</span>` : null}
          </p>
        </div>
        <p class="summary-row__badges">
          <caregrid-status-badge
            label=${priorityLabel(followUp.priority, followUp.rawPriority)}
            tone=${priorityTone(followUp.priority)}
            size="small"
          ></caregrid-status-badge>
          <caregrid-status-badge
            label=${followUpStatusLabel(followUp.status, followUp.rawStatus)}
            tone=${followUpStatusTone(followUp.status)}
            size="small"
          ></caregrid-status-badge>
        </p>
      </div>
    `;
  }
}

defineOnce('caregrid-followup-summary', CaregridFollowUpSummary);

declare global {
  interface HTMLElementTagNameMap {
    'caregrid-followup-summary': CaregridFollowUpSummary;
  }
}
