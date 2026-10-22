<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, errorText, session, type Session } from '../api';

const route = useRoute();
const router = useRouter();
const mode = computed(() => (route.path === '/signup' ? 'signup' : 'login'));
const form = reactive({ company: '', name: '', email: '', password: '' });
const busy = ref(false);
const error = ref('');

async function submit() {
  busy.value = true;
  error.value = '';
  try {
    const body = mode.value === 'signup' ? form : { email: form.email, password: form.password };
    session.value = await api<Session>(`/auth/${mode.value}`, { method: 'POST', body });
    const next = typeof route.query.next === 'string' && /^\/(?!\/)/.test(route.query.next) ? route.query.next : '/';
    router.replace(next);
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page">
    <section class="brand">
      <div class="logo">
        <svg width="34" height="34" viewBox="0 0 28 28" fill="none" aria-hidden="true">
          <rect width="28" height="28" rx="8" fill="#5B4FE9" />
          <circle cx="9" cy="14" r="3" stroke="#fff" stroke-width="2" />
          <circle cx="19" cy="14" r="3" stroke="#fff" stroke-width="2" />
          <path d="M12 14h4" stroke="#fff" stroke-width="2" />
        </svg>
        RelayCRM
      </div>
      <h1>Your pipeline, on autopilot.</h1>
      <p>Track leads and deals, and let rules handle the follow-ups, reliably, for every team on its own workspace.</p>
    </section>

    <main class="card form rise">
      <h2>{{ mode === 'signup' ? 'Create your workspace' : 'Welcome back' }}</h2>
      <form @submit.prevent="submit">
        <template v-if="mode === 'signup'">
          <label>Company name <input v-model="form.company" autocomplete="organization" required /></label>
          <label>Your name <input v-model="form.name" autocomplete="name" required /></label>
        </template>
        <label>Work email <input v-model="form.email" type="email" autocomplete="email" required /></label>
        <label>
          Password
          <input
            v-model="form.password"
            type="password"
            :autocomplete="mode === 'signup' ? 'new-password' : 'current-password'"
            :minlength="mode === 'signup' ? 8 : 1"
            required
          />
        </label>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <button class="btn" :disabled="busy">{{ mode === 'signup' ? 'Create workspace' : 'Sign in' }}</button>
      </form>
      <p class="switch">
        {{ mode === 'signup' ? 'Already have an account?' : 'New to RelayCRM?' }}
        <RouterLink class="link" :to="{ path: mode === 'signup' ? '/login' : '/signup', query: route.query }">
          {{ mode === 'signup' ? 'Sign in' : 'Create a workspace' }}
        </RouterLink>
      </p>
    </main>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  display: flex;
  flex-wrap: wrap;
}
.brand {
  flex: 1 1 380px;
  padding: 56px;
  color: #fff;
  background: var(--nav);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 16px;
}
.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 20px;
  font-weight: 800;
}
.brand h1 {
  margin: 24px 0 0;
  font-size: 40px;
  line-height: 1.1;
  letter-spacing: -0.03em;
}
.brand p {
  margin: 0;
  max-width: 440px;
  font-size: 16px;
  color: var(--nav-text);
}
.form {
  flex: 1 1 380px;
  max-width: 480px;
  margin: auto;
  padding: 32px;
}
.form h2 {
  margin: 0 0 18px;
  font-size: 24px;
  font-weight: 800;
  letter-spacing: -0.02em;
}
form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.switch {
  margin: 18px 0 0;
  color: var(--muted);
}
.link {
  border: 0;
  padding: 0;
  background: none;
  color: #4338ca;
  font-weight: 700;
}
@media (max-width: 720px) {
  .brand {
    padding: 32px 16px;
  }
  .form {
    margin: 16px;
  }
}
</style>
