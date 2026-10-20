<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, errorText, session, type RunStatus } from '../api';
import { ago, shortId } from '../format';

interface Run {
  id: string;
  status: RunStatus;
  error: string | null;
  rule?: string;
  ruleId: string;
  ruleVersion: number;
  eventType: string;
  eventSummary: string | null;
  attempt: number;
  createdAt: string;
  finishedAt: string | null;
}
interface RunDetail extends Run {
  eventId: string;
  idempotencyKey: string;
  depth: number;
  skipReason: string | null;
  payload: unknown;
  steps: { id: string; actionIndex: number; actionType: string; status: string; error: string | null; output: unknown; tries: number; history: { try: number; error: string; retryInMs?: number; deadLettered?: boolean }[]; startedAt: string; finishedAt: string | null }[];
}

const route = useRoute();
const router = useRouter();
const hours = ref(168);
const status = ref('');
const ruleId = ref('');
const runs = ref<Run[]>([]);
const counts = ref<Record<string, number>>({});
const nextCursor = ref<string | null>(null);
const rules = ref<{ id: string; name: string }[]>([]);
const loading = ref(false);
const error = ref('');
const detail = ref<RunDetail>();
const detailError = ref('');
const retrying = ref(false);
const msg = ref('');
let poll: ReturnType<typeof setTimeout>;

const selected = computed(() => route.params.id as string | undefined);
const owner = computed(() => session.value?.role === 'owner');
const ACTION = { create_task: 'Create task', send_email: 'Send email', webhook: 'Call webhook' } as Record<string, string>;
const chips = computed(() => [
  { label: 'Succeeded', cls: 'succeeded', n: counts.value.succeeded ?? 0 },
  { label: 'In progress', cls: 'queued', n: (counts.value.queued ?? 0) + (counts.value.running ?? 0) },
  { label: 'Failed', cls: 'failed', n: counts.value.failed ?? 0 },
  { label: 'Skipped', cls: 'skipped', n: counts.value.skipped ?? 0 },
]);

async function load(more = false) {
  loading.value = true;
  error.value = '';
  try {
    const p = new URLSearchParams({ hours: String(hours.value) });
    if (status.value) p.set('status', status.value);
    if (ruleId.value) p.set('ruleId', ruleId.value);
    if (more && nextCursor.value) p.set('cursor', nextCursor.value);
    const page = await api<{ data: Run[]; nextCursor: string | null; counts: Record<string, number> }>(`/automation/runs?${p}`);
    runs.value = more ? [...runs.value, ...page.data] : page.data;
    nextCursor.value = page.nextCursor;
    counts.value = page.counts;
  } catch (e) {
    error.value = errorText(e);
  } finally {
    loading.value = false;
  }
}

async function loadDetail(id: string) {
  detailError.value = '';
  try {
    detail.value = await api<RunDetail>(`/automation/runs/${id}`);
    const row = runs.value.find((r) => r.id === id);
    if (row) Object.assign(row, { status: detail.value.status, attempt: detail.value.attempt, error: detail.value.error });
  } catch (e) {
    detail.value = undefined;
    detailError.value = errorText(e);
  }
}

const settled = (s: RunStatus) => !['queued', 'running', 'retrying'].includes(s);

async function retry() {
  if (!detail.value) return;
  retrying.value = true;
  msg.value = '';
  try {
    await api(`/automation/runs/${detail.value.id}/retry`, { method: 'POST' });
    msg.value = 'Retry queued. Watching for the result…';
    const id = detail.value.id;
    let n = 0;
    const tick = async () => {
      await loadDetail(id);
      if (detail.value && settled(detail.value.status) && n > 0) {
        msg.value = `Retry finished: ${detail.value.status}.`;
        retrying.value = false;
        load();
      } else if (++n < 30) poll = setTimeout(tick, 1500);
      else retrying.value = false;
    };
    poll = setTimeout(tick, 800);
  } catch (e) {
    msg.value = errorText(e);
    retrying.value = false;
  }
}

watch([hours, status, ruleId], () => load(), { immediate: true });
watch(selected, (id) => {
  clearTimeout(poll);
  retrying.value = false;
  msg.value = '';
  if (id) loadDetail(id);
  else detail.value = undefined;
}, { immediate: true });
api<{ id: string; name: string }[]>('/automation/rules').then((r) => (rules.value = r)).catch(() => {});
onUnmounted(() => clearTimeout(poll));
</script>

