<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { api, errorText, session, type Member, type Role } from '../api';
import { copy, initials } from '../format';

const members = ref<Member[]>([]);
const pending = ref<{ id: string; email: string; role: Role; expiresAt: string }[]>([]);
const loading = ref(true);
const error = ref('');
const form = reactive({ email: '', role: 'rep' as Role });
const busy = ref(false);
const invite = ref<{ email: string; inviteUrl: string }>();
const copied = ref(false);
const owner = computed(() => session.value?.role === 'owner');

async function load() {
  try {
    [members.value, pending.value] = await Promise.all([api<Member[]>('/members'), api<typeof pending.value>('/invitations')]);
  } catch (e) {
    error.value = errorText(e);
  } finally {
    loading.value = false;
  }
}

async function send() {
  busy.value = true;
  error.value = '';
  copied.value = false;
  try {
    invite.value = await api<{ email: string; inviteUrl: string }>('/invitations', { method: 'POST', body: form });
    form.email = '';
    load();
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}

async function copyLink() {
  await copy(invite.value!.inviteUrl);
  copied.value = true;
}

load();
</script>

<template>
  <div class="page">
    <h1>Team</h1>
    <p v-if="error" class="error notice" role="alert">{{ error }}</p>

    <form v-if="owner" class="card invite rise" @submit.prevent="send">
      <h2>Invite a teammate</h2>
      <div class="row">
        <label class="email">Email <input v-model="form.email" type="email" required /></label>
        <label>
          Role
          <select v-model="form.role">
            <option value="rep">Rep: works their own deals</option>
            <option value="owner">Owner: full access</option>
          </select>
        </label>
        <button class="btn" :disabled="busy">Send invite</button>
      </div>
      <div v-if="invite" class="result" aria-live="polite">
        <p class="flush">Invite sent to <strong>{{ invite.email }}</strong>. You can also share this link (valid 7 days):</p>
        <div class="link-row">
          <input :value="invite.inviteUrl" readonly aria-label="Invite link" class="mono" @focus="($event.target as HTMLInputElement).select()" />
          <button type="button" class="btn btn-ghost" @click="copyLink">{{ copied ? 'Copied' : 'Copy' }}</button>
        </div>
        <p class="small muted flush">In local development the email lands in Mailpit at <a href="http://localhost:8025" target="_blank" rel="noopener">localhost:8025</a>.</p>
      </div>
    </form>

    <section class="card rise" style="animation-delay: 60ms" aria-labelledby="m-h">
      <h2 id="m-h">Members</h2>
      <p v-if="loading" class="muted">Loading…</p>
      <ul>
        <li v-for="m in members" :key="m.id">
          <span class="avatar" aria-hidden="true">{{ initials(m.name) }}</span>
          <div class="who">
            <strong>{{ m.name }}{{ m.id === session?.user.id ? ' (you)' : '' }}</strong>
            <span class="muted small">{{ m.email }}</span>
          </div>
          <span class="pill" :class="m.role === 'owner' ? '' : 'off'">{{ m.role === 'owner' ? 'Owner' : 'Rep' }}</span>
          <span class="muted small">Joined {{ new Date(m.joinedAt).toLocaleDateString() }}</span>
        </li>
      </ul>
    </section>

    <section class="card rise" style="animation-delay: 120ms" aria-labelledby="p-h">
      <h2 id="p-h">Pending invitations</h2>
      <p v-if="!loading && !pending.length" class="muted">No pending invitations.</p>
      <ul>
        <li v-for="p in pending" :key="p.id">
          <div class="who">
            <strong>{{ p.email }}</strong>
            <span class="muted small">Expires {{ new Date(p.expiresAt).toLocaleDateString() }}</span>
          </div>
          <span class="pill off">{{ p.role === 'owner' ? 'Owner' : 'Rep' }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.page {
  max-width: 900px;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
}
.row label {
  flex: 1 1 200px;
}
.row .email {
  flex: 2 1 240px;
}
.result {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border-radius: 12px;
  background: #e3f5e8;
}
.link-row {
  display: flex;
  gap: 8px;
}
.link-row input {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
}
.flush {
  margin: 0;
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
}
.who {
  flex: 1 1 200px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow-wrap: anywhere;
}
</style>
