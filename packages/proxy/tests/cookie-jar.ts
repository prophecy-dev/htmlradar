// A cookie jar for the worker tests.
//
// Hand-writing `cookie: name=value` into a request proves only that the test
// can copy a string. It cannot catch a cookie the worker never sent, a name it
// spelled differently, or a flow that silently depends on a value the browser
// would have discarded. This stores what the worker really sent and sends back
// what a browser really would, so the header the worker BUILDS and the header
// it PARSES are both exercised, and a multi-step flow — ask the question, then
// confirm it — runs the way it runs in a browser.
//
// Max-Age=0 and an empty value delete, as they do in a browser. Path, Domain
// and the `__Host-` rules are deliberately NOT enforced here: those are the
// browser's job, and the tests that care about them assert on the attributes
// of the Set-Cookie line itself rather than trusting this to model them.
export class Jar {
  private readonly store = new Map<string, string>();

  take(res: Response): Response {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(/;\s*/);
      const idx = pair!.indexOf('=');
      if (idx <= 0) continue;
      const name = pair!.slice(0, idx);
      const value = pair!.slice(idx + 1);
      const expired = attrs.some((a) => a.toLowerCase() === 'max-age=0');
      if (expired || value === '') this.store.delete(name);
      else this.store.set(name, value);
    }
    return res;
  }

  header(): Record<string, string> {
    if (this.store.size === 0) return {};
    return { cookie: [...this.store].map(([n, v]) => `${n}=${v}`).join('; ') };
  }

  get(name: string): string | null {
    return this.store.get(name) ?? null;
  }

  set(name: string, value: string): this {
    this.store.set(name, value);
    return this;
  }
}

// Read out of the rendered confirmation page rather than minted in the test,
// so the token under test is the same value a recipient's browser posts back.
export function tokenFrom(html: string): string {
  const match = /name="token" value="([^"]+)"/.exec(html);
  if (!match) throw new Error('no token in the confirmation page');
  return match[1]!;
}
