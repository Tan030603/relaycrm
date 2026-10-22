<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { api, errorText, type Contact, type Deal, type Stage } from './api';
import { STAGES, stageLabel } from './format';

const emit = defineEmits<{ created: [deal: Deal] }>();
const el = ref<HTMLDialogElement>();
const form = reactive({ title: '', value: 0, currency: 'USD', contactId: '', stage: 'new' as Stage });
const q = ref('');
const contacts = ref<Contact[]>([]);
const busy = ref(false);
const error = ref('');

let timer: ReturnType<typeof setTimeout>;
watch(q, () => {
  clearTimeout(timer);
  timer = setTimeout(searchContacts, 250);
});

async function searchContacts() {
  const page = await api<{ data: Contact[] }>(`/contacts?limit=8${q.value.trim() ? `&q=${encodeURIComponent(q.value.trim())}` : ''}`).catch(() => ({ data: [] }));
  contacts.value = page.data;
  if (!contacts.value.some((c) => c.id === form.contactId)) form.contactId = contacts.value.length && q.value.trim() ? contacts.value[0].id : '';
}

function open(stage: Stage = 'new') {
  Object.assign(form, { title: '', value: 0, currency: 'USD', contactId: '', stage });
  q.value = '';
  error.value = '';
  searchContacts();
  el.value?.showModal();
}

async function submit() {
  busy.value = true;
  error.value = '';
  try {
    const deal = await api<Deal>('/deals', { method: 'POST', body: { ...form, contactId: form.contactId || null } });
    const c = contacts.value.find((x) => x.id === deal.contactId);
    emit('created', { ...deal, contact: c ? { name: c.name, company: c.company } : null, ruleTask: false });
    el.value?.close();
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}

defineExpose({ open });
</script>

<template>
  <dialog ref="el" aria-labelledby="nd-h">
    <form class="body" @submit.prevent="submit">
      <h2 id="nd-h">New deal</h2>
      <label>Title <input v-model="form.title" required maxlength="200" placeholder="e.g. ERP integration" /></label>
      <div class="row">
        <label>Value <input v-model.number="form.value" type="number" min="0" step="any" inputmode="decimal" /></label>
        <label class="cur">Currency <input v-model="form.currency" required minlength="3" maxlength="3" autocapitalize="characters" /></label>
      </div>
      <div class="row">
        <label>Find contact <input v-model="q" type="search" placeholder="Name, email or company" /></label>
        <label>
          Contact
          <select v-model="form.contactId">
            <option value="">No contact</option>
            <option v-for="c in contacts" :key="c.id" :value="c.id">{{ c.name }}{{ c.company ? ` · ${c.company}` : '' }}</option>
          </select>
        </label>
      </div>
      <label>
        Stage
        <select v-model="form.stage">
          <option v-for="s in STAGES" :key="s" :value="s">{{ stageLabel(s) }}</option>
        </select>
      </label>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <div class="actions">
        <button type="button" class="btn btn-ghost" @click="el?.close()">Cancel</button>
        <button class="btn" :disabled="busy">Create deal</button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
dialog {
  width: min(520px, calc(100vw - 32px));
  padding: 0;
  border: 0;
  border-radius: 16px;
  box-shadow: 0 24px 60px rgba(22, 24, 58, 0.25);
}
dialog[open] {
  animation: rise 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
}
dialog::backdrop {
  background: rgba(22, 24, 58, 0.45);
}
.body {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 800;
}
.row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.error {
  margin: 0;
}
@media (prefers-reduced-motion: reduce) {
  dialog[open] {
    animation: none;
  }
}
</style>
