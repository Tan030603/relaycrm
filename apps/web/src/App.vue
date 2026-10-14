<script setup lang="ts">
import { session } from './api';
import AuthView from './AuthView.vue';
import ContactsView from './ContactsView.vue';

// Screens from the design that later phases fill in.
const soon = ['Today', 'Pipeline', 'Tasks', 'Templates', 'Rules', 'Run log', 'Lead forms'];
</script>

<template>
  <AuthView v-if="!session" />
  <div v-else class="shell">
    <nav aria-label="Main">
      <div class="logo">
        <svg width="30" height="30" viewBox="0 0 28 28" fill="none" aria-hidden="true">
          <rect width="28" height="28" rx="8" fill="#5B4FE9" />
          <circle cx="9" cy="14" r="3" stroke="#fff" stroke-width="2" />
          <circle cx="19" cy="14" r="3" stroke="#fff" stroke-width="2" />
          <path d="M12 14h4" stroke="#fff" stroke-width="2" />
        </svg>
        RelayCRM
      </div>
      <a href="#" class="active" aria-current="page">Contacts</a>
      <span v-for="s in soon" :key="s" class="soon">{{ s }} <small>soon</small></span>
      <div class="me">
        <span class="avatar" aria-hidden="true">{{ session.user.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() }}</span>
        <div>
          <strong>{{ session.user.name }}</strong>
          <span>{{ session.role }} · {{ session.tenant.name }}</span>
        </div>
        <button type="button" class="out" @click="session = null">Sign out</button>
      </div>
    </nav>
    <main>
      <ContactsView />
    </main>
  </div>
</template>

<style scoped>
.shell {
  min-height: 100vh;
  display: flex;
  flex-wrap: wrap;
}
nav {
  flex: 1 1 230px;
  padding: 20px 14px;
  background: var(--nav);
  color: var(--nav-text);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
main {
  flex: 999 1 560px;
  min-width: 0;
}
.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 10px 22px;
  font-size: 18px;
  font-weight: 800;
  color: #fff;
}
nav a,
.soon {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 40px;
  padding: 0 10px;
  border-radius: 8px;
  text-decoration: none;
  color: var(--nav-text);
}
nav a.active {
  background: var(--nav-active);
  color: #fff;
  font-weight: 600;
}
.soon {
  color: #8e92c2;
}
.soon small {
  font-size: 11px;
}
.me {
  margin-top: auto;
  padding: 16px 10px 4px;
  border-top: 1px solid var(--nav-active);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.me div {
  flex: 1;
  display: flex;
  flex-direction: column;
}
.me strong {
  color: #fff;
}
.me span:not(.avatar) {
  font-size: 12px;
  color: #a9acd6;
}
.avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  color: #fff;
  background: var(--accent);
}
.out {
  min-height: 36px;
  padding: 0 10px;
  border: 1px solid var(--nav-active);
  border-radius: 8px;
  background: transparent;
  color: #fff;
  cursor: pointer;
}
</style>
