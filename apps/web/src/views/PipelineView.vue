<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api, errorText, type Deal, type Member, type Stage } from '../api';
import NewDealDialog from '../NewDealDialog.vue';
import { STAGES, inStage, initials, money, stageLabel } from '../format';

interface Column {
  stage: Stage;
  count: number;
  total: number;
  deals: Deal[];
  nextCursor: string | null;
}

const columns = ref<Column[]>([]);
const members = ref<Member[]>([]);
const loading = ref(true);
const error = ref('');
const status = ref('');
const dragging = ref<string | null>(null);
const over = ref<Stage | null>(null);
const dialog = ref<InstanceType<typeof NewDealDialog>>();
const timers: ReturnType<typeof setTimeout>[] = [];

const open = computed(() => columns.value.filter((c) => c.stage !== 'won'));
const owner = (id: string | null) => members.value.find((m) => m.id === id);
const col = (stage: Stage) => columns.value.find((c) => c.stage === stage)!;

async function load() {
  try {
    [columns.value, members.value] = await Promise.all([api<Column[]>('/deals/board'), api<Member[]>('/members')]);
  } catch (e) {
    error.value = errorText(e);
  } finally {
    loading.value = false;
  }
}

/** Rules run in the worker, so badges for rule-made tasks show up a moment after the move. */
async function refreshBadges() {
  const board = await api<Column[]>('/deals/board').catch(() => null);
  if (!board) return;
  const ruled = new Set(board.flatMap((c) => c.deals.filter((d) => d.ruleTask).map((d) => d.id)));
  for (const c of columns.value)
    for (const d of c.deals)
      if (ruled.has(d.id) && !d.ruleTask) {
        d.ruleTask = true;
        status.value = `A rule created a task on ${d.title}.`;
      }
}

async function move(deal: Deal, to: Stage) {
  const from = col(deal.stage);
  const target = col(to);
  if (from === target) return;
  const index = from.deals.indexOf(deal);
  const shift = (c: Column, sign: number) => {
    c.count += sign;
    c.total += sign * deal.value;
  };
  from.deals.splice(index, 1);
  shift(from, -1);
  target.deals.unshift(deal);
  shift(target, 1);
  deal.stage = to;
  error.value = '';
  try {
    const saved = await api<Deal>(`/deals/${deal.id}/move`, { method: 'POST', body: { stage: to } });
    deal.stageChangedAt = saved.stageChangedAt;
    status.value = `Moved ${deal.title} to ${stageLabel(to)}.`;
    timers.push(setTimeout(refreshBadges, 2500), setTimeout(refreshBadges, 6000));
  } catch (e) {
    target.deals.splice(target.deals.indexOf(deal), 1);
    shift(target, -1);
    from.deals.splice(index, 0, deal);
    shift(from, 1);
    deal.stage = from.stage;
    error.value = `Could not move ${deal.title}: ${errorText(e)}`;
  }
}

function onDrop(stage: Stage) {
  const deal = columns.value.flatMap((c) => c.deals).find((d) => d.id === dragging.value);
  over.value = null;
  dragging.value = null;
  if (deal) move(deal, stage);
}

async function more(c: Column) {
  try {
    const page = await api<{ data: Deal[]; nextCursor: string | null }>(`/deals?stage=${c.stage}&cursor=${c.nextCursor}`);
    c.deals.push(...page.data.filter((d) => !c.deals.some((x) => x.id === d.id)));
    c.nextCursor = page.nextCursor;
  } catch (e) {
    error.value = errorText(e);
  }
}

function added(deal: Deal) {
  const c = col(deal.stage);
  c.deals.unshift(deal);
  c.count++;
  c.total += deal.value;
  status.value = `Created ${deal.title} in ${stageLabel(deal.stage)}.`;
}

