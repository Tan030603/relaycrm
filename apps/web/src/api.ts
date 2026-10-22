import { ref } from 'vue';

export type Role = 'owner' | 'rep';
export type Stage = 'new' | 'qualified' | 'proposal' | 'negotiation' | 'won';

export interface Session {
  accessToken: string;
  user: { id: string; name: string; email: string };
  tenant: { id: string; name: string; slug: string };
  role: Role;
}

export interface Contact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  source: string | null;
  ownerId: string | null;
  createdAt: string;
}

export interface Deal {
  id: string;
  title: string;
  value: number;
  currency: string;
  stage: Stage;
  contactId: string | null;
  ownerId: string | null;
  expectedCloseDate: string | null;
  stageChangedAt: string;
  contact?: { name: string; company: string | null } | null;
  ruleTask?: boolean;
}

export interface Task {
  id: string;
  title: string;
  dueAt: string | null;
  status: 'open' | 'done';
  assigneeId: string | null;
  dealId: string | null;
  createdByRuleId: string | null;
}

export interface Activity {
  id: string;
  type: string;
  note: string;
  dealId: string | null;
  contactId: string | null;
  actorId: string | null;
  occurredAt: string;
}

export interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: string;
}

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'retrying';

/** Access token lives only in memory; the refresh token is an httpOnly cookie scoped to /api/v1/auth. */
export const session = ref<Session | null>(null);

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

export const errorText = (e: unknown) =>
  e instanceof ApiError && e.details?.length
    ? e.details.map((d) => (d.path ? `${d.path}: ${d.message}` : d.message)).join(' · ')
    : e instanceof Error
      ? e.message
      : 'Something went wrong';

let refreshing: Promise<boolean> | null = null;

/** Single-flight: concurrent 401s share one refresh, so the rotating cookie is used once. */
export function refresh() {
  refreshing ??= fetch('/api/v1/auth/refresh', { method: 'POST' })
    .then(async (res) => {
      session.value = res.ok ? await res.json() : null;
      return res.ok;
    })
    .catch(() => false)
    .finally(() => (refreshing = null));
  return refreshing;
}

export async function logout() {
  await fetch('/api/v1/auth/logout', { method: 'POST' }).catch(() => {});
  session.value = null;
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}, retried = false): Promise<T> {
  const token = session.value?.accessToken;
  const res = await fetch(`/api/v1${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (res.status === 401 && token && !retried && !path.startsWith('/auth/')) {
    if (await refresh()) return api<T>(path, opts, true);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error ?? {};
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? 'Something went wrong', e.details);
  }
  return data as T;
}
