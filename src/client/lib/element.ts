import { LitElement } from 'lit';

/**
 * Base class for every Caregrid element.
 *
 * The client renders into the light DOM on purpose: one shared stylesheet drives the responsive
 * layout, page level CSS (print, mobile breakpoints, focus rings) applies to every element, and
 * DOM tooling or tests can query the rendered markup without piercing shadow roots. Elements own
 * their markup through Lit templates, so no `innerHTML` is ever assigned by hand.
 */
export abstract class CaregridElement extends LitElement {
  protected override createRenderRoot(): HTMLElement {
    return this as unknown as HTMLElement;
  }
}