onMounted(load);
onUnmounted(() => timers.forEach(clearTimeout));
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <h1>Pipeline</h1>
        <p class="muted sub">
          {{ open.reduce((n, c) => n + c.count, 0) }} open deals ·
          <span class="mono ink">{{ money(open.reduce((n, c) => n + c.total, 0)) }}</span> in play
        </p>
      </div>
      <div class="team" aria-label="Team">
        <span v-for="m in members" :key="m.id" class="avatar" :title="m.name">{{ initials(m.name) }}</span>
      </div>
    </div>

    <p v-if="error" class="error notice" role="alert">{{ error }}</p>
    <div class="banner" role="status" aria-live="polite" :hidden="!status">
      <span class="bolt" aria-hidden="true">⚡</span>
      <span>{{ status }}</span>
      <RouterLink to="/runs">See run log</RouterLink>
    </div>
    <p v-if="loading" class="muted">Loading the board…</p>

    <div v-else class="scroller">
      <div class="board">
        <section
          v-for="c in columns"
          :key="c.stage"
          class="column"
          :class="[c.stage, { over: over === c.stage }]"
          :aria-label="stageLabel(c.stage)"
          @dragover.prevent="over = c.stage"
          @dragleave.self="over = null"
          @drop.prevent="onDrop(c.stage)"
        >
          <div class="col-head">
            <h2>
              {{ stageLabel(c.stage) }}
              <span class="count">{{ c.count }}</span>
            </h2>
            <span class="mono small">{{ money(c.total) }}</span>
          </div>
          <TransitionGroup name="card" tag="div" class="cards">
            <article
              v-for="d in c.deals"
              :key="d.id"
              class="deal lift"
              :class="{ dragging: dragging === d.id }"
              draggable="true"
              @dragstart="(e) => { dragging = d.id; e.dataTransfer?.setData('text/plain', d.id); }"
              @dragend="dragging = null; over = null"
            >
              <div class="row">
                <div class="who">
                  <h3><RouterLink :to="`/deals/${d.id}`">{{ d.title }}</RouterLink></h3>
                  <p class="small muted">{{ d.contact?.company || d.contact?.name || 'No contact' }}</p>
                </div>
                <span v-if="owner(d.ownerId)" class="avatar sm" :title="`Owner: ${owner(d.ownerId)!.name}`">{{ initials(owner(d.ownerId)!.name) }}</span>
              </div>
              <RouterLink v-if="d.ruleTask" to="/runs" class="pill badge">⚡ Task created by rule</RouterLink>
              <div class="row">
                <span class="mono">{{ money(d.value, d.currency) }}</span>
                <span class="small muted">{{ inStage(d.stageChangedAt) }}</span>
              </div>
              <label class="mover">
                <span class="sr-only">Move {{ d.title }} to stage</span>
                <select :value="d.stage" @change="move(d, ($event.target as HTMLSelectElement).value as Stage)">
                  <option v-for="s in STAGES" :key="s" :value="s">{{ s === d.stage ? `In ${stageLabel(s)}` : `Move to ${stageLabel(s)}` }}</option>
                </select>
              </label>
            </article>
          </TransitionGroup>
          <button v-if="c.nextCursor" type="button" class="add" @click="more(c)">Load more</button>
          <button type="button" class="add" @click="dialog?.open(c.stage)">+ Add deal</button>
        </section>
      </div>
    </div>
    <NewDealDialog ref="dialog" @created="added" />
  </div>
</template>

<style scoped>
.sub {
  margin: 4px 0 0;
  font-weight: 500;
}
.ink {
  color: var(--ink);
}
.team {
  display: flex;
}
.team .avatar {
  width: 34px;
  height: 34px;
  border: 2px solid var(--ground);
}
.team .avatar + .avatar {
  margin-left: -8px;
}
.team .avatar:nth-child(3n + 2) {
  background: #0e7c66;
}
.team .avatar:nth-child(3n + 3) {
  background: #c2410c;
}
.banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  border-radius: 14px;
  color: #fff;
  background: var(--nav);
}
.banner[hidden] {
  display: none;
}
.banner a {
  margin-left: auto;
  font-weight: 700;
  color: #fff;
}
.bolt {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent);
}
.scroller {
  position: relative;
  overflow-x: auto;
  padding-bottom: 6px;
}
.board {
  display: grid;
  grid-template-columns: repeat(5, minmax(230px, 1fr));
  gap: 14px;
  min-width: 1200px;
}
.column {
  --fg: #4338ca;
  --bg: #eef0ff;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  min-height: 520px;
  border-radius: 14px;
  background: #efedf7;
  border-top: 4px solid var(--fg);
  transition:
    background 0.15s,
    box-shadow 0.15s;
}
.column.qualified {
  --fg: #0369a1;
  --bg: #e2f2fb;
}
.column.proposal {
  --fg: #b45309;
  --bg: #fdf0dc;
}
.column.negotiation {
  --fg: #be185d;
  --bg: #fce7f1;
}
.column.won {
  --fg: #15803d;
  --bg: #e3f5e8;
}
.column.over {
  background: var(--bg);
  box-shadow: inset 0 0 0 2px var(--fg);
}
.col-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 2px 4px;
}
.col-head h2 {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 700;
}
.count {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 12px;
  background: var(--bg);
  color: var(--fg);
}
.cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.deal {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-radius: 12px;
  background: var(--surface);
  box-shadow:
    0 1px 2px rgba(22, 24, 58, 0.06),
    0 2px 8px rgba(22, 24, 58, 0.05);
  cursor: grab;
  position: relative;
}
.deal.dragging {
  opacity: 0.4;
  transform: rotate(2deg);
}
.row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.who {
  min-width: 0;
}
h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
}
h3 a {
  color: var(--ink);
  text-decoration: none;
}
h3 a:hover {
  text-decoration: underline;
}
.who p {
  margin: 2px 0 0;
}
.avatar.sm {
  width: 28px;
  height: 28px;
  font-size: 10px;
}
.badge {
  align-self: flex-start;
  font-weight: 600;
}
.mover select {
  min-height: 34px;
  font-size: 13px;
  color: var(--ink-2);
  background: var(--ground);
}
/* Mouse users drag; the stage select appears for keyboard focus and on touch screens. */
@media (hover: hover) {
  .mover:not(:focus-within) {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
  }
}
.add {
  min-height: 40px;
  border: 1px dashed #c9c5de;
  border-radius: 12px;
  background: transparent;
  font-weight: 600;
  color: var(--ink-2);
  cursor: pointer;
}
.card-enter-active,
.card-move {
  transition: all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.card-enter-from {
  opacity: 0;
  transform: translateY(-8px);
}
@media (prefers-reduced-motion: reduce) {
  .card-enter-active,
  .card-move,
  .column {
    transition: none;
  }
}
</style>
