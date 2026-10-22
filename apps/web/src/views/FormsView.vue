<script setup lang="ts">
import { computed, ref } from 'vue';
import { api, errorText, session, type Member } from '../api';
import { copy } from '../format';

type Key = 'name' | 'email' | 'company' | 'phone' | 'message';
interface Field {
  key: Key;
  label: string;
  required: boolean;
}
interface Form {
  id: string;
  name: string;
  headline: string;
  enabled: boolean;
  fields: Field[];
  assignToId: string | null;
  tags: string[];
  submissionsThisWeek: number;
  becameDealsThisWeek: number;
  listeners: { id: string; name: string }[];
}

const KEYS: Record<Key, [string, string]> = {
  name: ['Name', 'contact.name'],
  email: ['Work email', 'contact.email'],
  company: ['Company', 'contact.company'],
  phone: ['Phone', 'contact.phone'],
  message: ['How can we help?', 'activity.note'],
};

const forms = ref<Form[]>([]);
const members = ref<Member[]>([]);
const formId = ref('');
const edit = ref<Form>();
const tags = ref('');
const loading = ref(true);
const error = ref('');
const msg = ref('');
const saving = ref(false);
const previewKey = ref(0);
const owner = computed(() => session.value?.role === 'owner');
const missing = computed(() => (Object.keys(KEYS) as Key[]).filter((k) => !edit.value?.fields.some((f) => f.key === k)));
const url = computed(() => `${location.origin}/f/${session.value?.tenant.id}/${formId.value}`);
const embed = computed(() => `<iframe src="${url.value}" title="${(edit.value?.name ?? 'Contact form').replace(/"/g, '&quot;')}" width="100%" height="640" style="border:0;max-width:560px" loading="lazy"></iframe>`);

function pick(id: string) {
  formId.value = id;
  const f = forms.value.find((x) => x.id === id)!;
  edit.value = JSON.parse(JSON.stringify(f));
  tags.value = f.tags.join(', ');
}

Promise.all([api<Form[]>('/forms'), api<Member[]>('/members')])
  .then(([f, m]) => {
    forms.value = f;
    members.value = m;
    if (f[0]) pick(f[0].id);
  })
  .catch((e) => (error.value = errorText(e)))
  .finally(() => (loading.value = false));

function addField(e: Event) {
  const key = (e.target as HTMLSelectElement).value as Key;
  (e.target as HTMLSelectElement).value = '';
  if (key) edit.value?.fields.push({ key, label: KEYS[key][0], required: false });
}

async function save() {
  if (!edit.value) return;
  saving.value = true;
  error.value = '';
  msg.value = '';
  try {
    const { headline, enabled, fields, assignToId } = edit.value;
    const saved = await api<Form>(`/forms/${formId.value}`, {
      method: 'PATCH',
      body: { headline, enabled, fields, assignToId, tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean) },
    });
    Object.assign(forms.value.find((f) => f.id === formId.value)!, saved);
    msg.value = 'Saved. The live form is updated.';
    previewKey.value++;
  } catch (e) {
    error.value = errorText(e);
  } finally {
    saving.value = false;
  }
}

async function copyEmbed() {
  await copy(embed.value);
  msg.value = 'Embed code copied.';
}
</script>

