<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api, errorText, session, type Activity, type Deal, type Task } from '../api';
import { ago, money, reducedMotion } from '../format';

interface Today {
  kpis: {
    pipeline: { value: number; deals: number; movedToday: number };
    won: { value: number; deals: number };
    tasks: { due: number; fromRules: number };
    runs: { total: number; failed: number; succeeded: number };
  };
  tasks: Task[];
  quiet: (Deal & { daysQuiet: number })[];
  feed: Activity[];
  chart: { day: string; total: number; ok: number }[];
}

const data = ref<Today>();
const error = ref('');
const t = ref(0);
const done = ref(new Set<string>());

const hour = new Date().getHours();
const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
const dateLine = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const firstName = computed(() => session.value?.user.name.split(' ')[0]);

const n = (v: number) => Math.round(v * (1 - Math.pow(1 - t.value, 3)));

const bars = computed(() => {
  const byDay = new Map((data.value?.chart ?? []).map((c) => [new Date(c.day).toISOString().slice(0, 10), c]));
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() - (6 - i) * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    return { key, label: d.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }), total: byDay.get(key)?.total ?? 0, ok: byDay.get(key)?.ok ?? 0 };
  });
  const max = Math.max(1, ...days.map((d) => d.total));
  return days.map((d) => ({ ...d, h: Math.max(2, (d.total / max) * 110) }));
});
const okRate = computed(() => {
  const total = bars.value.reduce((s, b) => s + b.total, 0);
  return total ? Math.round((bars.value.reduce((s, b) => s + b.ok, 0) / total) * 100) : null;
});

const feedIcon: Record<string, [string, string]> = {
  automation: ['M13 2L4 14h7l-1 8 9-12h-7z', 'auto'],
  email: ['M4 4h16v16H4zM22 6l-10 7L2 6', 'mail'],
  call: ['M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7l.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4l2.8.7a2 2 0 0 1 1.7 2z', 'call'],
  stage_changed: ['M5 12h14M13 6l6 6-6 6', 'move'],
  form: ['M8 8h8M8 12h8M8 16h5M5 3h14v18H5z', 'form'],
};
const icon = (type: string) => feedIcon[type] ?? ['M4 6h16M4 12h10M4 18h7', 'note'];

async function load() {
  try {
    data.value = await api<Today>('/today');
    error.value = '';
  } catch (e) {
    error.value = errorText(e);
  }
}

