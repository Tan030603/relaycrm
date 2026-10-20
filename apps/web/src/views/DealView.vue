<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api, errorText, type Activity, type Contact, type Deal, type RunStatus, type Stage, type Task } from '../api';
import { STAGES, ago, copy, initials, money, reducedMotion, shortId, stageLabel, when } from '../format';

type FullDeal = Deal & {
  contact: (Contact & { source: string | null }) | null;
  owner: { id: string; name: string; email: string } | null;
  tasks: Task[];
  activities: Activity[];
  runs: { id: string; status: RunStatus; createdAt: string; rule?: string }[];
};
interface Assist {
  source: 'rules' | 'claude';
  summary: string[];
  nextStep: string;
  email: { subject: string; body: string };
  basedOn: number;
}

const route = useRoute();
const id = route.params.id as string;
const deal = ref<FullDeal>();
const error = ref('');
const moving = ref(false);
const status = ref('');
const ai = ref<Assist>();
const aiBusy = ref(false);
const aiError = ref('');
const showDraft = ref(false);
const draft = reactive({ subject: '', body: '' });
const log = reactive({ type: 'note', note: '' });
const logBusy = ref(false);
const logEl = ref<HTMLTextAreaElement>();
const draftEl = ref<HTMLElement>();
let timer: ReturnType<typeof setTimeout>;

const at = computed(() => (deal.value ? STAGES.indexOf(deal.value.stage) : 0));
const next = computed(() => STAGES[at.value + 1] as Stage | undefined);

async function load() {
  try {
    deal.value = await api<FullDeal>(`/deals/${id}`);
  } catch (e) {
    error.value = errorText(e);
  }
}

async function move(stage: Stage) {
  if (!deal.value || stage === deal.value.stage) return;
  moving.value = true;
  error.value = '';
  try {
    await api(`/deals/${id}/move`, { method: 'POST', body: { stage } });
    await load();
    status.value = `Moved to ${stageLabel(stage)}. Rules are checking this change…`;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await load();
      status.value = `Moved to ${stageLabel(stage)}.`;
    }, 3000);
  } catch (e) {
    error.value = errorText(e);
  } finally {
    moving.value = false;
  }
}

async function assist(openDraft = false) {
  aiBusy.value = true;
  aiError.value = '';
  try {
    ai.value = await api<Assist>(`/deals/${id}/assist`, { method: 'POST' });
    Object.assign(draft, ai.value.email);
    if (openDraft) await reveal();
  } catch (e) {
    aiError.value = errorText(e);
  } finally {
    aiBusy.value = false;
  }
}

