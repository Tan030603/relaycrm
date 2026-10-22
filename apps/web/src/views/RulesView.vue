<script setup lang="ts">
import { computed, ref } from 'vue';
import { api, errorText, session } from '../api';
import { TRIGGER_LABEL, ago } from '../format';

interface Rule {
  id: string;
  name: string;
  triggerType: string;
  enabled: boolean;
  version: number;
  updatedAt: string;
  runs7d: Record<string, number>;
}

const rules = ref<Rule[]>([]);
const loading = ref(true);
const error = ref('');
const owner = computed(() => session.value?.role === 'owner');

api<Rule[]>('/automation/rules')
  .then((r) => (rules.value = r))
  .catch((e) => (error.value = errorText(e)))
  .finally(() => (loading.value = false));

async function toggle(r: Rule) {
  error.value = '';
  try {
    const updated = await api<Rule>(`/automation/rules/${r.id}/${r.enabled ? 'disable' : 'enable'}`, { method: 'POST' });
    r.enabled = updated.enabled;
  } catch (e) {
    error.value = errorText(e);
  }
}
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <h1>Rules</h1>
        <p class="muted sub">Each rule listens for one event, checks its conditions, then runs its actions in the background.</p>
      </div>
      <div v-if="owner" class="btns">
        <RouterLink to="/templates" class="btn btn-ghost">Browse templates</RouterLink>
        <RouterLink to="/rules/new" class="btn">+ New rule</RouterLink>
      </div>
    </div>
    <p v-if="error" class="error notice" role="alert">{{ error }}</p>
    <p v-if="loading" class="muted">Loading rules…</p>
    <p v-else-if="!rules.length" class="card muted">No rules yet. <RouterLink to="/templates">Start from a template</RouterLink>.</p>

    <ul class="list">
      <li v-for="(r, i) in rules" :key="r.id" class="card rule lift rise" :style="{ animationDelay: `${i * 50}ms` }">
        <div class="main">
          <RouterLink :to="`/rules/${r.id}`" class="name">{{ r.name }}</RouterLink>
          <span class="small muted">{{ TRIGGER_LABEL[r.triggerType] ?? r.triggerType }} · v{{ r.version }} · edited {{ ago(r.updatedAt) }}</span>
        </div>
        <div class="stats small" :aria-label="`Last 7 days: ${r.runs7d.succeeded ?? 0} succeeded, ${r.runs7d.failed ?? 0} failed, ${r.runs7d.skipped ?? 0} skipped`">
          <span class="pill succeeded">{{ r.runs7d.succeeded ?? 0 }} ok</span>
          <span v-if="r.runs7d.failed" class="pill failed">{{ r.runs7d.failed }} failed</span>
          <span class="pill skipped">{{ r.runs7d.skipped ?? 0 }} skipped</span>
        </div>
        <button v-if="owner" type="button" class="toggle" :aria-pressed="r.enabled" :aria-label="`${r.name} enabled`" @click="toggle(r)">{{ r.enabled ? 'On' : 'Off' }}</button>
        <span v-else class="pill" :class="r.enabled ? 'on' : 'off'">{{ r.enabled ? 'On' : 'Off' }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.page {
  max-width: 1100px;
}
.sub {
  margin: 4px 0 0;
}
.btns {
  display: flex;
  gap: 10px;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rule {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  padding: 16px 20px;
}
.main {
  flex: 1 1 260px;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.name {
  font-size: 16px;
  font-weight: 700;
  color: var(--ink);
  text-decoration: none;
}
.name:hover {
  text-decoration: underline;
}
.stats {
  display: flex;
  gap: 6px;
}
</style>