let raf = 0;
let poll: ReturnType<typeof setInterval>;
onMounted(async () => {
  await load();
  if (reducedMotion()) t.value = 1;
  else {
    const start = performance.now();
    const step = (now: number) => {
      t.value = Math.min(1, (now - start) / 1100);
      if (t.value < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  poll = setInterval(async () => {
    const fresh = await api<Today>('/today').catch(() => null);
    if (fresh && data.value) Object.assign(data.value, { feed: fresh.feed, kpis: fresh.kpis, chart: fresh.chart });
  }, 30_000);
});
onUnmounted(() => {
  cancelAnimationFrame(raf);
  clearInterval(poll);
});

async function complete(task: Task) {
  done.value.add(task.id);
  try {
    await api(`/tasks/${task.id}`, { method: 'PATCH', body: { status: 'done' } });
    setTimeout(() => {
      if (!data.value) return;
      data.value.tasks = data.value.tasks.filter((x) => x.id !== task.id);
      data.value.kpis.tasks.due--;
    }, 600);
  } catch (e) {
    done.value.delete(task.id);
    error.value = errorText(e);
  }
}
</script>

<template>
  <div class="page">
    <div>
      <p class="muted date">{{ dateLine }}</p>
      <h1>{{ greeting }}, {{ firstName }}</h1>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="!data && !error" class="muted" aria-live="polite">Loading your day…</p>

    <template v-if="data">
      <div class="kpis">
        <div class="kpi accent rise">
          <span class="label">Open pipeline</span>
          <span class="num mono">{{ money(n(data.kpis.pipeline.value)) }}</span>
          <span class="small">{{ data.kpis.pipeline.deals }} deals · {{ data.kpis.pipeline.movedToday }} moved today</span>
        </div>
        <div class="kpi rise" style="animation-delay: 80ms">
          <span class="label">Won this month</span>
          <span class="num mono won">{{ money(n(data.kpis.won.value)) }}</span>
          <span class="small muted">{{ data.kpis.won.deals }} deal{{ data.kpis.won.deals === 1 ? '' : 's' }} closed</span>
        </div>
        <div class="kpi rise" style="animation-delay: 160ms">
          <span class="label">Due today</span>
          <span class="num mono">{{ n(data.kpis.tasks.due) }} task{{ data.kpis.tasks.due === 1 ? '' : 's' }}</span>
          <span class="small muted">{{ data.kpis.tasks.fromRules }} created by your rules</span>
        </div>
        <div class="kpi rise" style="animation-delay: 240ms">
          <span class="label">Automation runs (24 h)</span>
          <span class="num mono">{{ n(data.kpis.runs.total) }}</span>
          <RouterLink v-if="data.kpis.runs.failed" to="/runs" class="small failed">{{ data.kpis.runs.failed }} failed, need you</RouterLink>
          <span v-else class="small muted">No failures</span>
        </div>
      </div>

      <div class="cols">
        <div class="col wide">
          <section class="card rise" style="animation-delay: 320ms" aria-labelledby="tasks-h">
            <div class="head">
              <h2 id="tasks-h">My tasks today</h2>
              <RouterLink to="/tasks">All tasks</RouterLink>
            </div>
            <p v-if="!data.tasks.length" class="muted">Nothing due today. Enjoy it.</p>
            <ul class="tasks">
              <li v-for="task in data.tasks" :key="task.id" :class="{ done: done.has(task.id) }">
                <input :id="`t-${task.id}`" type="checkbox" :checked="done.has(task.id)" :disabled="done.has(task.id)" @change="complete(task)" />
                <label :for="`t-${task.id}`">{{ task.title }}</label>
                <span v-if="task.createdByRuleId" class="pill">⚡ From rule</span>
                <span class="mono small">{{ task.dueAt ? new Date(task.dueAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '' }}</span>
              </li>
            </ul>
          </section>

          <section class="card rise quiet" style="animation-delay: 440ms" aria-labelledby="quiet-h">
            <h2 id="quiet-h">Deals going quiet</h2>
            <p v-if="!data.quiet.length" class="muted">Every open deal moved in the last week.</p>
            <div v-for="d in data.quiet" :key="d.id" class="q">
              <div class="q-main">
                <RouterLink :to="`/deals/${d.id}`" class="q-title">{{ d.title }}{{ d.contact?.company ? ` · ${d.contact.company}` : '' }}</RouterLink>
                <span class="small q-note">No stage change for {{ d.daysQuiet }} days</span>
              </div>
              <span class="mono">{{ money(d.value, d.currency) }}</span>
              <RouterLink :to="`/deals/${d.id}?draft=1`" class="btn btn-ghost draft">✦ Draft follow-up</RouterLink>
            </div>
          </section>
        </div>

        <div class="col">
          <section class="card" aria-labelledby="away-h">
            <div class="head">
              <h2 id="away-h">While you were away</h2>
              <span class="live"><span class="dot pulse" aria-hidden="true"></span>Live</span>
            </div>
            <p v-if="!data.feed.length" class="muted">No activity yet.</p>
            <ul class="feed" aria-live="polite">
              <li v-for="(f, i) in data.feed" :key="f.id" class="rise" :style="{ animationDelay: `${500 + i * 90}ms` }">
                <span class="ficon" :class="icon(f.type)[1]" aria-hidden="true">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path :d="icon(f.type)[0]" /></svg>
                </span>
                <div>
                  <RouterLink v-if="f.dealId" :to="`/deals/${f.dealId}`">{{ f.note }}</RouterLink>
                  <span v-else>{{ f.note }}</span>
                  <span class="small muted">{{ ago(f.occurredAt) }}</span>
                </div>
              </li>
            </ul>
          </section>

          <section class="card" aria-labelledby="chart-h">
            <div class="head">
              <h2 id="chart-h">Automation runs, last 7 days</h2>
              <span v-if="okRate !== null" class="small muted">{{ okRate }}% succeeded</span>
            </div>
            <svg viewBox="0 0 350 160" class="chart" role="img" :aria-label="`Runs per day: ${bars.map((b) => `${b.label} ${b.total}`).join(', ')}`">
              <g v-for="(b, i) in bars" :key="b.key">
                <text :x="i * 50 + 25" :y="128 - b.h" text-anchor="middle" class="n">{{ b.total }}</text>
                <rect class="grow" :style="{ animationDelay: `${400 + i * 70}ms` }" :x="i * 50 + 6" :y="134 - b.h" width="38" :height="b.h" rx="5" :fill="i === 6 ? 'var(--accent)' : '#dad6f8'" />
                <text :x="i * 50 + 25" y="154" text-anchor="middle" class="d">{{ b.label }}</text>
              </g>
            </svg>
          </section>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.date {
  margin: 0;
  font-weight: 500;
}
h1 {
  margin-top: 2px !important;
}
.kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 14px;
}
.kpi {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 18px;
  border-radius: 14px;
  background: var(--surface);
  border: 1px solid var(--line);
}
.kpi .label {
  font-weight: 600;
  color: var(--ink-2);
}
.kpi .num {
  font-size: 28px;
  font-weight: 500;
}
.kpi.accent {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.kpi.accent .label {
  color: #fff;
}
.won {
  color: #15803d;
}
.failed {
  font-weight: 600;
  color: var(--danger);
}
.cols {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  align-items: flex-start;
}
.col {
  flex: 2 1 320px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.col.wide {
  flex: 3 1 460px;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.tasks li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid #f0eef7;
  transition: opacity 0.4s;
}
.tasks label {
  flex: 1;
  min-width: 0;
}
.tasks li.done {
  opacity: 0.45;
}
.tasks li.done label {
  text-decoration: line-through;
}
.q {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 14px;
  border-radius: 12px;
  background: #fff7ed;
}
.q-main {
  flex: 1 1 200px;
  display: flex;
  flex-direction: column;
}
.q-title {
  font-weight: 700;
  color: var(--ink);
  text-decoration: none;
}
.q-note {
  color: #9a3412;
  font-weight: 600;
}
.draft {
  min-height: 40px;
  border-color: #fed7aa;
}
.live {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  color: #15803d;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #15803d;
}
.feed li {
  display: flex;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid #f0eef7;
}
.feed li div {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.feed a {
  font-weight: 600;
  color: var(--ink);
  text-decoration: none;
}
.feed a:hover {
  text-decoration: underline;
}
.feed li div > span:first-child {
  font-weight: 600;
}
.ficon {
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f1f0f6;
  color: var(--ink-2);
}
.ficon.auto {
  background: var(--accent-tint);
  color: #4338ca;
}
.ficon.mail,
.ficon.form {
  background: #e3f5e8;
  color: #15803d;
}
.ficon.call {
  background: #e2f2fb;
  color: #0369a1;
}
.ficon.move {
  background: #fdf0dc;
  color: #b45309;
}
.chart {
  width: 100%;
  height: auto;
}
.chart .n {
  font-family: var(--mono);
  font-size: 11px;
  fill: var(--ink-2);
}
.chart .d {
  font-size: 12px;
  fill: var(--muted);
}
</style>
