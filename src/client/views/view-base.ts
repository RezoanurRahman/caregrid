import { toApiError } from "../api.js";
import { CaregridElement } from "../lib/element.js";
import type { NoticeTone, ViewKey } from "../types.js";

/**
 * Shared behaviour for the four workspace views.
 *
 * Views are deliberately self-contained: each one loads its own data from the API, owns its
 * loading/empty/error states, and talks to the shell only through events. That keeps navigation
 * cheap and means a mutation in one view can never leave another view showing stale data.
 */
export abstract class CaregridView extends CaregridElement {
  /** Pushes a message to the shell's polite live region and its toast stack. */
  protected announce(message: string, tone: NoticeTone = "success"): void {
    this.dispatchEvent(
      new CustomEvent("caregrid:announce", {
        detail: { message, tone },
        bubbles: true,
        composed: true,
      }),
    );
  }

  protected navigate(view: ViewKey, intent = ""): void {
    this.dispatchEvent(
      new CustomEvent("caregrid:navigate", {
        detail: { view, intent },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Tells the shell that fresh data is on screen, so the context line can show "Updated …". */
  protected notifyRefreshed(): void {
    this.dispatchEvent(
      new CustomEvent("caregrid:refreshed", { bubbles: true, composed: true }),
    );
  }

  protected publishContext(detail: Record<string, string>): void {
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(detail)) {
      if (typeof value === "string" && value.trim() !== "") {
        cleaned[key] = value.trim();
      }
    }
    if (Object.keys(cleaned).length === 0) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("caregrid:context", {
        detail: cleaned,
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * Turns any thrown value into a readable sentence.
   *
   * Failures are rendered by the calling view in a `role="alert"` element, so this never announces
   * on its own: one failure is announced exactly once, assertively.
   */
  protected describeFailure(error: unknown, action: string): string {
    const apiError = toApiError(error, `We could not ${action}.`);
    return apiError.message.trim() !== ""
      ? apiError.message
      : `We could not ${action}.`;
  }

  /** True when the element is still connected and its request was not abandoned. */
  protected isCurrent(signal: AbortSignal): boolean {
    return this.isConnected && !signal.aborted;
  }
}
