<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { api, errorText, type Task } from '../api';
import { when } from '../format';

const status = ref<'open' | 'done'>('open');
const mine = ref(true);
const tasks = ref<Task[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const error = ref('');
const form = reactive({ title: '', dueAt: '' });
const msg = ref('');

async function load(more = false) {
  loading.value = true;
  error.value = '';
  try {
    const page = await api<{ data: Task[]; nextCursor: string | null }>(
      `/tasks?status=${status.value}&mine=${mine.value}${more && nextCursor.value ? `&cursor=${nextCursor.value}` : ''}`,
    );
    tasks.value = more ? [...tasks.value, ...page.data] : page.data;
    nextCursor.value = page.nextCursor;
  } catch (e) {
    error.value = errorText(e);
  } finally {
    loading.value = false;
  }
}
watch([status, mine], () => load(), { immediate: true });

async function toggle(t: Task) {
  const to = t.status === 'open' ? 'done' : 'open';
  try {
    await api(`/tasks/${t.id}`, { method: 'PATCH', body: { status: to } });
    tasks.value = tasks.value.filter((x) => x.id !== t.id);
    msg.value = to === 'done' ? `Done: ${t.title}` : `Reopened: ${t.title}`;
  } catch (e) {
    error.value = errorText(e);
  }
}

async function add() {
  try {
    const t = await api<Task>('/tasks', { method: 'POST', body: { title: form.title, dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : null } });
    if (status.value === 'open') tasks.value.unshift(t);
    Object.assign(form, { title: '', dueAt: '' });
    msg.value = `Added: ${t.title}`;
  } catch (e) {
    error.value = errorText(e);
  }
}
</script>

<template>
  <div class="page">
    <div class="head">
      <h1>Tasks</h1>
      <div class="filters">
        <div class="seg" role="group" aria-label="Status">
          <button type="button" :aria-pressed="status === 'open'" @click="status = 'open'">Open</button>
          <button type="button" :aria-pressed="status === 'done'" @click="status = 'done'">Done</button>
        </div>
        <div class="seg" role="group" aria-label="Whose tasks">
          <button type="button" :aria-pressed="mine" @click="mine = true">Mine</button>
          <button type="button" :aria-pressed="!mine" @click="mine = false">Everyone</button>
        </div>
      </div>
    </div>

    <form class="card add rise" @submit.prevent="add">
      <label class="title">New task <input v-model="form.title" required maxlength="200" placeholder="e.g. Call Priya about pricing" /></label>
      <label>Due <input v-model="form.dueAt" type="datetime-local" /></label>
      <button class="btn">Add task</button>
    </form>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p class="sr-only" role="status">{{ msg }}</p>

    <section class="card rise" style="animation-delay: 80ms" aria-label="Tasks" :aria-busy="loading">
      <p v-if="loading && !tasks.length" class="muted">Loading tasks…</p>
      <p v-else-if="!tasks.length" class="muted">{{ status === 'open' ? 'No open tasks. Nice.' : 'Nothing done yet.' }}</p>
      <TransitionGroup tag="ul" name="fade">
        <li v-for="t in tasks" :key="t.id">
          <input :id="`task-${t.id}`" type="checkbox" :checked="t.status === 'done'" @change="toggle(t)" />
          <label :for="`task-${t.id}`" :class="{ done: t.status === 'done' }">{{ t.title }}</label>
          <span v-if="t.createdByRuleId" class="pill">⚡ From rule</span>
          <RouterLink v-if="t.dealId" :to="`/deals/${t.dealId}`" class="small">Deal</RouterLink>
          <span class="small muted due">{{ t.dueAt ? when(t.dueAt) : 'No due date' }}</span>
        </li>
      </TransitionGroup>
      <button v-if="nextCursor" class="btn btn-ghost more" :disabled="loading" @click="load(true)">Load more</button>
    </section>
  </div>
</template>

<style scoped>
.page {
  max-width: 1000px;
}
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.add {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
}
.add .title {
  flex: 3 1 240px;
}
.add label:not(.title) {
  flex: 1 1 180px;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-top: 1px solid #f0eef7;
}
li:first-child {
  border-top: 0;
}
li label {
  flex: 1 1 200px;
  min-width: 0;
}
.done {
  text-decoration: line-through;
  color: var(--muted);
}
.due {
  white-space: nowrap;
}
.more {
  margin-top: 12px;
}
.fade-leave-active {
  transition: opacity 0.3s;
}
.fade-leave-to {
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .fade-leave-active {
    transition: none;
  }
}
</style>
