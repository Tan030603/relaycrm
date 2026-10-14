<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ApiError, api, type Contact } from './api';

const contacts = ref<Contact[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const form = reactive({ name: '', email: '', company: '' });
const saving = ref(false);
const error = ref('');

async function load(more = false) {
  loading.value = true;
  try {
    const q = more && nextCursor.value ? `?cursor=${nextCursor.value}` : '';
    const page = await api<{ data: Contact[]; nextCursor: string | null }>(`/contacts${q}`);
    contacts.value = more ? [...contacts.value, ...page.data] : page.data;
    nextCursor.value = page.nextCursor;
  } finally {
    loading.value = false;
  }
}

async function add() {
  saving.value = true;
  error.value = '';
  try {
    const body = Object.fromEntries(Object.entries(form).filter(([, v]) => v.trim() !== ''));
    const created = await api<Contact>('/contacts', { method: 'POST', body });
    contacts.value = [created, ...contacts.value];
    Object.assign(form, { name: '', email: '', company: '' });
  } catch (e) {
    error.value = e instanceof ApiError && e.details?.length ? e.details.map((d) => d.message).join(' · ') : String(e);
  } finally {
    saving.value = false;
  }
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

onMounted(() => load());
</script>

<template>
  <div class="wrap">
    <h1>Contacts</h1>

    <form class="card add rise" @submit.prevent="add">
      <label>Name <input v-model="form.name" required maxlength="200" /></label>
      <label>Email <input v-model="form.email" type="email" /></label>
      <label>Company <input v-model="form.company" maxlength="200" /></label>
      <button class="btn" :disabled="saving">Add contact</button>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </form>

    <section class="card list rise" style="animation-delay: 80ms" aria-label="Contacts">
      <p v-if="!loading && contacts.length === 0" class="empty">No contacts yet. Add your first one above.</p>
      <ul>
        <li v-for="c in contacts" :key="c.id">
          <span class="avatar" aria-hidden="true">{{ initials(c.name) }}</span>
          <div class="who">
            <strong>{{ c.name }}</strong>
            <span>{{ [c.company, c.email].filter(Boolean).join(' · ') || 'No details yet' }}</span>
          </div>
          <time :datetime="c.createdAt">{{ new Date(c.createdAt).toLocaleDateString() }}</time>
        </li>
      </ul>
      <button v-if="nextCursor" class="btn btn-ghost more" :disabled="loading" @click="load(true)">Load more</button>
    </section>
  </div>
</template>

<style scoped>
.wrap {
  padding: 28px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 1100px;
}
h1 {
  margin: 0;
  font-size: 30px;
  font-weight: 800;
  letter-spacing: -0.025em;
}
.add {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
  align-items: end;
}
.add .error {
  grid-column: 1 / -1;
  margin: 0;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-top: 1px solid #f0eef7;
}
li:first-child {
  border-top: 0;
}
.avatar {
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  color: #fff;
  background: var(--accent);
}
.who {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.who span,
time,
.empty {
  color: var(--muted);
}
.more {
  margin-top: 12px;
}
@media (max-width: 720px) {
  .wrap {
    padding: 16px;
  }
}
</style>
