import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import { refresh, session } from './api';
import App from './App.vue';
import './style.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: () => import('./views/AuthView.vue'), meta: { public: true } },
    { path: '/signup', component: () => import('./views/AuthView.vue'), meta: { public: true } },
    // Standalone pages: no session refresh, they must not rotate the signed-in tab's cookie.
    { path: '/invite/:token', component: () => import('./views/InviteView.vue'), meta: { public: true, standalone: true } },
    { path: '/f/:tenantId/:formId', component: () => import('./views/PublicFormView.vue'), meta: { public: true, standalone: true } },
    { path: '/', component: () => import('./views/TodayView.vue') },
    { path: '/pipeline', component: () => import('./views/PipelineView.vue') },
    { path: '/deals/:id', component: () => import('./views/DealView.vue') },
    { path: '/contacts', component: () => import('./views/ContactsView.vue') },
    { path: '/tasks', component: () => import('./views/TasksView.vue') },
    { path: '/templates', component: () => import('./views/TemplatesView.vue') },
    { path: '/rules', component: () => import('./views/RulesView.vue') },
    { path: '/rules/new', component: () => import('./views/RuleBuilderView.vue') },
    { path: '/rules/:id', component: () => import('./views/RuleBuilderView.vue') },
    { path: '/runs/:id?', component: () => import('./views/RunsView.vue') },
    { path: '/forms', component: () => import('./views/FormsView.vue') },
    { path: '/team', component: () => import('./views/TeamView.vue') },
    { path: '/:rest(.*)*', redirect: '/' },
  ],
});

let booted = false;
router.beforeEach(async (to) => {
  if (to.meta.standalone) return true;
  if (!booted) {
    booted = true;
    await refresh();
  }
  if (!to.meta.public && !session.value) return { path: '/login', query: to.fullPath === '/' ? {} : { next: to.fullPath } };
  if (to.meta.public && session.value) return '/';
  return true;
});

createApp(App).use(router).mount('#app');
