-- GENERATED from webapp/src/core/schema.ts via `npm run gen:ddl`.
-- Column semantics live in the registry; edit webapp/src/core/schema.ts and regenerate.
-- tables: students, notices, comments, todos, schedule, seating, duty, violations, communications, grades, exams, homework, points, activities, behaviors, committee, settings

-- spec §5.2: the server owns updated_at, because push payloads never carry it.
create or replace function public.set_updated_at() returns trigger language plpgsql as $fn$ begin new.updated_at = now(); return new; end $fn$;

create table if not exists public.students (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  seq bigint not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  device_id text not null,
  "name" text,
  "student_no" text,
  "gender" text,
  "primary_school" text,
  "address" text,
  "guardian1_name" text,
  "guardian1_phone" text,
  "guardian2_name" text,
  "guardian2_phone" text,
  "group" double precision,
  "tags" jsonb,
  "notes" text,
  "photo_path" text,
  "guardian1_email" text
);
drop trigger if exists trg_students_updated_at on public.students;
create trigger trg_students_updated_at before insert or update on public.students for each row execute function public.set_updated_at();
alter table public.students enable row level security;
drop policy if exists select_students on public.students;
create policy select_students on public.students for select using (owner_id = (select auth.uid()));
drop policy if exists insert_students on public.students;
create policy insert_students on public.students for insert with check (owner_id = (select auth.uid()));
drop policy if exists update_students on public.students;
create policy update_students on public.students for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists delete_students on public.students;
create policy delete_students on public.students for delete using (owner_id = (select auth.uid()));
alter publication supabase_realtime add table public.students;

create table if not exists public.notices (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  seq bigint not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  device_id text not null,
  "title" text,
  "content" text,
  "date" text
);
drop trigger if exists trg_notices_updated_at on public.notices;
create trigger trg_notices_updated_at before insert or update on public.notices for each row execute function public.set_updated_at();
alter table public.notices enable row level security;
drop policy if exists select_notices on public.notices;
create policy select_notices on public.notices for select using (owner_id = (select auth.uid()));
drop policy if exists insert_notices on public.notices;
create policy insert_notices on public.notices for insert with check (owner_id = (select auth.uid()));
drop policy if exists update_notices on public.notices;
create policy update_notices on public.notices for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists delete_notices on public.notices;
create policy delete_notices on public.notices for delete using (owner_id = (select auth.uid()));
alter publication supabase_realtime add table public.notices;

create table if not exists public.comments (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  seq bigint not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  device_id text not null,
  "title" text,
  "content" text,
  "date" text
);
drop trigger if exists trg_comments_updated_at on public.comments;
create trigger trg_comments_updated_at before insert or update on public.comments for each row execute function public.set_updated_at();
alter table public.comments enable row level security;
drop policy if exists select_comments on public.comments;
create policy select_comments on public.comments for select using (owner_id = (select auth.uid()));
drop policy if exists insert_comments on public.comments;
create policy insert_comments on public.comments for insert with check (owner_id = (select auth.uid()));
drop policy if exists update_comments on public.comments;
create policy update_comments on public.comments for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists delete_comments on public.comments;
create policy delete_comments on public.comments for delete using (owner_id = (select auth.uid()));
alter publication supabase_realtime add table public.comments;

create table if not exists public.todos (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  seq bigint not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  device_id text not null,
  "title" text,
  "content" text,
  "deadline" text,
  "priority" text,
  "category" text,
  "completed" boolean
);
drop trigger if exists trg_todos_updated_at on public.todos;
create trigger trg_todos_updated_at before insert or update on public.todos for each row execute function public.set_updated_at();
alter table public.todos enable row level security;
drop policy if exists select_todos on public.todos;
create policy select_todos on public.todos for select using (owner_id = (select auth.uid()));
drop policy if exists insert_todos on public.todos;
create policy insert_todos on public.todos for insert with check (owner_id = (select auth.uid()));
drop policy if exists update_todos on public.todos;
create policy update_todos on public.todos for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists delete_todos on public.todos;
create policy delete_todos on public.todos for delete using (owner_id = (select auth.uid()));
alter publication supabase_realtime add table public.todos;

