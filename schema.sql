-- aveysocial: run once in Supabase Dashboard > SQL Editor (safe to re-run)

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  created_at timestamptz not null default now()
);

create table if not exists public.messages (
  id bigint generated always as identity primary key,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  body text not null default '',
  image_url text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

-- upgrade older version of the table
alter table public.messages add column if not exists image_url text;
alter table public.messages add column if not exists read_at timestamptz;
alter table public.messages drop constraint if exists messages_body_check;
alter table public.messages drop constraint if exists messages_content_check;
alter table public.messages add constraint messages_content_check
  check (char_length(body) <= 2000 and (char_length(body) > 0 or image_url is not null));

create index if not exists messages_pair_idx on public.messages (sender_id, recipient_id, created_at);
create index if not exists messages_recipient_idx on public.messages (recipient_id, created_at);

-- profile is created automatically at signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username)
  values (new.id, lower(new.raw_user_meta_data->>'username'));
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- mark everything a person sent you as read
create or replace function public.mark_read(peer_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.messages set read_at = now()
  where recipient_id = auth.uid() and sender_id = peer_id and read_at is null;
$$;
grant execute on function public.mark_read(uuid) to authenticated;

-- row level security
alter table public.profiles enable row level security;
alter table public.messages enable row level security;

drop policy if exists "profiles readable by signed-in users" on public.profiles;
create policy "profiles readable by signed-in users"
  on public.profiles for select to authenticated using (true);

drop policy if exists "read own messages" on public.messages;
create policy "read own messages"
  on public.messages for select to authenticated
  using (auth.uid() = sender_id or auth.uid() = recipient_id);

drop policy if exists "send as yourself" on public.messages;
create policy "send as yourself"
  on public.messages for insert to authenticated
  with check (auth.uid() = sender_id);

-- image uploads (public bucket, files live in a folder named after the sender)
insert into storage.buckets (id, name, public)
values ('chat-images', 'chat-images', true)
on conflict (id) do nothing;

drop policy if exists "upload to own folder" on storage.objects;
create policy "upload to own folder"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'chat-images' and (storage.foldername(name))[1] = auth.uid()::text);


-- ===== stories, notes and likes =====
create table if not exists public.stories (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  text text not null default '' check (char_length(text) <= 200),
  bg text,
  image_url text,
  created_at timestamptz not null default now(),
  check (char_length(text) > 0 or image_url is not null)
);
create table if not exists public.story_likes (
  story_id bigint not null references public.stories(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  primary key (story_id, user_id)
);
create table if not exists public.notes (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 60),
  updated_at timestamptz not null default now()
);
create table if not exists public.message_likes (
  message_id bigint not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  primary key (message_id, user_id)
);

alter table public.stories enable row level security;
alter table public.story_likes enable row level security;
alter table public.notes enable row level security;
alter table public.message_likes enable row level security;

drop policy if exists "stories visible for 24h" on public.stories;
create policy "stories visible for 24h" on public.stories for select to authenticated
  using (created_at > now() - interval '24 hours');
drop policy if exists "post own stories" on public.stories;
create policy "post own stories" on public.stories for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "delete own stories" on public.stories;
create policy "delete own stories" on public.stories for delete to authenticated using (auth.uid() = user_id);

drop policy if exists "story likes visible" on public.story_likes;
create policy "story likes visible" on public.story_likes for select to authenticated using (true);
drop policy if exists "like as yourself" on public.story_likes;
create policy "like as yourself" on public.story_likes for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "unlike as yourself" on public.story_likes;
create policy "unlike as yourself" on public.story_likes for delete to authenticated using (auth.uid() = user_id);

drop policy if exists "notes visible" on public.notes;
create policy "notes visible" on public.notes for select to authenticated using (true);
drop policy if exists "write own note" on public.notes;
create policy "write own note" on public.notes for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "edit own note" on public.notes;
create policy "edit own note" on public.notes for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "delete own note" on public.notes;
create policy "delete own note" on public.notes for delete to authenticated using (auth.uid() = user_id);

drop policy if exists "see likes on your chats" on public.message_likes;
create policy "see likes on your chats" on public.message_likes for select to authenticated
  using (exists (select 1 from public.messages m where m.id = message_id));
drop policy if exists "like messages in your chats" on public.message_likes;
create policy "like messages in your chats" on public.message_likes for insert to authenticated
  with check (auth.uid() = user_id and exists (select 1 from public.messages m where m.id = message_id));
drop policy if exists "unlike messages" on public.message_likes;
create policy "unlike messages" on public.message_likes for delete to authenticated using (auth.uid() = user_id);


-- ===== profile pictures, bios and follows =====
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists bio text check (bio is null or char_length(bio) <= 100);

drop policy if exists "edit own profile" on public.profiles;
create policy "edit own profile" on public.profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

create table if not exists public.follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  following_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  check (follower_id <> following_id)
);
alter table public.follows enable row level security;
drop policy if exists "follows visible" on public.follows;
create policy "follows visible" on public.follows for select to authenticated using (true);
drop policy if exists "follow as yourself" on public.follows;
create policy "follow as yourself" on public.follows for insert to authenticated with check (auth.uid() = follower_id);
drop policy if exists "unfollow as yourself" on public.follows;
create policy "unfollow as yourself" on public.follows for delete to authenticated using (auth.uid() = follower_id);

-- ===== live updates (safe to re-run) =====
do $$
declare t text;
begin
  foreach t in array array['messages','stories','story_likes','notes','message_likes','profiles','follows'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ===== voice messages =====
alter table public.messages add column if not exists audio_url text;
alter table public.messages add column if not exists audio_secs int;
alter table public.messages drop constraint if exists messages_content_check;
alter table public.messages add constraint messages_content_check
  check (char_length(body) <= 2000 and (char_length(body) > 0 or image_url is not null or audio_url is not null));

-- ===== push notifications =====
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists "see own devices" on public.push_subscriptions;
create policy "see own devices" on public.push_subscriptions for select to authenticated using (auth.uid() = user_id);
drop policy if exists "remove own devices" on public.push_subscriptions;
create policy "remove own devices" on public.push_subscriptions for delete to authenticated using (auth.uid() = user_id);

create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void language sql security definer set search_path = public as $$
  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
  values (p_endpoint, auth.uid(), p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth;
$$;
grant execute on function public.save_push_subscription(text, text, text) to authenticated;
