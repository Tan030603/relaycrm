import { ref, watch } from 'vue';

export interface Session {
  accessToken: string;
  user: { id: string; name: string; email: string };
  tenant: { id: string; name: string; slug: string };
  role: 'owner' | 'rep';
}

export interface Contact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  createdAt: string;
}

const KEY = 'relaycrm.session';

// ponytail: the 15-minute access token lives in sessionStorage. Phase 2 adds a refresh
// token in an httpOnly cookie, so nothing long-lived ever sits where scripts can read it.
function load(): Session | null {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
}

export const session = ref<Session | null>(load());
watch(session, (s) => (s ? sessionStorage.setItem(KEY, JSON.stringify(s)) : sessionStorage.removeItem(KEY)));

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = session.value?.accessToken;
  const res = await fetch(`/api/v1${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) session.value = null; // expired: back to sign in
  if (!res.ok) {
    const e = data.error ?? {};
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? 'Something went wrong', e.details);
  }
  return data as T;
}