create table if not exists public.schedule (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  seq bigint not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  device_id text not null,
  "day" double precision,
  "period" double precision,
  "subject" text,
  "class" text,
  "week_type" text
);
drop trigger if exists trg_schedule_updated_at on public.schedule;
create trigger trg_schedule_updated_at before insert or update on public.schedule for each row execute function public.set_updated_at();
alter table public.schedule enable row level security;
drop policy if exists select_schedule on public.schedule;
create policy select_schedule on public.schedule for select using (owner_id = (select auth.uid()));
drop policy if exists insert_schedule on public.schedule;
create policy insert_schedule on public.schedule for insert with check (owner_id = (select auth.uid()));
drop policy if exists update_schedule on public.schedule;
create policy update_schedule on public.schedule for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists delete_schedule on public.schedule;
create policy delete_schedule on public.schedule for delete using (owner_id = (select auth.uid()));
alter publication supabase_realtime add table public.schedule;

create table if not exists public.seating (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  seq bigint not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  device_id text not null,
  "rows" double precision,
  "cols" double precision,
  "seats" jsonb
);
drop trigger if exists trg_seating_updated_at on public.seating;
create trigger trg_seating_updated_at before insert or update on public.seating for each row execute function public.set_updated_at();
alter table public.seating enable row level security;
drop policy if exists select_seating on public.seating;
create policy select_seating on public.seating for select using (owner_id = (select auth.uid()));
drop policy if exists insert_seating on public.seating;
create policy insert_seating on public.seating for insert with check (owner_id = (select auth.uid()));
drop policy if exists update_seating on public.seating;
create policy update_seating on public.seating for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists delete_seating on public.seating;
create policy delete_seating on public.seating for delete using (owner_id = (select auth.uid()));
alter publication supabase_realtime add table public.seating;

create table if not exists public.duty (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  seq bigint not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  device_id text not null,
  "week" text,
  "group" double precision,
  "tasks" jsonb
);
drop trigger if exists trg_duty_updated_at on public.duty;
create trigger trg_duty_updated_at before insert or update on public.duty for each row execute function public.set_updated_at();
alter table public.duty enable row level security;
drop policy if exists select_duty on public.duty;
create policy select_duty on public.duty for select using (owner_id = (select auth.uid()));
drop policy if exists insert_duty on public.duty;
create policy insert_duty on public.duty for insert with check (owner_id = (select auth.uid()));
drop policy if exists update_duty on public.duty;
create policy update_duty on public.duty for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists delete_duty on public.duty;
create policy delete_duty on public.duty for delete using (owner_id = (select auth.uid()));
alter publication supabase_realtime add table public.duty;

create table if not exists public.violations (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  seq bigint not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  device_id text not null,
  "student_id" uuid,
  "date" text,
  "event" text,
  "action" text
);
drop trigger if exists trg_violations_updated_at on public.violations;
create trigger trg_violations_updated_at before insert or update on public.violations for each row execute function public.set_updated_at();
alter table public.violations enable row level security;
drop policy if exists select_violations on public.violations;
create policy select_violations on public.violations for select using (owner_id = (select auth.uid()));
drop policy if exists insert_violations on public.violations;
create policy insert_violations on public.violations for insert with check (owner_id = (select auth.uid()));
drop policy if exists update_violations on public.violations;
create policy update_violations on public.violations for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists delete_violations on public.violations;
create policy delete_violations on public.violations for delete using (owner_id = (select auth.uid()));
alter publication supabase_realtime add table public.violations;

