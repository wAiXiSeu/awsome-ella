<script setup lang="ts">
import { ref } from 'vue'
import type { Auth } from '../core/auth'

// Spec §7 认证过期: local data and the outbox queue are untouched by every path here — signing in
// only re-arms push (onDone). The form never renders in local-only mode, where there is no client.
const props = defineProps<{ auth: Auth; onDone?: () => void }>()
const email = ref('')
const password = ref('')
const error = ref<string | null>(null)

async function submit() {
  error.value = null
  try {
    await props.auth.signIn(email.value, password.value)
    props.onDone?.()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}
</script>

<template>
  <form class="login" @submit.prevent="submit">
    <input v-model="email" type="email" placeholder="邮箱" />
    <input v-model="password" type="password" placeholder="密码" />
    <button type="submit">登录</button>
    <span v-if="error" class="error">{{ error }}</span>
  </form>
</template>
