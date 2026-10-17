import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TABLE_DEFS, tableNames, type TableDef } from '../core/schema'
import { camelToSnake } from '../core/case'

/**
 * DDL is generated from the registry, never maintained beside it (acceptance criterion 6): the same
 * TableDef that produces the Dexie schema, the sync table list and the migration mapping also
 * produces the remote columns, so registry == local rows == SQL can only drift together.
 */

const AUDIT = [
  '  id uuid primary key,',
  '  owner_id uuid not null references auth.users (id) on delete cascade,',
  '  seq bigint not null,',
  '  updated_at timestamptz not null default now(),',
  '  deleted_at timestamptz,',
  '  device_id text not null,',
]

const POLICIES = ['select', 'insert', 'update', 'delete'] as const

/**
 * The same predicate for every verb (spec §4), wrapped in a sub-select so Postgres evaluates
 * `auth.uid()` once per query instead of once per row. PostgreSQL accepts `using` only for verbs that
 * read an existing row and `with check` only for verbs that write one, so the clauses are not uniform.
 */
const PRED = 'owner_id = (select auth.uid())'

function policyLine(table: string, cmd: (typeof POLICIES)[number]): string {
  const head = `create policy ${cmd}_${table} on public.${table} for ${cmd}`
  if (cmd === 'select' || cmd === 'delete') return `${head} using (${PRED});`
  if (cmd === 'insert') return `${head} with check (${PRED});`
  return `${head} using (${PRED}) with check (${PRED});`
}

function colType(def: TableDef, column: string): string {
  return def.sql?.[column] ?? 'text'
}

/** Business columns come out snake_case: that is what `toRemoteRow` sends and `fromRemoteRow` expects. */
function columnsOf(def: TableDef): string {
  return def.columns.map(c => `  "${camelToSnake(c)}" ${colType(def, c)}`).join(',\n')
}

export function renderDdl(): string {
  const out: string[] = [
    '-- GENERATED from webapp/src/core/schema.ts via `npm run gen:ddl`.',
    '-- Column semantics live in the registry; edit webapp/src/core/schema.ts and regenerate.',
    `-- tables: ${tableNames().join(', ')}`,
    '',
    '-- spec §5.2: the server owns updated_at, because push payloads never carry it.',
    'create or replace function public.set_updated_at() returns trigger language plpgsql as $fn$ begin new.updated_at = now(); return new; end $fn$;',
    '',
  ]
  for (const def of TABLE_DEFS) {
    out.push(
      `create table if not exists public.${def.name} (`,
      AUDIT.join('\n'),
      columnsOf(def),
      ');',
      `drop trigger if exists trg_${def.name}_updated_at on public.${def.name};`,
      `create trigger trg_${def.name}_updated_at before insert or update on public.${def.name} for each row execute function public.set_updated_at();`,
      `alter table public.${def.name} enable row level security;`,
      ...POLICIES.flatMap(cmd => [
        `drop policy if exists ${cmd}_${def.name} on public.${def.name};`,
        policyLine(def.name, cmd),
      ]),
      `alter publication supabase_realtime add table public.${def.name};`,
      '',
    )
  }
  return out.join('\n')
}

/** Runs only when invoked as a script (`npm run gen:ddl`); importing this module for tests writes nothing. */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url))
const OUT_FILE = MIGRATIONS_DIR + '202610170001_initial.sql'

if (process.argv[1]?.includes('genDdl')) {
  mkdirSync(MIGRATIONS_DIR, { recursive: true })
  // Generated files are frozen once they exist: subprojects 2-4 tune per-column types by hand here.
  if (existsSync(OUT_FILE)) console.log('skip: ' + OUT_FILE + ' already exists')
  else { writeFileSync(OUT_FILE, renderDdl()); console.log('wrote ' + OUT_FILE) }
}