create table if not exists public.communications (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  seq bigint not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  device_id text not null,
  "student_id" uuid,
  "date" text,
  "method" text,
  "content" text,
  "follow_up" text
);
drop trigger if exists trg_communications_updated_at on public.communications;
create trigger trg_communications_updated_at before insert or update on public.communications for each row execute function public.set_updated_at();
alter table public.communications enable row level security;
drop policy if exists select_communications on public.communications;
create policy select_communications on public.communications for select using (owner_id = (select auth.uid()));
drop policy if exists insert_communications on public.communications;
create policy insert_communications on public.communications for insert with check (owner_id = (select auth.uid()));
drop policy if exists update_communications on public.communications;
create policy update_communications on public.communications for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists delete_communications on public.communications;
create policy delete_communications on public.communications for delete using (owner_id = (select auth.uid()));
alter publication supabase_realtime add table public.communications;

create table if not exists public.grades (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  seq bigint not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  device_id text not null,
  "exam_name" text,
  "subject" text,
  "date" text,
  "scores" jsonb
);
drop trigger if exists trg_grades_updated_at on public.grades;
create trigger trg_grades_updated_at before insert or update on public.grades for each row execute function public.set_updated_at();
alter table public.grades enable row level security;
drop policy if exists select_grades on public.grades;
create policy select_grades on public.grades for select using (owner_id = (select auth.uid()));
drop policy if exists insert_grades on public.grades;
create policy insert_grades on public.grades for insert with check (owner_id = (select auth.uid()));
drop policy if exists update_grades on public.grades;
create policy update_grades on public.grades for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists delete_grades on public.grades;
create policy delete_grades on public.grades for delete using (owner_id = (select auth.uid()));
alter publication supabase_realtime add table public.grades;

create table if not exists public.exams (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  seq bigint not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  device_id text not null,
  "name" text,
  "date" text,
  "subjects" jsonb,
  "students" jsonb,
  "stats" jsonb
);
drop trigger if exists trg_exams_updated_at on public.exams;
create trigger trg_exams_updated_at before insert or update on public.exams for each row execute function public.set_updated_at();
alter table public.exams enable row level security;
drop policy if exists select_exams on public.exams;
create policy select_exams on public.exams for select using (owner_id = (select auth.uid()));
drop policy if exists insert_exams on public.exams;
create policy insert_exams on public.exams for insert with check (owner_id = (select auth.uid()));
drop policy if exists update_exams on public.exams;
create policy update_exams on public.exams for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists delete_exams on public.exams;
create policy delete_exams on public.exams for delete using (owner_id = (select auth.uid()));
alter publication supabase_realtime add table public.exams;

create table if not exists public.homework (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  seq bigint not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  device_id text not null,
  "date" text,
  "subject" text,
  "title" text,
  "records" jsonb
);
drop trigger if exists trg_homework_updated_at on public.homework;
create trigger trg_homework_updated_at before insert or update on public.homework for each row execute function public.set_updated_at();
alter table public.homework enable row level security;
drop policy if exists select_homework on public.homework;
create policy select_homework on public.homework for select using (owner_id = (select auth.uid()));
drop policy if exists insert_homework on public.homework;
create policy insert_homework on public.homework for insert with check (owner_id = (select auth.uid()));
drop policy if exists update_homework on public.homework;
create policy update_homework on public.homework for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists delete_homework on public.homework;
create policy delete_homework on public.homework for delete using (owner_id = (select auth.uid()));
alter publication supabase_realtime add table public.homework;

create table if not exists public.points (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  seq bigint not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  device_id text not null,
  "student_id" uuid,
  "points" double precision,
  "type" text,
  "reason" text,
  "date" text
);
drop trigger if exists trg_points_updated_at on public.points;
create trigger trg_points_updated_at before insert or update on public.points for each row execute function public.set_updated_at();
alter table public.points enable row level security;
drop policy if exists select_points on public.points;
create policy select_points on public.points for select using (owner_id = (select auth.uid()));
drop policy if exists insert_points on public.points;
create policy insert_points on public.points for insert with check (owner_id = (select auth.uid()));
drop policy if exists update_points on public.points;
create policy update_points on public.points for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists delete_points on public.points;
create policy delete_points on public.points for delete using (owner_id = (select auth.uid()));
alter publication supabase_realtime add table public.points;