<template>
  <div class="page">
    <div class="head">
      <nav aria-label="Breadcrumb" class="crumbs">
        <span>Lead forms</span>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{{ edit?.name ?? '…' }}</span>
        <span v-if="edit" class="pill" :class="edit.enabled ? 'on' : 'off'">{{ edit.enabled ? 'Live' : 'Off' }}</span>
      </nav>
      <div class="btns">
        <label v-if="forms.length > 1">
          <span class="sr-only">Choose form</span>
          <select :value="formId" @change="pick(($event.target as HTMLSelectElement).value)">
            <option v-for="f in forms" :key="f.id" :value="f.id">{{ f.name }}</option>
          </select>
        </label>
        <a v-if="edit" :href="url" target="_blank" rel="noopener" class="btn btn-ghost">Open form</a>
        <button v-if="owner && edit" type="button" class="btn" :disabled="saving" @click="save">Save changes</button>
      </div>
    </div>
    <p v-if="!owner" class="notice">Only workspace owners can change lead forms.</p>
    <p v-if="error" class="error notice" role="alert">{{ error }}</p>
    <p class="ok" role="status">{{ msg }}</p>
    <p v-if="loading" class="muted">Loading forms…</p>
    <p v-else-if="!edit && !error" class="card muted">No lead forms yet.</p>

    <template v-if="edit">
      <div class="stats">
        <div class="card stat rise"><span>Submissions this week</span><strong class="mono">{{ forms.find((f) => f.id === formId)?.submissionsThisWeek }}</strong></div>
        <div class="card stat rise" style="animation-delay: 60ms"><span>Became deals</span><strong class="mono">{{ forms.find((f) => f.id === formId)?.becameDealsThisWeek }}</strong></div>
        <div class="card stat rise" style="animation-delay: 120ms"><span>Rules listening</span><strong class="mono">{{ edit.listeners.length }}</strong></div>
      </div>

      <div class="cols">
        <fieldset :disabled="!owner" class="col wide">
          <section class="card stack" aria-labelledby="fields-h">
            <div class="head">
              <h2 id="fields-h">Form fields</h2>
              <label v-if="missing.length" class="addf">
                <span class="sr-only">Add field</span>
                <select @change="addField">
                  <option value="">+ Add field</option>
                  <option v-for="k in missing" :key="k" :value="k">{{ KEYS[k][0] }}</option>
                </select>
              </label>
            </div>
            <label>Headline <input v-model="edit.headline" maxlength="120" /></label>
            <div v-for="(f, i) in edit.fields" :key="f.key" class="field">
              <label class="lbl">
                <span class="sr-only">Label for {{ f.key }}</span>
                <input v-model="f.label" required maxlength="80" />
                <span class="small muted">Saved to <span class="mono">{{ KEYS[f.key][1] }}</span></span>
              </label>
              <label class="req">
                <input v-model="f.required" type="checkbox" :disabled="f.key === 'name'" />
                Required
              </label>
              <button type="button" class="icon-btn" :disabled="f.key === 'name'" :aria-label="`Remove ${f.label}`" @click="edit.fields.splice(i, 1)">✕</button>
            </div>
          </section>

          <section class="card stack" aria-labelledby="after-h">
            <h2 id="after-h">When someone submits</h2>
            <div class="grid2">
              <label>
                Assign the lead to
                <select v-model="edit.assignToId">
                  <option :value="null">Take turns ({{ members.map((m) => m.name.split(' ')[0]).join(', ') }})</option>
                  <option v-for="m in members" :key="m.id" :value="m.id">{{ m.name }}</option>
                </select>
              </label>
              <label>Add tags <input v-model="tags" placeholder="website, inbound" /></label>
            </div>
            <button type="button" class="toggle" :aria-pressed="edit.enabled" @click="edit.enabled = !edit.enabled">Form is {{ edit.enabled ? 'live' : 'off' }}</button>
            <div class="listen">
              <span aria-hidden="true">⚡</span>
              <span>
                Each new lead fires <strong class="mono">lead.created</strong>.
                <template v-if="edit.listeners.length">
                  {{ edit.listeners.length }} rule{{ edit.listeners.length === 1 ? ' is' : 's are' }} listening:
                  <template v-for="(l, i) in edit.listeners" :key="l.id"><RouterLink :to="`/rules/${l.id}`">{{ l.name }}</RouterLink>{{ i < edit.listeners.length - 1 ? ', ' : '.' }}</template>
                </template>
                <template v-else>No rules are listening yet.</template>
              </span>
              <RouterLink to="/templates" class="push">Add a rule</RouterLink>
            </div>
          </section>

          <section class="card stack" aria-labelledby="embed-h">
            <h2 id="embed-h">Put it on your website</h2>
            <p class="muted flush">Paste this where the form should appear. Works with WordPress, Wix and plain HTML.</p>
            <pre>{{ embed }}</pre>
            <button type="button" class="btn btn-ghost start" @click="copyEmbed">Copy code</button>
          </section>
        </fieldset>

        <section class="col preview" aria-label="Live preview">
          <span class="small muted b">Live preview</span>
          <div class="browser">
            <div class="bar" aria-hidden="true"><i></i><i></i><i></i><span class="mono small">{{ url.replace(/^https?:\/\//, '') }}</span></div>
            <iframe :key="previewKey" :src="url" title="Lead form preview" loading="lazy"></iframe>
          </div>
        </section>
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
.crumbs [aria-current] {
  color: var(--ink);
  font-weight: 700;
}
.btns {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.ok {
  margin: 0;
  color: #15803d;
  font-weight: 600;
}
.ok:empty {
  display: none;
}
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 14px;
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px 18px;
}
.stat span {
  font-weight: 600;
  color: var(--ink-2);
}
.stat strong {
  font-size: 28px;
  font-weight: 500;
}
.cols {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  align-items: flex-start;
}
.col {
  flex: 2 1 340px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.col.wide {
  flex: 3 1 460px;
}
.stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.addf select {
  width: auto;
  min-height: 38px;
  font-weight: 600;
}
.field {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 12px;
  background: #faf9fd;
  border: 1px solid var(--line);
}
.lbl {
  flex: 1;
  min-width: 0;
  gap: 4px;
  font-weight: 500;
}
.req {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}
.icon-btn {
  min-width: 36px;
  min-height: 36px;
  border: 1px solid var(--field);
  border-radius: 10px;
  background: var(--surface);
  cursor: pointer;
}
.icon-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.grid2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}
.toggle {
  align-self: flex-start;
}
.listen {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--accent-tint);
  color: #23264a;
}
.listen span:nth-child(2) {
  flex: 1 1 240px;
}
.push {
  margin-left: auto;
  font-weight: 700;
}
.flush {
  margin: 0;
}
.start {
  align-self: flex-start;
}
.b {
  font-weight: 700;
}
.preview {
  gap: 8px;
}
.browser {
  border-radius: 14px;
  overflow: hidden;
  border: 1px solid var(--line);
  background: var(--surface);
  box-shadow: 0 10px 30px rgba(22, 24, 58, 0.08);
}
.bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  background: #efedf7;
}
.bar i {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #d4d0e6;
}
.bar span {
  margin-left: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
}
iframe {
  display: block;
  width: 100%;
  height: 640px;
  border: 0;
}
fieldset:disabled .icon-btn,
fieldset:disabled .addf {
  display: none;
}
</style>
