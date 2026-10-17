<script setup lang="ts">
import { onMounted, ref, shallowRef } from 'vue'
import { bootstrap, lastStorageMode, type AppContext, type StorageMode } from './bootstrap'
import { runMigration, migrationDone, type MigrationReport } from './core/migration'
import StatusBanner from './components/StatusBanner.vue'
import LoginForm from './components/LoginForm.vue'

// Infra-only shell (plan Task 17), not UI design: it proves the local-first contract end to end —
// writes land locally, sync state is a separate signal, and everything runs with zero credentials.
// shallowRef: the context holds Dexie/engine class instances, which deep ref() unwrapping would strip.
const ctx = shallowRef<AppContext | null>(null)
const storageMode = ref<StorageMode | null>(null)
const showMigrate = ref(false)
const report = ref<MigrationReport | null>(null)
const bootError = ref<string | null>(null)
const banner = ref<InstanceType<typeof StatusBanner> | null>(null)

onMounted(async () => {
  try {
    const c = await bootstrap()
    ctx.value = c
    storageMode.value = lastStorageMode                 // read directly, never via dynamic import
    showMigrate.value = !!localStorage.getItem('wb_tw_data') && !(await migrationDone(c.db))
  } catch (e) {
    bootError.value = e instanceof Error ? `${e.name}: ${e.message}` : String(e)   // spec §7: surface, never blank-screen
  }
})

async function demoSave() {
  const c = ctx.value
  if (!c) return
  await c.store.put('todos', { id: crypto.randomUUID(), title: 'demo ' + Date.now(), completed: false })
  banner.value?.saved()                               // 已保存（本地）…
  await c.engine.pushOnce()                           // …and separately: 待同步 N 条 / 已同步
}

async function migrate() {
  const c = ctx.value
  if (!c) return
  const raw = localStorage.getItem('wb_tw_data')
  if (!raw) return
  const { db, store, meta, images, auth } = c
  report.value = await runMigration({ db, store, meta, images, ownerUid: () => auth.currentUid(), json: JSON.parse(raw) })
  showMigrate.value = false
  banner.value?.saved()
  await c.engine.pushOnce()
}

function total(r: MigrationReport | null): number {
  return r ? Object.values(r.perTable).reduce((a, b) => a + b, 0) : 0
}
</script>

<template>
  <div v-if="storageMode === 'in-memory-fallback'" class="warn">
    浏览器不支持持久化存储（无痕模式？）——本次会话数据不会保存
  </div>

  <h1>Class app (infra only)</h1>

  <p v-if="bootError" class="error">启动失败：{{ bootError }}</p>

  <StatusBanner v-if="ctx" ref="banner" :engine="ctx.engine" />
  <LoginForm v-if="ctx && !ctx.auth.currentUid()" :auth="ctx.auth" :on-done="() => ctx?.engine.syncOnce()" />

  <p v-if="ctx && ctx.mode === 'local-only'">
    离线模式：未配置 Supabase 凭据，数据只存本地并排队待同步。
  </p>

  <button @click="demoSave">写入一条（验证 已保存/待同步 分离）</button>
  <button v-if="showMigrate" @click="migrate">导入旧版数据（一次性，先备份）</button>

  <p v-if="report">
    已导入 {{ total(report) }} 条
    <template v-if="report.unmappedFields.length">
      · 未识别字段：{{ report.unmappedFields.join('、') }}
    </template>
  </p>
</template>

<style scoped>
.warn { background: #fff4e5; color: #8a5300; padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; }
.status { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; font-size: 14px; }
.status .saved { color: #2f7d32; }
.status .pending { color: #8a5300; }
.status .synced { color: #666; }
.status .error { color: #b3261e; }
.error { color: #b3261e; }
.login { display: flex; gap: 8px; margin-bottom: 12px; }
button { margin-right: 8px; }
</style>
