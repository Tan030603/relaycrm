<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, logout, session, type Role, type Session } from './api';
import NewDealDialog from './NewDealDialog.vue';
import { initials } from './format';

const route = useRoute();
const router = useRouter();
const menuOpen = ref(false);
const search = ref('');
const dialog = ref<InstanceType<typeof NewDealDialog>>();
const workspaces = ref<{ id: string; name: string; role: Role }[]>([]);

const icons: Record<string, string> = {
  today: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  pipeline: 'M4.5 4h2a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 1 6.5 20h-2A1.5 1.5 0 0 1 3 18.5v-13A1.5 1.5 0 0 1 4.5 4zM11.5 4h2A1.5 1.5 0 0 1 15 5.5v8a1.5 1.5 0 0 1-1.5 1.5h-2a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 11.5 4zM18.5 4h1A1.5 1.5 0 0 1 21 5.5v4A1.5 1.5 0 0 1 19.5 11h-1A1.5 1.5 0 0 1 17 9.5v-4A1.5 1.5 0 0 1 18.5 4z',
  contacts: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21c1.5-4 4.5-6 8-6s6.5 2 8 6',
  tasks: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9',
  templates: 'M4.5 3h4A1.5 1.5 0 0 1 10 4.5v4A1.5 1.5 0 0 1 8.5 10h-4A1.5 1.5 0 0 1 3 8.5v-4A1.5 1.5 0 0 1 4.5 3zM15.5 3h4A1.5 1.5 0 0 1 21 4.5v4a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 14 8.5v-4A1.5 1.5 0 0 1 15.5 3zM4.5 14h4a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 8.5 21h-4A1.5 1.5 0 0 1 3 19.5v-4A1.5 1.5 0 0 1 4.5 14zM15.5 14h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5v-4a1.5 1.5 0 0 1 1.5-1.5z',
  rules: 'M13 2L4 14h7l-1 8 9-12h-7z',
  runs: 'M4 6h16M4 12h16M4 18h10',
  forms: 'M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8 8h8M8 12h8M8 16h5',
  team: 'M9 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM2 21c1-4 3.5-6 7-6s6 2 7 6M17 4.5a3.5 3.5 0 0 1 0 7M19 15c1.6.8 2.6 2.8 3 6',
};
const sections = [
  { links: [['/', 'Today', 'today'], ['/pipeline', 'Pipeline', 'pipeline'], ['/contacts', 'Contacts', 'contacts'], ['/tasks', 'Tasks', 'tasks']] },
  { title: 'Automation', links: [['/templates', 'Templates', 'templates'], ['/rules', 'Rules', 'rules'], ['/runs', 'Run log', 'runs']] },
  { title: 'Capture', links: [['/forms', 'Lead forms', 'forms']] },
  { title: 'Workspace', links: [['/team', 'Team', 'team']] },
];
const active = (to: string) => (to === '/' ? route.path === '/' : route.path.startsWith(to) || (to === '/pipeline' && route.path.startsWith('/deals')));

watch(session, (s) => {
  if (!s && !route.meta.public) router.replace('/login');
});
watch(
  () => session.value?.tenant.id,
  async (id) => {
    if (id) workspaces.value = await api<typeof workspaces.value>('/auth/workspaces').catch(() => []);
  },
  { immediate: true },
);
watch(() => route.fullPath, () => (menuOpen.value = false));

async function switchTo(e: Event) {
  const tenantId = (e.target as HTMLSelectElement).value;
  session.value = await api<Session>('/auth/switch', { method: 'POST', body: { tenantId } });
  router.push('/');
}

function find() {
  router.push({ path: '/contacts', query: search.value.trim() ? { q: search.value.trim() } : {} });
}

async function signOut() {
  await logout();
  router.replace('/login');
}
</script>

