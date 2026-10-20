<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, errorText, session, type Session } from '../api';

const route = useRoute();
const router = useRouter();
const token = route.params.token as string;
const inv = ref<{ email: string; role: string; tenant: string; hasAccount: boolean }>();
const error = ref('');
const form = reactive({ name: '', password: '' });
const busy = ref(false);

api<NonNullable<typeof inv.value>>(`/invitations/${encodeURIComponent(token)}`)
  .then((r) => (inv.value = r))
  .catch((e) => (error.value = errorText(e)));

async function accept() {
  busy.value = true;
  error.value = '';
  try {
    const body = inv.value?.hasAccount ? { password: form.password } : form;
    session.value = await api<Session>(`/invitations/${encodeURIComponent(token)}/accept`, { method: 'POST', body });
    router.replace('/');
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="wrap">
    <div class="card box rise">
      <div class="logo">
        <svg width="30" height="30" viewBox="0 0 28 28" fill="none" aria-hidden="true">
          <rect width="28" height="28" rx="8" fill="#5B4FE9" />
          <circle cx="9" cy="14" r="3" stroke="#fff" stroke-width="2" />
          <circle cx="19" cy="14" r="3" stroke="#fff" stroke-width="2" />
          <path d="M12 14h4" stroke="#fff" stroke-width="2" />
        </svg>
        RelayCRM
      </div>
      <template v-if="inv">
        <h1>Join {{ inv.tenant }}</h1>
        <p class="muted">You were invited as {{ inv.role === 'owner' ? 'an owner' : 'a rep' }} with <strong>{{ inv.email }}</strong>.</p>
        <form @submit.prevent="accept">
          <label v-if="!inv.hasAccount">Your name <input v-model="form.name" autocomplete="name" required maxlength="100" /></label>
          <label>
            {{ inv.hasAccount ? 'Your RelayCRM password' : 'Choose a password' }}
            <input v-model="form.password" type="password" :autocomplete="inv.hasAccount ? 'current-password' : 'new-password'" minlength="8" required />
          </label>
          <p v-if="error" class="error" role="alert">{{ error }}</p>
          <button class="btn" :disabled="busy">Join workspace</button>
        </form>
      </template>
      <template v-else-if="error">
        <h1>This invite does not work</h1>
        <p class="error" role="alert">{{ error }}</p>
        <RouterLink to="/login">Go to sign in</RouterLink>
      </template>
      <p v-else class="muted" aria-live="polite">Checking your invite…</p>
    </div>
  </main>
</template>

<style scoped>
.wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: var(--nav);
}
.box {
  width: min(440px, 100%);
  padding: 32px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 800;
  font-size: 18px;
}
h1 {
  margin: 12px 0 0;
  font-size: 24px;
  font-weight: 800;
  letter-spacing: -0.02em;
}
p {
  margin: 0;
}
form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 8px;
}
</style>
