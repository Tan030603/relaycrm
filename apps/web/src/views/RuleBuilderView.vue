<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, api, errorText, session, type RunStatus } from '../api';
import { STAGES, ago, shortId } from '../format';

type Op = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in';
type Leaf = { field: string; op: Op; value: unknown };
type Group = { all: unknown[] } | { any: unknown[] };
interface Act {
  type: 'create_task' | 'send_email' | 'webhook';
  params: { title?: string; assignee?: string; due_in_hours?: number; to?: string; template?: string; subject?: string; body?: string; url?: string };
}
interface RuleIn {
  id?: string;
  name: string;
  triggerType: string;
  conditions: Group;
  actions: Act[];
  enabled?: boolean;
  version?: number;
}
interface Catalog {
  triggers: { type: string; label: string; fields: Record<string, 'text' | 'number' | 'list'> }[];
  ops: Op[];
  variables: string[];
  emailTemplates: { key: string; subject: string }[];
}
interface TestResult {
  source: 'latest_event' | 'sample' | 'provided';
  matched: boolean;
  conditions: { field: string; op: Op; expected: unknown; actual: unknown; passed: boolean }[];
  actions: { type: string; summary: string; detail: string }[];
}

const OP_LABEL: Record<Op, string> = {
  eq: 'equals', neq: 'does not equal', gt: 'is greater than', gte: 'is at least',
  lt: 'is less than', lte: 'is at most', contains: 'contains', in: 'is one of',
};
const OPS_FOR = { number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in'], text: ['eq', 'neq', 'contains', 'in'], list: ['contains'] } as const;
const ASSIGNEES = [['deal_owner', 'Deal owner'], ['contact_owner', 'Contact owner'], ['role:owner', 'Workspace owner']];

const route = useRoute();
const router = useRouter();
const ruleId = ref(route.params.id as string | undefined);
const catalog = ref<Catalog>();
const loading = ref(true);
const error = ref('');
const msg = ref('');
const saving = ref(false);
const draft = reactive({ name: '', triggerType: 'deal.stage_changed', mode: 'all' as 'all' | 'any', enabled: true, version: 0 });
const rows = ref<{ field: string; op: Op; value: string }[]>([]);
const nested = ref<unknown[]>([]);
const actions = ref<Act[]>([]);
const test = ref<TestResult>();
const testing = ref(false);
const testError = ref('');
const recent = ref<{ id: string; status: RunStatus; eventType: string; createdAt: string }[]>([]);
const aiText = ref('');
const aiBusy = ref(false);
const aiError = ref('');

const owner = computed(() => session.value?.role === 'owner');
const trigger = computed(() => catalog.value?.triggers.find((t) => t.type === draft.triggerType));
const fields = computed(() => trigger.value?.fields ?? {});
const vars = computed(() => (catalog.value?.variables ?? []).filter((v) => draft.triggerType !== 'lead.created' || !v.startsWith('deal.')));
const opsFor = (field: string) => OPS_FOR[fields.value[field] ?? 'text'];
const isLeaf = (n: unknown): n is Leaf => typeof n === 'object' && n !== null && 'field' in n;

function fill(r: RuleIn) {
  draft.name = r.name;
  draft.triggerType = r.triggerType;
  draft.enabled = r.enabled ?? true;
  draft.version = r.version ?? 0;
  draft.mode = 'any' in r.conditions ? 'any' : 'all';
  const list = 'any' in r.conditions ? r.conditions.any : r.conditions.all;
  rows.value = list.filter(isLeaf).map((c) => ({ field: c.field, op: c.op, value: Array.isArray(c.value) ? c.value.join(', ') : String(c.value) }));
  nested.value = list.filter((n) => !isLeaf(n));
  actions.value = r.actions.map((a) => ({ type: a.type, params: { ...a.params } }));
}

function toRule() {
  const conv = (field: string, v: string) => (fields.value[field] === 'number' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : v.trim());
  const leaves = rows.value.map((r) => ({
    field: r.field,
    op: r.op,
    value: r.op === 'in' ? r.value.split(',').map((v) => conv(r.field, v)).filter((v) => v !== '') : conv(r.field, r.value),
  }));
  const list = [...leaves, ...nested.value];
  return {
    name: draft.name,
    triggerType: draft.triggerType,
    conditions: draft.mode === 'all' ? { all: list } : { any: list },
    actions: actions.value.map(({ type, params: p }) =>
      type === 'create_task'
        ? { type, params: { title: p.title, assignee: p.assignee, due_in_hours: Number(p.due_in_hours) } }
        : type === 'send_email'
          ? { type, params: { to: p.to, template: p.template, ...(p.template === 'custom' && { subject: p.subject, body: p.body }) } }
          : { type, params: { url: p.url } },
    ),
  };
}

function onTrigger() {
  const first = Object.keys(fields.value)[0];
  for (const r of rows.value) if (!fields.value[r.field]) Object.assign(r, { field: first, op: opsFor(first)[0] });
  nested.value = [];
}

function addRow() {
  const field = Object.keys(fields.value)[0];
  rows.value.push({ field, op: opsFor(field)[0], value: '' });
}

function addAction(type: Act['type']) {
  actions.value.push(
    type === 'create_task'
      ? { type, params: { title: 'Follow up on {{deal.title}}', assignee: 'deal_owner', due_in_hours: 24 } }
      : { type, params: { to: '{{deal.owner.email}}', template: catalog.value?.emailTemplates[0]?.key ?? 'custom' } },
  );
}

function moveAction(i: number, by: number) {
  const [a] = actions.value.splice(i, 1);
  actions.value.splice(i + by, 0, a);
}

async function loadRecent() {
  if (!ruleId.value) return;
  const page = await api<{ data: typeof recent.value }>(`/automation/runs?ruleId=${ruleId.value}&hours=720&limit=5`).catch(() => ({ data: [] }));
  recent.value = page.data;
}

async function load() {
  try {
    catalog.value = await api<Catalog>('/automation/catalog');
    const fromAi = (history.state as { draft?: string } | null)?.draft;
    if (ruleId.value) fill(await api<RuleIn>(`/automation/rules/${ruleId.value}`));
    else if (fromAi) fill(JSON.parse(fromAi));
    else {
      draft.name = 'Untitled rule';
      addRow();
      addAction('create_task');
    }
    loadRecent();
  } catch (e) {
    error.value = errorText(e);
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  error.value = '';
  try {
    const body = toRule();
    const saved = ruleId.value
      ? await api<RuleIn>(`/automation/rules/${ruleId.value}`, { method: 'PATCH', body })
      : await api<RuleIn>('/automation/rules', { method: 'POST', body: { ...body, enabled: draft.enabled } });
    draft.version = saved.version ?? 1;
    msg.value = `Saved as version ${draft.version}.`;
    if (!ruleId.value) {
      ruleId.value = saved.id;
      router.replace(`/rules/${saved.id}`);
    }
  } catch (e) {
    error.value = errorText(e);
  } finally {
    saving.value = false;
  }
}

async function toggle() {
  if (!ruleId.value) return (draft.enabled = !draft.enabled);
  try {
    const r = await api<RuleIn>(`/automation/rules/${ruleId.value}/${draft.enabled ? 'disable' : 'enable'}`, { method: 'POST' });
    draft.enabled = !!r.enabled;
    msg.value = `Rule switched ${draft.enabled ? 'on' : 'off'}.`;
  } catch (e) {
    error.value = errorText(e);
  }
}

async function runTest() {
  testing.value = true;
  testError.value = '';
  try {
    test.value = await api<TestResult>('/automation/rules/test', { method: 'POST', body: { rule: toRule() } });
  } catch (e) {
    test.value = undefined;
    testError.value = errorText(e);
  } finally {
    testing.value = false;
  }
}

async function generate() {
  aiBusy.value = true;
  aiError.value = '';
  try {
    const { rule } = await api<{ rule: RuleIn }>('/automation/rules/generate', { method: 'POST', body: { text: aiText.value } });
    fill({ ...rule, enabled: draft.enabled, version: draft.version });
    msg.value = 'AI filled in the rule below. Check it, test it, then save.';
  } catch (e) {
    aiError.value = e instanceof ApiError && e.status === 503 ? `AI drafting is not switched on here: ${e.message}` : errorText(e);
  } finally {
    aiBusy.value = false;
  }
}

const show = (v: unknown) => (v === undefined || v === null || v === '' ? 'empty' : Array.isArray(v) ? v.join(', ') : typeof v === 'number' ? v.toLocaleString() : String(v));

load();
</script>

<template>
  <div class="page">
    <div class="head">
      <nav aria-label="Breadcrumb" class="crumbs">
        <RouterLink to="/rules">Rules</RouterLink>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{{ draft.name || 'New rule' }}</span>
        <span v-if="draft.version" class="pill mono">v{{ draft.version }}</span>
      </nav>
      <div class="btns">
        <button v-if="owner" type="button" class="toggle" :aria-pressed="draft.enabled" @click="toggle">{{ draft.enabled ? 'On' : 'Off' }}</button>
        <span v-else class="pill" :class="draft.enabled ? 'on' : 'off'">{{ draft.enabled ? 'On' : 'Off' }}</span>
        <button type="button" class="btn btn-ghost" :disabled="testing || loading" @click="runTest">Test run</button>
        <button v-if="owner" type="button" class="btn" :disabled="saving || loading" @click="save">
          {{ ruleId ? `Save as v${draft.version + 1}` : 'Save rule' }}
        </button>
      </div>
    </div>
    <p v-if="!owner" class="notice">You are viewing this rule read-only. Only workspace owners can change rules.</p>
    <p v-if="error" class="error notice" role="alert">{{ error }}</p>
    <p class="status" role="status" aria-live="polite">{{ msg }}</p>
    <p v-if="loading" class="muted">Loading the builder…</p>

    <div v-if="catalog && !loading" class="cols">
      <div class="col wide">
        <section v-if="owner" class="ai rise" aria-labelledby="ai-h">
          <h2 id="ai-h"><span class="spark" aria-hidden="true">✦</span>Describe the rule in plain English</h2>
          <label for="ai-text" class="sr-only">Rule description</label>
          <textarea id="ai-text" v-model="aiText" rows="3" placeholder="When a deal over $50,000 moves to Proposal, create a review task for the owner due in 24 hours."></textarea>
          <div class="btns">
            <button type="button" class="btn" :disabled="aiBusy || aiText.trim().length < 5" @click="generate">{{ aiBusy ? 'Generating…' : 'Generate rule' }}</button>
            <span class="small muted">AI fills in the steps below. Nothing is saved until you check it.</span>
          </div>
          <p v-if="aiError" class="error" role="alert">{{ aiError }}</p>
        </section>

        <fieldset :disabled="!owner" class="stack">
          <section class="card stack rise" style="animation-delay: 60ms" aria-labelledby="when-h">
            <h2 id="when-h" class="step"><span class="n one" aria-hidden="true">1</span>When this happens</h2>
            <div class="grid2">
              <label>Rule name <input v-model="draft.name" required maxlength="120" /></label>
              <label>
                Trigger
                <select v-model="draft.triggerType" @change="onTrigger">
                  <option v-for="t in catalog.triggers" :key="t.type" :value="t.type">{{ t.label }}</option>
                </select>
              </label>
            </div>
          </section>

          <section class="card stack rise" style="animation-delay: 120ms" aria-labelledby="if-h">
            <div class="head">
              <h2 id="if-h" class="step"><span class="n two" aria-hidden="true">2</span>Only if</h2>
              <div class="seg" role="group" aria-label="Match">
                <button type="button" :aria-pressed="draft.mode === 'all'" @click="draft.mode = 'all'">All match</button>
                <button type="button" :aria-pressed="draft.mode === 'any'" @click="draft.mode = 'any'">Any matches</button>
              </div>
            </div>
            <p v-if="!rows.length" class="muted small">No conditions: the rule runs on every event of this type.</p>
            <div v-for="(r, i) in rows" :key="i" class="cond" role="group" :aria-label="`Condition ${i + 1}`">
              <select v-model="r.field" aria-label="Field" class="mono" @change="r.op = opsFor(r.field)[0]">
                <option v-for="(_, f) in fields" :key="f" :value="f">{{ f }}</option>
              </select>
              <select v-model="r.op" aria-label="Operator">
                <option v-for="op in opsFor(r.field)" :key="op" :value="op">{{ OP_LABEL[op] }}</option>
              </select>
              <input
                v-model="r.value"
                aria-label="Value"
                :type="fields[r.field] === 'number' && r.op !== 'in' ? 'number' : 'text'"
                :placeholder="r.op === 'in' ? 'comma, separated, values' : ''"
                :list="r.field.endsWith('stage') ? 'stage-list' : undefined"
              />
              <button type="button" class="icon-btn" :aria-label="`Remove condition ${i + 1}`" @click="rows.splice(i, 1)">✕</button>
            </div>
            <datalist id="stage-list"><option v-for="s in STAGES" :key="s" :value="s" /></datalist>
            <p v-if="nested.length" class="small muted">Plus {{ nested.length }} nested group(s), kept as they are.</p>
            <button type="button" class="add" @click="addRow">+ Add condition</button>
          </section>

          <section class="card stack rise" style="animation-delay: 180ms" aria-labelledby="then-h">
            <h2 id="then-h" class="step"><span class="n three" aria-hidden="true">3</span>Then do this</h2>
            <div v-for="(a, i) in actions" :key="i" class="action" role="group" :aria-label="`Action ${i + 1}`">
              <div class="head">
                <h3>{{ i + 1 }} · {{ a.type === 'create_task' ? 'Create task' : a.type === 'send_email' ? 'Send email' : 'Call webhook' }}</h3>
                <div class="btns tight">
                  <button type="button" class="icon-btn" :disabled="i === 0" :aria-label="`Move action ${i + 1} up`" @click="moveAction(i, -1)">↑</button>
                  <button type="button" class="icon-btn" :disabled="i === actions.length - 1" :aria-label="`Move action ${i + 1} down`" @click="moveAction(i, 1)">↓</button>
                  <button type="button" class="icon-btn" :disabled="actions.length === 1" :aria-label="`Remove action ${i + 1}`" @click="actions.splice(i, 1)">✕</button>
                </div>
              </div>
              <template v-if="a.type === 'create_task'">
                <div class="grid3">
                  <label class="span2">Title <input v-model="a.params.title" required maxlength="200" /></label>
                  <label>
                    Assign to
                    <select v-model="a.params.assignee">
                      <option v-for="[v, l] in ASSIGNEES" :key="v" :value="v">{{ l }}</option>
                      <option v-if="a.params.assignee?.startsWith('user:')" :value="a.params.assignee">A specific person</option>
                    </select>
                  </label>
                  <label>Due in (hours) <input v-model.number="a.params.due_in_hours" type="number" min="0" max="2160" /></label>
                </div>
                <div class="vars" aria-label="Insert a variable into the title">
                  <span class="small muted">Insert:</span>
                  <button v-for="v in vars" :key="v" type="button" class="var mono" @click="a.params.title = `${a.params.title ?? ''}{{${v}}}`">{{ v }}</button>
                </div>
              </template>
              <template v-else-if="a.type === 'send_email'">
                <div class="grid2">
                  <label>To <input v-model="a.params.to" required class="mono" /></label>
                  <label>
                    Template
                    <select v-model="a.params.template">
                      <option v-for="t in catalog.emailTemplates" :key="t.key" :value="t.key">{{ t.subject }}</option>
                      <option value="custom">Custom email</option>
                    </select>
                  </label>
                  <template v-if="a.params.template === 'custom'">
                    <label class="span2">Subject <input v-model="a.params.subject" maxlength="200" /></label>
                    <label class="span2">Body <textarea v-model="a.params.body" rows="4" maxlength="5000"></textarea></label>
                  </template>
                </div>
                <div class="vars">
                  <span class="small muted">Recipient:</span>
                  <button v-for="v in vars.filter((x) => x.endsWith('email'))" :key="v" type="button" class="var mono" @click="a.params.to = `{{${v}}}`">{{ v }}</button>
                </div>
              </template>
              <label v-else>Webhook URL <input v-model="a.params.url" type="url" required /></label>
            </div>
            <div class="btns">
              <button type="button" class="add" :disabled="actions.length >= 10" @click="addAction('create_task')">+ Create task</button>
              <button type="button" class="add" :disabled="actions.length >= 10" @click="addAction('send_email')">+ Send email</button>
            </div>
          </section>
        </fieldset>
      </div>

      <aside class="col" aria-label="Test run">
        <section class="card stack" aria-labelledby="test-h">
          <div>
            <h2 id="test-h">Test run</h2>
            <p class="small muted flush">Tries the rule as drafted on the latest real event of this type. Nothing is created or sent.</p>
          </div>
          <button type="button" class="btn btn-ghost" :disabled="testing" @click="runTest">{{ testing ? 'Testing…' : test ? 'Run again' : 'Run test' }}</button>
          <div aria-live="polite" class="stack">
            <p v-if="testError" class="error" role="alert">{{ testError }}</p>
            <template v-if="test">
              <span class="small muted">{{ test.source === 'latest_event' ? 'Used the latest real event.' : 'No real event yet, so a sample event was used.' }}</span>
              <div v-if="test.conditions.length">
                <h3>Conditions</h3>
                <ul class="checks">
                  <li v-for="(c, i) in test.conditions" :key="i" :class="{ pass: c.passed }">
                    <span class="mark" aria-hidden="true">{{ c.passed ? '✓' : '✕' }}</span>
                    <span>
                      <span class="sr-only">{{ c.passed ? 'Passed:' : 'Failed:' }}</span>
                      <span class="mono">{{ c.field }}</span> is <strong>{{ show(c.actual) }}</strong>; needs {{ OP_LABEL[c.op] }} {{ show(c.expected) }}
                    </span>
                  </li>
                </ul>
              </div>
              <div v-if="test.matched">
                <h3>Would run</h3>
                <ul class="plan">
                  <li v-for="(a, i) in test.actions" :key="i">
                    <strong>{{ a.summary }}</strong>
                    <span class="small muted">{{ a.detail }}</span>
                  </li>
                </ul>
              </div>
              <span class="pill result" :class="test.matched ? 'succeeded' : 'skipped'">
                {{ test.matched ? `Matches · ${test.actions.length} action${test.actions.length === 1 ? '' : 's'}` : 'Would not run' }}
              </span>
            </template>
          </div>
        </section>

        <section v-if="ruleId" class="card stack" aria-labelledby="recent-h">
          <div class="head">
            <h2 id="recent-h">Recent runs</h2>
            <RouterLink to="/runs">Run log</RouterLink>
          </div>
          <p v-if="!recent.length" class="small muted">No runs in the last 30 days.</p>
          <RouterLink v-for="r in recent" :key="r.id" :to="`/runs/${r.id}`" class="recent">
            <span>
              <span class="mono">#{{ shortId(r.id) }}</span>
              <span class="small muted"> · {{ ago(r.createdAt) }}</span>
            </span>
            <span class="pill" :class="r.status">{{ r.status }}</span>
          </RouterLink>
        </section>

        <div class="guards">
          <strong>Safety guards</strong>
          <span>Stops chains deeper than 3 rules, so rules can never loop forever.</span>
          <span>One event can fire at most 20 rules.</span>
          <span>Each action times out after 10 seconds.</span>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.crumbs {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-weight: 500;
}
.crumbs a {
  color: var(--muted);
  text-decoration: none;
}
.crumbs [aria-current] {
  color: var(--ink);
  font-weight: 700;
}
.btns {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.tight {
  gap: 4px;
}
.status {
  margin: 0;
  color: #15803d;
  font-weight: 600;
}
.status:empty {
  display: none;
}
.cols {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  align-items: flex-start;
}
.col {
  flex: 1 1 300px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.col.wide {
  flex: 3 1 520px;
}
.stack {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.ai {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px;
  border-radius: 16px;
  background: var(--accent-tint);
  border: 1px solid #d9d4fb;
}
.ai h2,
.step {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 16px;
  font-weight: 700;
}
.spark,
.n {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 800;
}
.spark {
  background: var(--accent);
  color: #fff;
}
.n.one {
  background: #eef0ff;
  color: #4338ca;
}
.n.two {
  background: #fdf0dc;
  color: #b45309;
}
.n.three {
  background: #e3f5e8;
  color: #15803d;
}
.grid2,
.grid3 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.span2 {
  grid-column: span 2;
}
.cond {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr)) 44px;
  gap: 8px;
}
.icon-btn {
  min-width: 36px;
  min-height: 36px;
  border: 1px solid var(--field);
  border-radius: 10px;
  background: var(--surface);
  color: var(--ink-2);
  cursor: pointer;
}
.icon-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.add {
  min-height: 40px;
  padding: 0 14px;
  border: 1px dashed #c9c5de;
  border-radius: 10px;
  background: transparent;
  font-weight: 600;
  color: var(--ink-2);
  cursor: pointer;
}
fieldset:disabled .add,
fieldset:disabled .icon-btn,
fieldset:disabled .vars {
  display: none;
}
.action {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border-radius: 12px;
  background: #faf9fd;
  border: 1px solid var(--line);
}
h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
}
.vars {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.var {
  padding: 3px 8px;
  border: 1px solid var(--field);
  border-radius: 6px;
  background: var(--surface);
  font-size: 12px;
  color: #4338ca;
  cursor: pointer;
}
.flush {
  margin: 4px 0 0;
}
.checks,
.plan {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.checks li {
  display: flex;
  gap: 8px;
  padding: 10px;
  border-radius: 10px;
  background: #fde8e8;
  overflow-wrap: anywhere;
}
.checks li.pass {
  background: #e3f5e8;
}
.mark {
  flex: none;
  font-weight: 800;
  color: var(--danger);
}
.pass .mark {
  color: #15803d;
}
.plan li {
  display: flex;
  flex-direction: column;
  padding: 10px;
  border-radius: 10px;
  background: var(--ground);
  overflow-wrap: anywhere;
}
.result {
  align-self: flex-start;
  padding: 5px 12px;
  font-size: 13px;
}
.recent {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-top: 1px solid #f0eef7;
  color: var(--ink);
  text-decoration: none;
}
.guards {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px;
  border-radius: 14px;
  background: #fff7ed;
  border: 1px solid #fed7aa;
  font-size: 13px;
  color: #7c2d12;
}
.guards strong {
  color: #9a3412;
}
@media (max-width: 720px) {
  .grid2,
  .grid3,
  .cond {
    grid-template-columns: minmax(0, 1fr);
  }
  .span2 {
    grid-column: auto;
  }
}
</style>
