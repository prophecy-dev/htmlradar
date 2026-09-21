import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { LogOut } from 'lucide-react';
import {
  OwnerError,
  getProfile,
  insertApiKey,
  listApiKeys,
  revokeApiKey,
  updateProfile,
} from '@htmlradar/db/owner';
import { requireUser } from '@/lib/auth';
import { db } from '@/lib/cf';
import { SectionMark } from '@/components/SectionMark';
import { apiKeyPrefix, generateApiKey, hashApiKey } from '@/lib/api-auth';
import { ApiKeys, type ApiKeyRow } from './ApiKeys';

// A key is generated, hashed, and the hash is what is written. The plaintext
// exists only in this function's return value and in the browser tab that
// asked for it — there is deliberately no way to read it back afterwards.
async function createApiKeyAction(
  label: string,
  scope: 'full' | 'read_only' = 'full',
): Promise<{ ok: boolean; key?: string; error?: string }> {
  'use server';
  const user = await requireUser();
  const cleanLabel = label.trim().slice(0, 60) || 'API key';
  // Anything that is not exactly 'full' makes the weaker key.
  const cleanScope = scope === 'full' ? 'full' : 'read_only';
  const key = generateApiKey();
  try {
    await insertApiKey(db(), user.id, {
      key_hash: await hashApiKey(key),
      key_prefix: apiKeyPrefix(key),
      label: cleanLabel,
      scope: cleanScope,
    });
  } catch (e) {
    if (e instanceof OwnerError) return { ok: false, error: e.message };
    console.error('[settings] api key create failed', e);
    return { ok: false, error: 'Could not create the key. Try again.' };
  }
  return { ok: true, key };
}

async function revokeApiKeyAction(id: string): Promise<{ ok: boolean; error?: string }> {
  'use server';
  const user = await requireUser();
  try {
    await revokeApiKey(db(), user.id, id);
    return { ok: true };
  } catch (e) {
    console.error('[settings] api key revoke failed', e);
    return { ok: false, error: 'Could not revoke the key. Try again.' };
  }
}

const IANA_TZ_REGEX = /^[A-Za-z][A-Za-z0-9+_-]*(\/[A-Za-z0-9+_-]+){0,2}$/;

async function saveProfileAction(formData: FormData) {
  'use server';
  const user = await requireUser();
  const timezone = String(formData.get('timezone') ?? '').trim();
  const chatId = String(formData.get('telegram_chat_id') ?? '').trim();

  let error: string | null = null;
  if (timezone && !IANA_TZ_REGEX.test(timezone)) {
    error = 'Timezone must be an IANA name such as Europe/Berlin.';
  } else if (chatId && !/^-?\d{1,20}$/.test(chatId)) {
    error = 'The Telegram chat id is a number (group ids start with a minus sign).';
  } else {
    await updateProfile(db(), user.id, {
      ...(timezone ? { timezone } : {}),
      telegram_chat_id: chatId || null,
    });
    revalidatePath('/settings');
  }
  redirect(error ? `/settings?error=${encodeURIComponent(error)}` : '/settings?saved=1');
}

export default async function SettingsPage(props: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const searchParams = await props.searchParams;
  const user = await requireUser();
  const d = db();
  const [profile, keys] = await Promise.all([getProfile(d, user.id), listApiKeys(d, user.id)]);
  const keyRows: ApiKeyRow[] = keys.map((k) => ({
    id: k.id,
    label: k.label,
    key_prefix: k.key_prefix,
    created_at: k.created_at,
    last_used_at: k.last_used_at,
    revoked_at: k.revoked_at,
  }));
  const accountCreated = new Date(profile?.created_at ?? user.created_at).toLocaleDateString(
    undefined,
    { year: 'numeric', month: 'long', day: 'numeric' },
  );

  return (
    <div className="py-8">
      <SectionMark>Settings</SectionMark>
      <h1 className="text-letterpress mt-4 font-serif text-[36px] font-normal leading-[1.06] tracking-tightest text-ink md:text-[44px]">
        Your account.
      </h1>

      {searchParams?.saved === '1' && (
        <div
          role="status"
          className="mt-6 rounded-md border border-signal/30 bg-signal/5 px-4 py-3 text-[14px] text-signal-dark"
        >
          Saved.
        </div>
      )}
      {searchParams?.error && (
        <div
          role="alert"
          className="mt-6 rounded-md border border-alert/40 bg-alert/5 px-4 py-3 text-[14px] text-alert"
        >
          {searchParams.error}
        </div>
      )}

      <dl className="mt-10 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-paper">
        <Row label="Email" value={profile?.email ?? user.email} />
        <Row label="Signed in with" value="Cloudflare Access" />
        <Row label="Account created" value={accountCreated} />
      </dl>

      <section className="mt-10 rounded-2xl border border-line bg-paper px-5 py-5">
        <h2 className="font-serif text-[20px] text-ink">Alerts</h2>
        <form action={saveProfileAction} className="mt-4 grid max-w-xl gap-5">
          <label className="grid gap-1.5">
            <span className="text-[12.5px] font-medium text-ink">Timezone</span>
            <input
              name="timezone"
              defaultValue={profile?.timezone ?? 'UTC'}
              placeholder="Europe/Berlin"
              className="rounded-md border border-line bg-paper px-3 py-2 font-mono text-[13.5px] text-ink focus:outline-none focus:ring-1 focus:ring-signal"
            />
            <span className="text-[12px] text-graphite">
              Times in first-read alerts use this. It is set from your browser automatically.
            </span>
          </label>
          <label className="grid gap-1.5">
            <span className="text-[12.5px] font-medium text-ink">Telegram chat id</span>
            <input
              name="telegram_chat_id"
              defaultValue={profile?.telegram_chat_id ?? ''}
              inputMode="numeric"
              placeholder="123456789"
              className="rounded-md border border-line bg-paper px-3 py-2 font-mono text-[13.5px] text-ink focus:outline-none focus:ring-1 focus:ring-signal"
            />
            <span className="text-[12px] leading-relaxed text-graphite">
              Where first-read alerts go. Send any message to the team’s alert bot first (a bot can
              only write to chats that have spoken to it), then get your numeric id from
              @userinfobot. For a group, add the bot to the group and use the group’s id, which
              starts with a minus sign. Leave empty to turn alerts off.
            </span>
          </label>
          <div>
            <button
              type="submit"
              className="rounded-md bg-ink px-4 py-2 text-[13px] font-medium text-paper hover:bg-ink/90"
            >
              Save
            </button>
          </div>
        </form>
      </section>

      <ApiKeys keys={keyRows} createAction={createApiKeyAction} revokeAction={revokeApiKeyAction} />

      <div className="mt-12 border-t border-line pt-8">
        {/* Cloudflare Access owns the session; its logout endpoint ends it. */}
        <a
          href="/cdn-cgi/access/logout"
          className="inline-flex items-center gap-2 rounded-md border border-line bg-paper px-4 py-2.5 font-mono text-[12px] uppercase tracking-[0.16em] text-graphite transition hover:border-alert hover:text-alert"
        >
          <LogOut className="size-3.5" />
          Sign out
        </a>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | React.ReactNode }) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-x-8 gap-y-1 px-5 py-4 sm:grid-cols-[200px_1fr]">
      <dt className="font-mono text-[11px] uppercase tracking-[0.16em] text-graphite">{label}</dt>
      <dd className="text-[14.5px] text-ink">{value}</dd>
    </div>
  );
}
