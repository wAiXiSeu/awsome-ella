<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { SyncEngine, SyncState } from '../core/syncEngine'
import { quotaNag } from '../core/images'

const props = defineProps<{ engine: SyncEngine }>()
const pending = ref(0)
const lastError = ref<string | null>(null)
const savedMsg = ref<string | null>(null)
const quotaMsg = ref<string | null>(null)
let savedTimer: ReturnType<typeof setTimeout> | undefined

function onState(s: SyncState) {
  pending.value = s.pending
  lastError.value = s.lastError
  void quotaNag().then(m => { quotaMsg.value = m })     // spec §7 quota row: warn before a write fails
}

onMounted(() => { props.engine.onState = onState })
onUnmounted(() => { props.engine.onState = null; clearTimeout(savedTimer) })

/**
 * 已保存 ≠ 已同步 (spec §5.1): business code flashes this after a local write; the pending count is
 * the separate, engine-owned signal. Never merged into one toast.
 */
function saved() {
  savedMsg.value = '已保存（本地）'
  clearTimeout(savedTimer)
  savedTimer = setTimeout(() => { savedMsg.value = null }, 1500)
}
defineExpose({ saved })
</script>

<template>
  <div class="status">
    <span v-if="savedMsg" class="saved">{{ savedMsg }}</span>
    <span v-if="pending > 0" class="pending">待同步 {{ pending }} 条</span>
    <span v-else class="synced">已同步</span>
    <span v-if="lastError" class="error">{{ lastError }}</span>
    <span v-if="quotaMsg" class="error">{{ quotaMsg }}</span>
  </div>
</template>
