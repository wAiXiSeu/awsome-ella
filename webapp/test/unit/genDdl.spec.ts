import { describe, it, expect } from 'vitest'
import { renderDdl } from '../../src/tools/genDdl'
import { TABLE_DEFS } from '../../src/core/schema'

const ddl = renderDdl()

describe('ddl generator (spec §4)', () => {
  it('one create table per registered def, in registry order', () => {
    for (const d of TABLE_DEFS) expect(ddl).toContain(`create table if not exists public.${d.name} (`)
    const pos = TABLE_DEFS.map(d => ddl.indexOf(`public.${d.name} (`))
    expect([...pos].sort((a, b) => a - b)).toEqual(pos)
  })

  it('audit columns exactly as spec §4', () => {
    expect(ddl).toContain('owner_id uuid not null')
    expect(ddl).toContain('seq bigint not null')
    expect(ddl).toContain('updated_at timestamptz not null default now()')
    expect(ddl).toContain('deleted_at timestamptz')
    expect(ddl).toContain('device_id text not null')
  })

  it('every table gets the updated_at trigger and the 4 RLS policies', () => {
    for (const d of TABLE_DEFS) {
      expect(ddl).toContain(`create trigger trg_${d.name}_updated_at before insert or update on public.${d.name}`)
      expect(ddl).toContain(`alter table public.${d.name} enable row level security;`)
      for (const cmd of ['select', 'insert', 'update', 'delete']) {
        expect(ddl).toContain(`create policy ${cmd}_${d.name} on public.${d.name} for ${cmd}`)
      }
      expect(ddl).toContain(`alter publication supabase_realtime add table public.${d.name};`)
    }
  })

  it('policies use the spec §4 predicate and only the clauses Postgres accepts per verb', () => {
    const pred = 'owner_id = (select auth.uid())'
    for (const d of TABLE_DEFS) {
      expect(ddl).toContain(`create policy select_${d.name} on public.${d.name} for select using (${pred});`)
      expect(ddl).toContain(`create policy insert_${d.name} on public.${d.name} for insert with check (${pred});`)
      expect(ddl).toContain(`create policy update_${d.name} on public.${d.name} for update using (${pred}) with check (${pred});`)
      expect(ddl).toContain(`create policy delete_${d.name} on public.${d.name} for delete using (${pred});`)
    }
    // a select policy with WITH CHECK is a hard error in Postgres
    expect(ddl).not.toMatch(/for select using \([^)]*\) with check/)
  })

  it('every create table body ends its column list with commas, not before the closing paren', () => {
    for (const block of ddl.split('create table if not exists').slice(1)) {
      const cols = block.slice(0, block.indexOf(');')).split('\n').filter(l => l.trim().startsWith('"') || l.trim().startsWith('id ') || l.trim().startsWith('owner_id') || l.trim().startsWith('seq') || l.trim().startsWith('updated_at') || l.trim().startsWith('deleted_at') || l.trim().startsWith('device_id'))
      expect(cols.length).toBeGreaterThan(6)
      // all but the last column line must carry a trailing comma
      cols.slice(0, -1).forEach(line => expect(line.trimEnd().endsWith(',')).toBe(true))
      expect(cols[cols.length - 1].trimEnd().endsWith(',')).toBe(false)
    }
  })

  it('business columns are snake_case, matching what the sync payload sends', () => {
    expect(ddl).toContain('"student_no" text')
    expect(ddl).toContain('"guardian1_phone" text')
    expect(ddl).toContain('"photo_path" text')
    expect(ddl).toContain('"image_paths" jsonb')
    expect(ddl).toContain('"week_type" text')
    expect(ddl).not.toContain('"studentNo"')
    expect(ddl).not.toContain('"photoPath"')
  })

  it('typed columns follow the registry, not a hand-written list', () => {
    expect(ddl).toContain('"tags" jsonb')
    expect(ddl).toContain('"scores" jsonb')
    expect(ddl).toContain('"records" jsonb')
    expect(ddl).toContain('"student_id" uuid')
    expect(ddl).toContain('"completed" boolean')
    expect(ddl).toContain('"group" double precision')
  })

  it('exams exists (the table the old import silently dropped) and no idCard column anywhere', () => {
    expect(ddl).toContain('create table if not exists public.exams (')
    expect(ddl.toLowerCase()).not.toContain('idcard')
    expect(ddl.toLowerCase()).not.toContain('id_card')
  })
})
