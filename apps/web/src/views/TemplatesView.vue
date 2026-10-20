<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError, api, errorText, session } from '../api';
import { TRIGGER_LABEL } from '../format';

interface Template {
  key: string;
  category: string;
  title: string;
  desc: string;
  rule: { triggerType: string; actions: { type: string }[] };
  installed: { id: string; enabled: boolean } | null;
}

const router = useRouter();
const templates = ref<Template[]>([]);
const loading = ref(true);
const error = ref('');
const busy = ref<string | null>(null);
const text = ref('');
const generating = ref(false);
const genError = ref('');
const aiOff = ref(false);
const owner = computed(() => session.value?.role === 'owner');
const groups = computed(() => [...new Set(templates.value.map((t) => t.category))].map((c) => ({ name: c, items: templates.value.filter((t) => t.category === c) })));

const icon: Record<string, string> = {
  Leads: 'M7 11V6a2 2 0 0 1 4 0v5M11 10V4a2 2 0 0 1 4 0v6M15 10V6a2 2 0 0 1 4 0v7a7 7 0 0 1-14 0v-2a2 2 0 0 1 4 0',
  Deals: 'M12 2l3 6.5 7 .8-5.2 4.8 1.4 7L12 17.6 5.8 21l1.4-7L2 9.3l7-.8z',
  'Follow-up': 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
};

api<Template[]>('/automation/templates')
  .then((t) => (templates.value = t))
  .catch((e) => (error.value = errorText(e)))
  .finally(() => (loading.value = false));

async function install(t: Template) {
  busy.value = t.key;
  error.value = '';
  try {
    const rule = await api<{ id: string; enabled: boolean }>(`/automation/templates/${t.key}/install`, { method: 'POST' });
    t.installed = { id: rule.id, enabled: rule.enabled };
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = null;
  }
}

async function generate() {
  generating.value = true;
  genError.value = '';
  aiOff.value = false;
  try {
    const { rule } = await api<{ rule: unknown }>('/automation/rules/generate', { method: 'POST', body: { text: text.value } });
    router.push({ path: '/rules/new', state: { draft: JSON.stringify(rule) } });
  } catch (e) {
    aiOff.value = e instanceof ApiError && e.status === 503;
    genError.value = errorText(e);
  } finally {
    generating.value = false;
  }
}
</script>

<template>
  <div class="page">
    <div class="hero rise">
      <div>
        <h1>Put your busywork on autopilot</h1>
        <p>Pick a template and switch it on in one click, or describe what you want and AI builds it.</p>
      </div>
      <form v-if="owner" class="ask" @submit.prevent="generate">
        <label for="ask" class="sr-only">Describe a rule</label>
        <input id="ask" v-model="text" required minlength="5" maxlength="1000" placeholder="e.g. Remind me when a proposal has no reply for 7 days" />
        <button class="btn" :disabled="generating">✦ {{ generating ? 'Building…' : 'Build with AI' }}</button>
      </form>
      <div aria-live="polite">
        <p v-if="genError" class="gen-error" :class="{ off: aiOff }">
          <strong>{{ aiOff ? 'AI rule drafting is not switched on for this workspace.' : 'Could not build that rule.' }}</strong>
          {{ genError }}
          <template v-if="aiOff"> You can still start from a template or a <RouterLink to="/rules/new">blank rule</RouterLink>.</template>
        </p>
      </div>
    </div>

    <div class="head">
      <p v-if="!owner" class="muted">Only workspace owners can switch templates on. You can look around.</p>
      <RouterLink v-if="owner" to="/rules/new" class="btn btn-ghost push">+ Blank rule</RouterLink>
    </div>
    <p v-if="error" class="error notice" role="alert">{{ error }}</p>
    <p v-if="loading" class="muted">Loading templates…</p>

    <section v-for="(g, gi) in groups" :key="g.name" :aria-labelledby="`cat-${gi}`" class="group">
      <h2 :id="`cat-${gi}`">{{ g.name }}</h2>
      <div class="grid">
        <article v-for="(t, i) in g.items" :key="t.key" class="card tpl lift rise" :class="g.name.split('-')[0].toLowerCase()" :style="{ animationDelay: `${(gi * 3 + i) * 60}ms` }">
          <div class="top">
            <span class="ic" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path :d="icon[g.name] ?? icon.Deals" /></svg>
            </span>
            <span v-if="t.installed" class="pill" :class="t.installed.enabled ? 'on' : 'off'">{{ t.installed.enabled ? 'On' : 'Off' }}</span>
          </div>
          <div>
            <h3>{{ t.title }}</h3>
            <p class="muted">{{ t.desc }}</p>
          </div>
          <div class="flow small">
            <span class="chip">{{ TRIGGER_LABEL[t.rule.triggerType] ?? t.rule.triggerType }}</span>
            <span aria-hidden="true">→</span>
            <span class="chip mono">{{ t.rule.actions.map((a) => a.type).join(' + ') }}</span>
          </div>
          <div class="foot">
            <RouterLink v-if="t.installed" :to="`/rules/${t.installed.id}`" class="btn btn-ghost">Edit rule</RouterLink>
            <button v-else-if="owner" type="button" class="btn" :disabled="busy === t.key" @click="install(t)">
              {{ busy === t.key ? 'Turning on…' : 'Use template' }}
            </button>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.hero {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 28px;
  border-radius: 18px;
  color: #fff;
  background: radial-gradient(circle at 85% 0%, #3a2fb8 0, transparent 55%), var(--nav);
}
.hero p {
  margin: 6px 0 0;
  color: var(--nav-text);
  max-width: 560px;
}
.ask {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  max-width: 720px;
}
.ask input {
  flex: 1 1 260px;
}
.gen-error {
  margin: 0;
  padding: 12px 14px;
  border-radius: 12px;
  background: #fde8e8;
  color: var(--danger);
}
.gen-error.off {
  background: #2a2d5c;
  color: #fff;
}
.gen-error.off a {
  color: #fff;
}
.push {
  margin-left: auto;
}
.group h2 {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
  gap: 14px;
}
.tpl {
  --bg: #fdf0dc;
  --fg: #b45309;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.tpl.leads {
  --bg: #eef0ff;
  --fg: #4338ca;
}
.tpl.follow {
  --bg: #f1f0f6;
  --fg: #3b3e5c;
}
.top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}
.ic {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
  color: var(--fg);
}
h3 {
  margin: 0;
  font-size: 16px;
}
.tpl p {
  margin: 4px 0 0;
}
.flow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  color: var(--muted);
}
.chip {
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--ground);
  color: var(--ink-2);
}
.foot {
  margin-top: auto;
}
</style>
