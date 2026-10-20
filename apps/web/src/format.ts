import type { Stage } from './api';

export const STAGES: Stage[] = ['new', 'qualified', 'proposal', 'negotiation', 'won'];
export const stageLabel = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const money = (n: number, currency = 'USD') => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${currency} ${Math.round(n).toLocaleString('en-US')}`;
  }
};

export function ago(d: string | Date) {
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const days = Math.floor(s / 86_400);
  return days === 1 ? 'yesterday' : days < 30 ? `${days} days ago` : new Date(d).toLocaleDateString();
}

export function inStage(d: string) {
  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
  return days < 1 ? 'today' : days === 1 ? '1 day' : days < 14 ? `${days} days` : `${Math.floor(days / 7)} weeks`;
}

export const when = (d: string) =>
  new Date(d).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

export const shortId = (id: string) => id.slice(-8);

export const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export const copy = (text: string) => navigator.clipboard.writeText(text);

export const TRIGGER_LABEL: Record<string, string> = {
  'lead.created': 'A new lead is created',
  'deal.stage_changed': 'A deal changes stage',
  'deal.idle': 'A deal sits in one stage for 7 days',
};
