// jsdom marks every dispatched event untrusted — which is exactly what the
// tracker now ignores, because a script's event is not a reader. A real
// browser marks a person's own input trusted, so tests that stand for a
// person have to say so.
//
// `isTrusted` is a non-configurable accessor on the event, so it cannot be
// redefined; it reads a field on jsdom's internal implementation object,
// which is reachable through the event's `impl` symbol. Setting that field
// is the only way to hand the tracker an event a real browser would call
// trusted.

// `dispatchEvent` itself sets isTrusted back to false, exactly as the DOM
// specification requires, so the field is pinned with a getter that ignores
// that write rather than simply assigned.
function markTrusted(event: Event): void {
  const implSymbol = Object.getOwnPropertySymbols(event).find((s) => s.description === 'impl');
  if (!implSymbol) throw new Error('jsdom event impl symbol not found');
  const impl = (event as unknown as Record<symbol, object>)[implSymbol]!;
  Object.defineProperty(impl, 'isTrusted', {
    configurable: true,
    get: () => true,
    set: () => {},
  });
  if (!event.isTrusted) throw new Error('could not mark the event trusted');
}

export function human(type: string, target: EventTarget = window): void {
  const event = new Event(type, { bubbles: true });
  markTrusted(event);
  target.dispatchEvent(event);
}

export function script(type: string, target: EventTarget = window): void {
  target.dispatchEvent(new Event(type, { bubbles: true }));
}