create table if not exists public.activities (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  seq bigint not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  device_id text not null,
  "title" text,
  "date" text,
  "content" text,
  "image_paths" jsonb
);
drop trigger if exists trg_activities_updated_at on public.activities;
create trigger trg_activities_updated_at before insert or update on public.activities for each row execute function public.set_updated_at();
alter table public.activities enable row level security;
drop policy if exists select_activities on public.activities;
create policy select_activities on public.activities for select using (owner_id = (select auth.uid()));
drop policy if exists insert_activities on public.activities;
create policy insert_activities on public.activities for insert with check (owner_id = (select auth.uid()));
drop policy if exists update_activities on public.activities;
create policy update_activities on public.activities for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists delete_activities on public.activities;
create policy delete_activities on public.activities for delete using (owner_id = (select auth.uid()));
alter publication supabase_realtime add table public.activities;

create table if not exists public.behaviors (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  seq bigint not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  device_id text not null,
  "student_id" uuid,
  "date" text,
  "type" text,
  "level" double precision,
  "title" text,
  "description" text,
  "image_paths" jsonb
);
drop trigger if exists trg_behaviors_updated_at on public.behaviors;
create trigger trg_behaviors_updated_at before insert or update on public.behaviors for each row execute function public.set_updated_at();
alter table public.behaviors enable row level security;
drop policy if exists select_behaviors on public.behaviors;
create policy select_behaviors on public.behaviors for select using (owner_id = (select auth.uid()));
drop policy if exists insert_behaviors on public.behaviors;
create policy insert_behaviors on public.behaviors for insert with check (owner_id = (select auth.uid()));
drop policy if exists update_behaviors on public.behaviors;
create policy update_behaviors on public.behaviors for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists delete_behaviors on public.behaviors;
create policy delete_behaviors on public.behaviors for delete using (owner_id = (select auth.uid()));
alter publication supabase_realtime add table public.behaviors;

create table if not exists public.committee (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  seq bigint not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  device_id text not null,
  "student_id" uuid,
  "position" text
);
drop trigger if exists trg_committee_updated_at on public.committee;
create trigger trg_committee_updated_at before insert or update on public.committee for each row execute function public.set_updated_at();
alter table public.committee enable row level security;
drop policy if exists select_committee on public.committee;
create policy select_committee on public.committee for select using (owner_id = (select auth.uid()));
drop policy if exists insert_committee on public.committee;
create policy insert_committee on public.committee for insert with check (owner_id = (select auth.uid()));
drop policy if exists update_committee on public.committee;
create policy update_committee on public.committee for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists delete_committee on public.committee;
create policy delete_committee on public.committee for delete using (owner_id = (select auth.uid()));
alter publication supabase_realtime add table public.committee;

create table if not exists public.settings (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  seq bigint not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  device_id text not null,
  "subjects" jsonb,
  "my_subjects" jsonb,
  "tags" jsonb,
  "duty_positions" jsonb,
  "week_type" text
);
drop trigger if exists trg_settings_updated_at on public.settings;
create trigger trg_settings_updated_at before insert or update on public.settings for each row execute function public.set_updated_at();
alter table public.settings enable row level security;
drop policy if exists select_settings on public.settings;
create policy select_settings on public.settings for select using (owner_id = (select auth.uid()));
drop policy if exists insert_settings on public.settings;
create policy insert_settings on public.settings for insert with check (owner_id = (select auth.uid()));
drop policy if exists update_settings on public.settings;
create policy update_settings on public.settings for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists delete_settings on public.settings;
create policy delete_settings on public.settings for delete using (owner_id = (select auth.uid()));
alter publication supabase_realtime add table public.settings;
