-- Post-migration assertions for the CI job in
-- `.github/workflows/migrations.yml`.
--
-- `supabase db reset` already fails on any statement Postgres rejects,
-- so this is not about syntax. It's about the quieter failure: a
-- migration that applies cleanly and does nothing. Every DDL statement
-- in this repo is guarded with IF NOT EXISTS / ON CONFLICT so the files
-- can be re-run safely, and that same guard turns a typo'd object name
-- into a silent no-op with a green checkmark.
--
-- Keep this thin. It is a smoke test for "did the migrations actually
-- build the schema", not a spec of it — asserting every column here
-- would just be the migrations restated in a second place, drifting.
DO $$
BEGIN
  -- The core tables, from 001.
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'public.messages is missing — migrations did not apply';
  END IF;
  IF to_regclass('public.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION 'public.whatsapp_config is missing — migrations did not apply';
  END IF;

  -- Supabase provides the storage schema; migrations 016/020/023 write
  -- to it. If it is absent the bucket migrations silently accomplish
  -- nothing, which is precisely the case a plain "no errors" run hides.
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION
      'storage.buckets is missing — the storage schema was not available when the bucket migrations ran';
  END IF;

  -- Buckets are UPSERTed, so their absence means the INSERT never ran.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media') THEN
    RAISE EXCEPTION 'the chat-media bucket row was not created (migration 023)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'flow-media') THEN
    RAISE EXCEPTION 'the flow-media bucket row was not created (migration 016)';
  END IF;

  -- Account scoping (017) is load-bearing for every RLS policy.
  IF to_regclass('public.accounts') IS NULL THEN
    RAISE EXCEPTION 'public.accounts is missing — migration 017 did not apply';
  END IF;

  -- 040: a coluna de provedor precisa existir E aceitar 'evolution'.
  -- Testar só a existência da coluna deixaria passar um CHECK escrito
  -- errado, que é o modo de falha que interessa aqui.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'whatsapp_config'
      AND column_name = 'provider'
  ) THEN
    RAISE EXCEPTION 'whatsapp_config.provider is missing — migration 040 did not apply';
  END IF;

  -- (As duas sondas rodam como postgres, dono da tabela — RLS não se
  --  aplica. Se o CI um dia trocar de papel, elas falhariam com
  --  insufficient_privilege, e a causa seria o harness, não a 040.)
  BEGIN
    INSERT INTO whatsapp_config (user_id, account_id, provider, access_token,
                                 evolution_url, evolution_instance, status)
    VALUES (gen_random_uuid(), gen_random_uuid(), 'evolution', 'x',
            'https://example.invalid', 'ci-probe', 'connecting');
    RAISE EXCEPTION 'CI probe row was accepted but should have been rolled back';
  EXCEPTION
    WHEN foreign_key_violation THEN
      -- Esperado: os UUIDs aleatórios não existem em auth.users/accounts.
      -- Chegar até a violação de FK prova que provider='evolution',
      -- status='connecting' e phone_number_id NULL passaram por todos
      -- os CHECKs — que é exatamente o que a 040 tinha que liberar.
      NULL;
  END;

  -- Sonda negativa: os CHECKs também precisam RECUSAR. Sem ela, um
  -- DO-guard que silenciosamente não criou a constraint continuaria
  -- verde — o exato modo de falha que este arquivo existe para pegar.
  -- check_violation dispara ANTES dos gatilhos de FK.
  BEGIN
    INSERT INTO whatsapp_config (user_id, account_id, provider, access_token, status)
    VALUES (gen_random_uuid(), gen_random_uuid(), 'evolution', 'x', 'connecting');
    RAISE EXCEPTION 'provider_fields_check accepted an evolution row with no evolution_url';
  EXCEPTION
    WHEN check_violation THEN
      NULL; -- esperado
    WHEN foreign_key_violation THEN
      RAISE EXCEPTION 'provider_fields_check is missing — the bad row sailed past the CHECKs into FK validation';
  END;

  RAISE NOTICE 'schema verification passed';
END
$$;

-- Two things this file has already been burned by, both verified in CI
-- rather than assumed:
--
-- 1. It must contain EXACTLY ONE statement. `supabase db query --file`
--    sends the whole file as a prepared statement, and a second
--    top-level statement fails with the distinctly unhelpful "cannot
--    insert multiple commands into a prepared statement" (commit
--    f91a6c8). Add assertions INSIDE the DO block above; do not append
--    a second one.
--
-- 2. A RAISE in here really does fail the job. A deliberately false
--    assertion (commit 42c7db0, run 31579334056) surfaced as
--    `failed to execute query: error: ...` and exited 1. This is not a
--    decorative green tick.