async function reveal() {
  showDraft.value = true;
  await nextTick();
  draftEl.value?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

async function copyDraft() {
  await copy(`Subject: ${draft.subject}\n\n${draft.body}`);
  status.value = 'Draft copied to the clipboard.';
}

async function taskFromDraft() {
  try {
    const task = await api<Task>('/tasks', {
      method: 'POST',
      body: { title: `Send follow-up: ${draft.subject}`.slice(0, 200), dealId: id, dueAt: new Date(Date.now() + 86_400_000).toISOString() },
    });
    deal.value?.tasks.push(task);
    status.value = 'Task created for tomorrow.';
  } catch (e) {
    aiError.value = errorText(e);
  }
}

async function complete(task: Task) {
  try {
    await api(`/tasks/${task.id}`, { method: 'PATCH', body: { status: 'done' } });
    deal.value!.tasks = deal.value!.tasks.filter((t) => t.id !== task.id);
    status.value = `Done: ${task.title}`;
  } catch (e) {
    error.value = errorText(e);
  }
}

async function addActivity() {
  logBusy.value = true;
  try {
    const a = await api<Activity>(`/deals/${id}/activities`, { method: 'POST', body: log });
    deal.value?.activities.unshift(a);
    log.note = '';
    status.value = 'Activity logged.';
  } catch (e) {
    error.value = errorText(e);
  } finally {
    logBusy.value = false;
  }
}

const typeIcon: Record<string, string> = {
  automation: 'M13 2L4 14h7l-1 8 9-12h-7z',
  stage_changed: 'M5 12h14M13 6l6 6-6 6',
  call: 'M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7l.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4l2.8.7a2 2 0 0 1 1.7 2z',
  email: 'M4 4h16v16H4zM22 6l-10 7L2 6',
  meeting: 'M4 5h16v15H4zM4 10h16M9 3v4M15 3v4',
  form: 'M8 8h8M8 12h8M8 16h5M5 3h14v18H5z',
  created: 'M12 5v14M5 12h14',
};

onMounted(async () => {
  await load();
  if (route.query.draft) assist(true);
});
onUnmounted(() => clearTimeout(timer));
</script>

<template>
  <div class="page">
    <div class="head">
      <nav aria-label="Breadcrumb" class="crumbs">
        <RouterLink to="/pipeline">Pipeline</RouterLink>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{{ deal?.title ?? 'Deal' }}</span>
      </nav>
      <div v-if="deal" class="btns">
        <button type="button" class="btn btn-ghost" @click="logEl?.focus()">Log activity</button>
        <button v-if="next" type="button" class="btn" :disabled="moving" @click="move(next)">Move to {{ stageLabel(next) }}</button>
      </div>
    </div>
    <p v-if="error" class="error notice" role="alert">{{ error }}</p>
    <p class="sr-only" role="status" aria-live="polite">{{ status }}</p>
    <p v-if="!deal && !error" class="muted">Loading deal…</p>

    <template v-if="deal">
      <div class="card hero rise">
        <div class="hero-top">
          <span class="mark" aria-hidden="true">{{ initials(deal.contact?.company || deal.title) }}</span>
          <div class="grow-1">
            <h1>{{ deal.title }}</h1>
            <p class="muted">{{ [deal.contact?.company, deal.contact?.name].filter(Boolean).join(' · ') || 'No contact' }}</p>
          </div>
          <div class="value">
            <span class="mono big">{{ money(deal.value, deal.currency) }}</span>
            <span class="small muted">{{ deal.expectedCloseDate ? `Expected close ${new Date(deal.expectedCloseDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })}` : 'No close date' }}</span>
          </div>
        </div>
        <ol class="stepper" aria-label="Deal stage">
          <li v-for="(s, i) in STAGES" :key="s" :aria-current="i === at ? 'step' : undefined" :class="{ reached: i <= at, current: i === at }">
            <button type="button" :disabled="moving || i === at" :aria-label="i === at ? `Current stage: ${stageLabel(s)}` : `Move to ${stageLabel(s)}`" @click="move(s)">
              <span class="bar"></span>
              {{ stageLabel(s) }}
            </button>
          </li>
        </ol>
        <p v-if="status" class="small ok" aria-hidden="true">{{ status }}</p>
      </div>

      <div class="cols">
        <div class="col wide">
          <section class="ai rise" style="animation-delay: 80ms" aria-labelledby="ai-h">
            <div class="head">
              <span class="spark" aria-hidden="true">✦</span>
              <h2 id="ai-h">AI helper</h2>
              <span v-if="ai" class="pill src">{{ ai.source === 'claude' ? 'Claude' : 'Built-in summary' }}</span>
              <span v-if="ai" class="small muted push">Based on {{ ai.basedOn }} activities</span>
            </div>
            <div aria-live="polite">
              <p v-if="!ai && !aiBusy" class="muted">Get a quick summary, the next step and a follow-up email draft. Nothing is sent for you.</p>
              <p v-if="aiBusy" class="muted">Reading the timeline…</p>
              <p v-if="aiError" class="error" role="alert">{{ aiError }}</p>
              <template v-if="ai">
                <ul class="summary">
                  <li v-for="(s, i) in ai.summary" :key="i">{{ s }}</li>
                </ul>
                <div class="next">
                  <span class="eyebrow">Suggested next step</span>
                  <span>{{ ai.nextStep }}</span>
                </div>
              </template>
            </div>
            <div class="btns">
              <button v-if="!ai" type="button" class="btn" :disabled="aiBusy" @click="assist()">Summarise this deal</button>
              <button v-else type="button" class="btn" @click="reveal">Draft follow-up email</button>
            </div>
          </section>

          <section v-if="showDraft && ai" ref="draftEl" class="card stack rise" aria-labelledby="draft-h">
            <div class="head">
              <h2 id="draft-h">Draft from AI</h2>
              <span class="pill review">Review before sending</span>
            </div>
            <label>Subject <input v-model="draft.subject" /></label>
            <label>Message <textarea v-model="draft.body" rows="8"></textarea></label>
            <div class="btns">
              <button type="button" class="btn" @click="copyDraft">Copy</button>
              <button type="button" class="btn btn-ghost" @click="taskFromDraft">Create task from this</button>
              <button type="button" class="btn btn-ghost" :disabled="aiBusy" @click="assist(true)">Try again</button>
            </div>
          </section>

          <section class="card stack" aria-labelledby="tl-h">
            <h2 id="tl-h">Timeline</h2>
            <form class="log" @submit.prevent="addActivity">
              <label class="type">
                Type
                <select v-model="log.type">
                  <option value="note">Note</option>
                  <option value="call">Call</option>
                  <option value="email">Email</option>
                  <option value="meeting">Meeting</option>
                </select>
              </label>
              <label class="note">
                Log activity
                <textarea ref="logEl" v-model="log.note" rows="2" required maxlength="5000" placeholder="What happened?"></textarea>
              </label>
              <button class="btn" :disabled="logBusy">Add</button>
            </form>
            <p v-if="!deal.activities.length" class="muted">No activity yet.</p>
            <ol class="timeline">
              <li v-for="a in deal.activities" :key="a.id">
                <span class="ticon" :class="a.type" aria-hidden="true">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path :d="typeIcon[a.type] ?? 'M4 6h16M4 12h10M4 18h7'" /></svg>
                </span>
                <div>
                  <span class="t">{{ a.note }}</span>
                  <span class="small muted">{{ a.actorId ? stageLabel(a.type.replace('_', ' ')) : 'Automation' }}</span>
                </div>
                <time class="small muted" :datetime="a.occurredAt">{{ ago(a.occurredAt) }}</time>
              </li>
            </ol>
          </section>
        </div>

        <aside class="col" aria-label="Deal details">
          <section class="card stack" aria-labelledby="det-h">
            <h2 id="det-h">Details</h2>
            <dl>
              <div><dt>Contact</dt><dd class="b">{{ deal.contact?.name ?? '—' }}</dd></div>
              <div v-if="deal.contact?.email"><dt>Email</dt><dd><a :href="`mailto:${deal.contact.email}`">{{ deal.contact.email }}</a></dd></div>
              <div>
                <dt>Owner</dt>
                <dd class="b owner"><span v-if="deal.owner" class="avatar sm" aria-hidden="true">{{ initials(deal.owner.name) }}</span>{{ deal.owner?.name ?? 'Unassigned' }}</dd>
              </div>
              <div><dt>Source</dt><dd><RouterLink v-if="deal.contact?.source?.startsWith('Website form')" to="/forms" class="b">{{ deal.contact.source }}</RouterLink><span v-else>{{ deal.contact?.source ?? '—' }}</span></dd></div>
            </dl>
          </section>

          <section class="card stack" aria-labelledby="dt-h">
            <h2 id="dt-h">Open tasks</h2>
            <p v-if="!deal.tasks.length" class="muted">No open tasks.</p>
            <div v-for="t in deal.tasks" :key="t.id" class="task">
              <input :id="`dt-${t.id}`" type="checkbox" @change="complete(t)" />
              <label :for="`dt-${t.id}`">
                <span>{{ t.title }}</span>
                <span class="small muted">{{ t.dueAt ? `Due ${when(t.dueAt)}` : 'No due date' }}{{ t.createdByRuleId ? ' · from rule' : '' }}</span>
              </label>
            </div>
          </section>

          <section class="auto stack" aria-labelledby="au-h">
            <h2 id="au-h">Automations on this deal</h2>
            <span class="soft">
              {{ deal.runs.length ? `${deal.runs.length} rule run${deal.runs.length === 1 ? '' : 's'} · ${deal.runs.filter((r) => r.status === 'succeeded').length} succeeded` : 'No rules have run on this deal yet.' }}
            </span>
            <ul>
              <li v-for="r in deal.runs" :key="r.id">
                <RouterLink :to="`/runs/${r.id}`">{{ r.rule ?? 'Rule' }} <span class="mono soft">#{{ shortId(r.id) }}</span></RouterLink>
                <span class="pill" :class="r.status">{{ r.status }}</span>
              </li>
            </ul>
            <RouterLink to="/runs" class="b white">Open in run log</RouterLink>
          </section>
        </aside>
      </div>
    </template>
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
  gap: 10px;
}
.hero {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.hero-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
}
.hero h1 {
  font-size: 28px;
}
.hero p {
  margin: 2px 0 0;
}
.grow-1 {
  flex: 1 1 240px;
  min-width: 0;
}
.mark {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  background: #fdf0dc;
  color: #b45309;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  font-weight: 800;
}
.value {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}
.big {
  font-size: 28px;
  font-weight: 500;
}
.stepper {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 6px;
}
.stepper button {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 0 4px;
  border: 0;
  background: none;
  text-align: left;
  font-size: 13px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
}
.stepper button:disabled {
  cursor: default;
}
.bar {
  height: 8px;
  width: 100%;
  border-radius: 4px;
  background: var(--line);
  transition: background 0.3s;
}
.reached button {
  color: var(--ink);
}
.reached .bar {
  background: var(--accent);
}
.current button {
  font-weight: 700;
}
.stepper button:not(:disabled):hover .bar {
  background: #c9c2f7;
}
.ok {
  margin: 0;
  color: #15803d;
  font-weight: 600;
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
  gap: 20px;
}
.col.wide {
  flex: 3 1 480px;
}
.stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ai {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 22px;
  border-radius: 16px;
  background: var(--accent-tint);
  border: 1px solid #d9d4fb;
}
.ai h2 {
  margin: 0;
  font-size: 17px;
}
.ai .head {
  justify-content: flex-start;
  gap: 10px;
}
.spark {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent);
  color: #fff;
}
.src {
  background: #fff;
}
.push {
  margin-left: auto;
  color: #4b4e6d;
}
.summary {
  margin: 0 0 12px;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: #23264a;
}
.next {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px;
  border-radius: 12px;
  background: #fff;
  font-weight: 600;
}
.eyebrow {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #4338ca;
}
.review {
  background: #fff4db;
  color: #8a5300;
}
.log {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
  padding-bottom: 12px;
  border-bottom: 1px solid #f0eef7;
}
.log .type {
  flex: 0 1 130px;
}
.log .note {
  flex: 1 1 240px;
}
.timeline {
  margin: 0;
  padding: 0;
  list-style: none;
}
.timeline li {
  display: flex;
  gap: 14px;
  padding: 10px 0;
}
.timeline li > div {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.t {
  font-weight: 600;
  overflow-wrap: anywhere;
}
time {
  white-space: nowrap;
}
.ticon {
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f1f0f6;
  color: var(--ink-2);
}
.ticon.automation {
  background: var(--accent-tint);
  color: #4338ca;
}
.ticon.stage_changed {
  background: #fdf0dc;
  color: #b45309;
}
.ticon.call {
  background: #e2f2fb;
  color: #0369a1;
}
.ticon.email,
.ticon.meeting {
  background: #e3f5e8;
  color: #15803d;
}
dl {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
dt {
  font-size: 12px;
  color: var(--muted);
}
dd {
  margin: 2px 0 0;
  overflow-wrap: anywhere;
}
.b {
  font-weight: 600;
}
.owner {
  display: flex;
  align-items: center;
  gap: 8px;
}
.avatar.sm {
  width: 24px;
  height: 24px;
  font-size: 10px;
}
.task {
  display: flex;
  align-items: center;
  gap: 10px;
}
.task label {
  flex: 1;
  font-weight: 600;
}
.task label span + span {
  font-weight: 400;
}
.auto {
  padding: 20px;
  border-radius: 16px;
  background: var(--nav);
  color: #fff;
}
.auto h2 {
  margin: 0;
  font-size: 17px;
}
.auto ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.auto li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.auto a {
  color: #fff;
}
.soft {
  color: var(--nav-text);
}
.auto a:focus-visible {
  outline-color: #fff;
}
</style>
