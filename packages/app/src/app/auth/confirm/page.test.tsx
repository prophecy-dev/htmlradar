// The confirmation page is the whole fix, so what it must not do matters more
// than what it looks like: rendering it may not touch Supabase, and the token
// may leave only through a form the person submits.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const redirected = vi.hoisted(() => ({ to: [] as string[] }));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    redirected.to.push(url);
    // Next's own redirect() throws to unwind the render; mirror that so the
    // component below it never runs.
    throw new Error('NEXT_REDIRECT');
  },
}));
vi.mock('@/components/HeroRadar', () => ({ HeroRadar: () => null }));
// Unmocked, this would be the one import that reaches Supabase from a GET.
vi.mock('@/lib/supabase-server', () => ({
  serverClient: () => {
    throw new Error('the confirmation page must not talk to Supabase on a GET');
  },
}));

import ConfirmSignInPage from './page';

const render = (searchParams: { token_hash?: string; next?: string }) =>
  renderToStaticMarkup(<ConfirmSignInPage searchParams={searchParams} />);

describe('rendering the page', () => {
  it('shows one button that POSTs the token, and never verifies it itself', () => {
    const html = render({ token_hash: 'h1' });
    expect(html).toContain('action="/auth/callback"');
    expect(html).toContain('method="post"');
    expect(html).toContain('name="token_hash"');
    expect(html).toContain('value="h1"');
    expect(html).toContain('Continue to HTMLRadar');
    // One submit, so there is nothing to press by accident.
    expect(html.match(/type="submit"/g)).toHaveLength(1);
  });

  it('needs no client JavaScript', () => {
    expect(render({ token_hash: 'h1' })).not.toContain('<script');
  });

  it('carries a staged-handoff destination through as a hidden field', () => {
    const html = render({ token_hash: 'h1', next: '/convert?resume=abc' });
    expect(html).toContain('name="next"');
    expect(html).toContain('value="/convert?resume=abc"');
  });

  it('collapses an off-site destination rather than passing it on', () => {
    const html = render({ token_hash: 'h1', next: '//evil.com' });
    expect(html).not.toContain('evil.com');
    // /docs is the default and is left out of the form entirely.
    expect(html).not.toContain('name="next"');
  });
});

describe('reaching the page with no link', () => {
  it('sends the person to sign-in, keeping a real destination', () => {
    redirected.to = [];
    expect(() => render({})).toThrow('NEXT_REDIRECT');
    expect(redirected.to).toEqual(['/sign-in']);

    redirected.to = [];
    expect(() => render({ next: '/convert?resume=abc' })).toThrow('NEXT_REDIRECT');
    expect(redirected.to).toEqual(['/sign-in?next=%2Fconvert%3Fresume%3Dabc']);
  });
});
