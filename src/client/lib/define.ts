/** Registers a custom element exactly once, so importing a module twice is harmless. */
export function defineOnce(
  tag: string,
  element: CustomElementConstructor,
): void {
  if (typeof customElements === "undefined") {
    return;
  }
  if (customElements.get(tag) === undefined) {
    customElements.define(tag, element);
  }
}
