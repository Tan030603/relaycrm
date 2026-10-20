<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, errorText, type Contact } from '../api';
import { initials } from '../format';

const route = useRoute();
const router = useRouter();
const contacts = ref<Contact[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const q = ref(typeof route.query.q === 'string' ? route.query.q : '');
const form = reactive({ name: '', email: '', company: '' });
const saving = ref(false);
const error = ref('');
const editing = ref<string | null>(null);
const edit = reactive({ name: '', email: '', phone: '', company: '' });

const clean = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v.trim() !== ''));

async function load(more = false) {
  loading.value = true;
  error.value = '';
  try {
    const params = new URLSearchParams();
    if (q.value.trim()) params.set('q', q.value.trim());
    if (more && nextCursor.value) params.set('cursor', nextCursor.value);
    const page = await api<{ data: Contact[]; nextCursor: string | null }>(`/contacts?${params}`);
    contacts.value = more ? [...contacts.value, ...page.data] : page.data;
    nextCursor.value = page.nextCursor;
  } catch (e) {
    error.value = errorText(e);
  } finally {
    loading.value = false;
  }
}

let timer: ReturnType<typeof setTimeout>;
watch(q, () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    router.replace({ query: q.value.trim() ? { q: q.value.trim() } : {} });
    load();
  }, 300);
});
watch(
  () => route.query.q,
  (v) => {
    if (typeof v === 'string' && v !== q.value.trim()) q.value = v;
  },
);

async function add() {
  saving.value = true;
  error.value = '';
  try {
    const created = await api<Contact>('/contacts', { method: 'POST', body: clean(form) });
    contacts.value = [created, ...contacts.value];
    Object.assign(form, { name: '', email: '', company: '' });
  } catch (e) {
    error.value = errorText(e);
  } finally {
    saving.value = false;
  }
}

function startEdit(c: Contact) {
  editing.value = c.id;
  Object.assign(edit, { name: c.name, email: c.email ?? '', phone: c.phone ?? '', company: c.company ?? '' });
}

async function save(c: Contact) {
  try {
    const updated = await api<Contact>(`/contacts/${c.id}`, { method: 'PATCH', body: { ...edit } });
    Object.assign(c, updated);
    editing.value = null;
  } catch (e) {
    error.value = errorText(e);
  }
}

async function remove(c: Contact) {
  if (!confirm(`Delete ${c.name}? Their deals stay, without a contact.`)) return;
  try {
    await api(`/contacts/${c.id}`, { method: 'DELETE' });
    contacts.value = contacts.value.filter((x) => x.id !== c.id);
  } catch (e) {
    error.value = errorText(e);
  }
}

load();
</script>

<template>
  <div class="page">
    <div class="head">
      <h1>Contacts</h1>
      <label class="search">
        <span class="sr-only">Search contacts</span>
        <input v-model="q" type="search" placeholder="Search by name, email or company" />
      </label>
    </div>

    <form class="card add rise" @submit.prevent="add">
      <label>Name <input v-model="form.name" required maxlength="200" /></label>
      <label>Email <input v-model="form.email" type="email" /></label>
      <label>Company <input v-model="form.company" maxlength="200" /></label>
      <button class="btn" :disabled="saving">Add contact</button>
    </form>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <section class="card list rise" style="animation-delay: 80ms" aria-label="Contacts" :aria-busy="loading">
      <p v-if="loading && !contacts.length" class="muted">Loading contacts…</p>
      <p v-else-if="!contacts.length" class="muted">{{ q ? `No contacts match “${q}”.` : 'No contacts yet. Add your first one above.' }}</p>
      <ul>
        <li v-for="c in contacts" :key="c.id">
          <form v-if="editing === c.id" class="edit" @submit.prevent="save(c)">
            <label>Name <input v-model="edit.name" required maxlength="200" /></label>
            <label>Email <input v-model="edit.email" type="email" /></label>
            <label>Phone <input v-model="edit.phone" maxlength="50" /></label>
            <label>Company <input v-model="edit.company" maxlength="200" /></label>
            <div class="row-actions">
              <button class="btn">Save</button>
              <button type="button" class="btn btn-ghost" @click="editing = null">Cancel</button>
            </div>
          </form>
          <template v-else>
            <span class="avatar" aria-hidden="true">{{ initials(c.name) }}</span>
            <div class="who">
              <strong>{{ c.name }}</strong>
              <span>{{ [c.company, c.email, c.phone].filter(Boolean).join(' · ') || 'No details yet' }}</span>
            </div>
            <time :datetime="c.createdAt">{{ new Date(c.createdAt).toLocaleDateString() }}</time>
            <div class="row-actions">
              <button type="button" class="link" :aria-label="`Edit ${c.name}`" @click="startEdit(c)">Edit</button>
              <button type="button" class="link danger" :aria-label="`Delete ${c.name}`" @click="remove(c)">Delete</button>
            </div>
          </template>
        </li>
      </ul>
      <button v-if="nextCursor" class="btn btn-ghost more" :disabled="loading" @click="load(true)">Load more</button>
    </section>
  </div>
</template>

<style scoped>
.page {
  max-width: 1100px;
}
.search {
  flex: 0 1 340px;
}
.add,
.edit {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  align-items: end;
}
.edit {
  flex: 1;
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
.avatar {
  width: 36px;
  height: 36px;
  font-size: 12px;
}
.who {
  flex: 1 1 200px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow-wrap: anywhere;
}
.who span,
time {
  color: var(--muted);
}
.row-actions {
  display: flex;
  gap: 14px;
}
.danger {
  color: var(--danger);
}
.more {
  margin-top: 12px;
}
</style>