<template>
  <RouterView v-if="route.meta.public" />
  <div v-else-if="session" class="shell">
    <nav aria-label="Main" :class="{ open: menuOpen }">
      <div class="logo">
        <svg width="30" height="30" viewBox="0 0 28 28" fill="none" aria-hidden="true">
          <rect width="28" height="28" rx="8" fill="#5B4FE9" />
          <circle cx="9" cy="14" r="3" stroke="#fff" stroke-width="2" />
          <circle cx="19" cy="14" r="3" stroke="#fff" stroke-width="2" />
          <path d="M12 14h4" stroke="#fff" stroke-width="2" />
        </svg>
        RelayCRM
        <button type="button" class="menu" :aria-expanded="menuOpen" aria-controls="nav-links" @click="menuOpen = !menuOpen">
          {{ menuOpen ? 'Close' : 'Menu' }}
        </button>
      </div>
      <div id="nav-links" class="links">
        <template v-for="s in sections" :key="s.title ?? 'main'">
          <div v-if="s.title" class="section">{{ s.title }}</div>
          <RouterLink v-for="[to, label, icon] in s.links" :key="to" :to="to" :class="{ active: active(to) }" :aria-current="active(to) ? 'page' : undefined">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path :d="icons[icon]" /></svg>
            {{ label }}
          </RouterLink>
        </template>
        <div class="me">
          <span class="avatar" aria-hidden="true">{{ initials(session.user.name) }}</span>
          <div>
            <strong>{{ session.user.name }}</strong>
            <span>{{ session.role === 'owner' ? 'Owner' : 'Rep' }} · {{ session.tenant.name }}</span>
          </div>
          <label v-if="workspaces.length > 1" class="ws">
            <span class="sr-only">Switch workspace</span>
            <select :value="session.tenant.id" @change="switchTo">
              <option v-for="w in workspaces" :key="w.id" :value="w.id">{{ w.name }}</option>
            </select>
          </label>
          <button type="button" class="out" @click="signOut">Sign out</button>
        </div>
      </div>
    </nav>
    <main>
      <header class="top">
        <form role="search" @submit.prevent="find">
          <label for="global-search" class="sr-only">Search contacts</label>
          <input id="global-search" v-model="search" type="search" placeholder="Search contacts…" />
        </form>
        <button type="button" class="btn" @click="dialog?.open()">+ New deal</button>
      </header>
      <RouterView :key="session.tenant.id" />
    </main>
    <NewDealDialog ref="dialog" @created="(d) => router.push(`/deals/${d.id}`)" />
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
  max-width: 260px;
  padding: 20px 14px;
  background: var(--nav);
  color: var(--nav-text);
  display: flex;
  flex-direction: column;
}
.links {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
main {
  flex: 999 1 560px;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 10px 22px;
  font-size: 18px;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: #fff;
}
.menu {
  display: none;
  margin-left: auto;
  min-height: 38px;
  padding: 0 12px;
  border: 1px solid var(--nav-active);
  border-radius: 8px;
  background: transparent;
  color: #fff;
  font-weight: 600;
}
.section {
  padding: 18px 10px 6px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #8e92c2;
}
nav a {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 40px;
  padding: 0 10px;
  border-radius: 8px;
  text-decoration: none;
  color: var(--nav-text);
  transition: background 0.15s;
}
nav a:hover {
  background: rgba(255, 255, 255, 0.06);
  color: #fff;
}
nav a.active {
  background: var(--nav-active);
  color: #fff;
  font-weight: 600;
}
nav a:focus-visible,
.menu:focus-visible,
.out:focus-visible {
  outline-color: #fff;
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
  flex: 1 1 120px;
  min-width: 0;
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
.ws {
  flex-basis: 100%;
}
.ws select {
  background: var(--nav-active);
  color: #fff;
  border-color: var(--nav-active);
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
  margin-left: auto;
  min-height: 36px;
  padding: 0 10px;
  border: 1px solid var(--nav-active);
  border-radius: 8px;
  background: transparent;
  color: #fff;
  cursor: pointer;
}
.top {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 28px;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}
.top form {
  flex: 1 1 240px;
  max-width: 460px;
}
.top input {
  background: var(--ground);
}
.top .btn {
  margin-left: auto;
  white-space: nowrap;
}
@media (max-width: 760px) {
  nav {
    flex-basis: 100%;
    max-width: none;
    padding: 10px 16px;
  }
  .logo {
    padding: 4px 0;
  }
  .menu {
    display: block;
  }
  .links {
    display: none;
    padding-bottom: 8px;
  }
  nav.open .links {
    display: flex;
  }
  .top {
    padding: 12px 16px;
  }
}
</style>
