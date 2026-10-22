<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api, errorText } from '../api';

interface PublicForm {
  name: string;
  headline: string;
  tenant: string;
  fields: { key: string; label: string; required: boolean }[];
}

const route = useRoute();
const path = `/public/forms/${route.params.tenantId}/${route.params.formId}`;
const form = ref<PublicForm>();
const values = reactive<Record<string, string>>({ website: '' });
const loadError = ref('');
const error = ref('');
const busy = ref(false);
const sent = ref(false);
const TYPES: Record<string, string> = { email: 'email', phone: 'tel' };
const AUTO: Record<string, string> = { name: 'name', email: 'email', company: 'organization', phone: 'tel' };

api<PublicForm>(path)
  .then((f) => (form.value = f))
  .catch((e) => (loadError.value = errorText(e)));

async function submit() {
  busy.value = true;
  error.value = '';
  try {
    const body = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v !== ''));
    await api(path, { method: 'POST', body });
    sent.value = true;
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="wrap">
    <p v-if="loadError" class="error" role="alert">{{ loadError }}</p>
    <p v-else-if="!form" class="muted">Loading…</p>
    <div v-else-if="sent" class="done rise" role="status">
      <span class="check" aria-hidden="true">✓</span>
      <h1>Thanks, we got it.</h1>
      <p class="muted">Someone from {{ form.tenant }} will reply within one working day.</p>
    </div>
    <form v-else class="rise" @submit.prevent="submit">
      <h1>{{ form.headline }}</h1>
      <p class="muted">Tell us what you need and {{ form.tenant }} will get back to you.</p>
      <div class="grid">
        <label v-for="f in form.fields" :key="f.key" :class="{ full: f.key === 'message' }">
          <span>{{ f.label }}<span v-if="f.required" aria-hidden="true"> *</span></span>
          <textarea v-if="f.key === 'message'" v-model="values[f.key]" rows="4" :required="f.required" maxlength="5000"></textarea>
          <input v-else v-model="values[f.key]" :type="TYPES[f.key] ?? 'text'" :autocomplete="AUTO[f.key]" :required="f.required" maxlength="200" />
        </label>
      </div>
      <div class="hp" aria-hidden="true">
        <label>Website <input v-model="values.website" name="website" tabindex="-1" autocomplete="off" /></label>
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button class="btn" :disabled="busy">{{ busy ? 'Sending…' : 'Send message' }}</button>
      <span class="small muted powered">Powered by RelayCRM</span>
    </form>
  </main>
</template>

<style scoped>
.wrap {
  min-height: 100vh;
  padding: 28px 20px;
  background: var(--surface);
}
form,
.done {
  max-width: 560px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
h1 {
  margin: 0;
  font-size: 24px;
  font-weight: 800;
  letter-spacing: -0.02em;
}
p {
  margin: 0;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 14px;
}
.full {
  grid-column: 1 / -1;
}
.hp {
  position: absolute;
  left: -10000px;
  width: 1px;
  height: 1px;
  overflow: hidden;
}
.btn {
  align-self: flex-start;
}
.powered {
  text-align: center;
}
.done {
  align-items: center;
  text-align: center;
  padding-top: 40px;
}
.check {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 26px;
  font-weight: 800;
  color: #fff;
  background: #15803d;
}
</style>