<template>
  <div class="page">
    <div class="head">
      <h1>Run log</h1>
      <div class="filters">
        <label for="f-time" class="sr-only">Time window</label>
        <select id="f-time" v-model.number="hours">
          <option :value="24">Last 24 hours</option>
          <option :value="168">Last 7 days</option>
          <option :value="720">Last 30 days</option>
        </select>
        <label for="f-status" class="sr-only">Status</label>
        <select id="f-status" v-model="status">
          <option value="">All statuses</option>
          <option value="succeeded">Succeeded</option>
          <option value="failed">Failed</option>
          <option value="retrying">Retrying</option>
          <option value="queued">Queued</option>
          <option value="running">Running</option>
          <option value="skipped">Skipped</option>
        </select>
        <label for="f-rule" class="sr-only">Rule</label>
        <select id="f-rule" v-model="ruleId">
          <option value="">All rules</option>
          <option v-for="r in rules" :key="r.id" :value="r.id">{{ r.name }}</option>
        </select>
      </div>
    </div>

    <div class="chips">
      <div v-for="c in chips" :key="c.label" class="chip rise" :class="c.cls">
        <span>{{ c.label }}</span>
        <span class="mono">{{ c.n }}</span>
      </div>
    </div>
    <p v-if="error" class="error notice" role="alert">{{ error }}</p>

    <div class="cols">
      <section class="card table-card" aria-label="Runs" :aria-busy="loading">
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Rule</th>
                <th scope="col">Event</th>
                <th scope="col">Status</th>
                <th scope="col">Tries</th>
                <th scope="col">Started</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in runs" :key="r.id" :class="{ sel: r.id === selected }" @click="router.push(`/runs/${r.id}`)">
                <td class="mono"><RouterLink :to="`/runs/${r.id}`" :aria-current="r.id === selected ? 'true' : undefined" @click.stop>#{{ shortId(r.id) }}</RouterLink></td>
                <td>{{ r.rule }}</td>
                <td><span v-if="r.eventSummary">{{ r.eventSummary }}<br></span><span class="mono small">{{ r.eventType }}</span></td>
                <td><span class="pill" :class="r.status">{{ r.status }}</span></td>
                <td class="mono">{{ r.attempt }}</td>
                <td class="muted nowrap">{{ ago(r.createdAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="loading && !runs.length" class="muted pad">Loading runs…</p>
        <p v-else-if="!runs.length" class="muted pad">No runs match these filters.</p>
        <button v-if="nextCursor" class="btn btn-ghost more" :disabled="loading" @click="load(true)">Load more</button>
      </section>

      <section v-if="selected" class="card detail rise" aria-labelledby="detail-h" aria-live="polite">
        <p v-if="detailError" class="error" role="alert">{{ detailError }}</p>
        <p v-else-if="!detail" class="muted">Loading run…</p>
        <template v-else>
          <div class="head">
            <div>
              <h2 id="detail-h">{{ detail.rule }}</h2>
              <p class="small muted mono flush">#{{ shortId(detail.id) }} · rule v{{ detail.ruleVersion }}</p>
            </div>
            <span class="pill big" :class="detail.status">{{ detail.status === 'failed' ? 'Failed · in dead-letter queue' : detail.status }}</span>
          </div>
          <p v-if="detail.error" class="err mono">{{ detail.error }}</p>
          <p v-if="detail.skipReason" class="small muted">Skipped: {{ detail.skipReason }}</p>
          <dl>
            <div><dt>Trigger event</dt><dd class="mono">#{{ shortId(detail.eventId) }} · {{ detail.eventType }}</dd></div>
            <div><dt>Idempotency key</dt><dd class="mono">{{ detail.idempotencyKey }}</dd></div>
            <div><dt>Chain depth</dt><dd class="mono">{{ detail.depth }} of 3</dd></div>
            <div><dt>Attempts</dt><dd class="mono">{{ detail.attempt }} of 3</dd></div>
          </dl>

          <div>
            <h3>Steps</h3>
            <p v-if="!detail.steps.length" class="small muted">No steps ran.</p>
            <ol class="steps">
              <li v-for="s in detail.steps" :key="s.id" :class="s.status">
                <div class="head">
                  <span class="b">{{ s.actionIndex + 1 }} · {{ ACTION[s.actionType] ?? s.actionType }}</span>
                  <span class="pill" :class="s.status">{{ s.status }}</span>
                </div>
                <code v-if="s.error" class="err">{{ s.error }}</code>
                <span class="small muted">
                  {{ s.tries }} tr{{ s.tries === 1 ? 'y' : 'ies' }}{{ s.finishedAt ? ` · ${new Date(s.finishedAt).getTime() - new Date(s.startedAt).getTime()} ms` : '' }} · key <span class="mono">{{ shortId(detail.id) }}:{{ s.actionIndex }}</span>
                </span>
                <ul v-if="s.history?.length" class="tries small">
                  <li v-for="h in s.history" :key="h.try">
                    Try {{ h.try }} · {{ h.error }} · {{ h.deadLettered ? 'moved to dead-letter queue' : `waited ${(h.retryInMs ?? 0) / 1000} s` }}
                  </li>
                </ul>
                <pre v-if="s.output" class="out">{{ JSON.stringify(s.output, null, 2) }}</pre>
              </li>
            </ol>
            <p v-if="detail.status === 'failed'" class="small muted">Retrying is safe: each step has its own key, so finished steps never run twice.</p>
          </div>

          <div>
            <h3>Event payload</h3>
            <pre>{{ JSON.stringify(detail.payload, null, 2) }}</pre>
          </div>

          <p v-if="msg" class="small b" role="status">{{ msg }}</p>
          <div class="btns">
            <button v-if="owner && (detail.status === 'failed' || retrying)" type="button" class="btn" :disabled="retrying" @click="retry">{{ retrying ? 'Retrying…' : 'Retry run' }}</button>
            <RouterLink :to="`/rules/${detail.ruleId}`" class="btn btn-ghost">Open rule</RouterLink>
            <RouterLink to="/runs" class="btn btn-ghost">Close</RouterLink>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.filters select {
  width: auto;
}
.chips {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
}
.chip {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 16px;
  border-radius: 14px;
  font-weight: 600;
  background: #efedf7;
  color: #4b4e6d;
}
.chip .mono {
  font-size: 22px;
}
.chip.succeeded {
  background: #e3f5e8;
  color: #15803d;
}
.chip.queued {
  background: #fdf0dc;
  color: #8a4b00;
}
.chip.failed {
  background: #fde8e8;
  color: var(--danger);
}
.cols {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  align-items: flex-start;
}
.table-card {
  flex: 3 1 520px;
  min-width: 0;
  padding: 0;
  overflow: hidden;
}
.scroll {
  overflow-x: auto;
}
table {
  width: 100%;
  min-width: 600px;
  border-collapse: collapse;
  text-align: left;
}
th {
  padding: 14px 16px;
  font-weight: 700;
  border-bottom: 1px solid var(--line);
}
td {
  padding: 12px 16px;
  border-bottom: 1px solid #f0eef7;
}
tbody tr {
  cursor: pointer;
  transition: background 0.12s;
}
tbody tr:hover {
  background: #faf9fd;
}
tr.sel {
  background: #f4f2fe;
}
td a {
  color: var(--ink);
}
.nowrap {
  white-space: nowrap;
}
.pad,
.more {
  margin: 16px;
}
.detail {
  flex: 2 1 380px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.flush {
  margin: 2px 0 0;
}
.pill.big {
  padding: 5px 12px;
  font-size: 13px;
}
dl {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
dt {
  font-size: 12px;
  color: var(--muted);
}
dd {
  margin: 2px 0 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}
h3 {
  margin: 0 0 8px;
  font-size: 14px;
}
.tries {
  margin: 6px 0 0;
  padding-left: 18px;
  color: var(--muted);
}
.steps {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.steps li {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border-radius: 12px;
  border: 1px solid var(--line);
}
.steps li.failed {
  border-color: #f5c2c2;
  background: #fffafa;
}
.b {
  font-weight: 700;
}
.err {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: #fde8e8;
  color: var(--danger);
  font-family: var(--mono);
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
.out {
  font-size: 12px;
  padding: 10px;
}
.btns {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
@media (max-width: 520px) {
  dl {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
