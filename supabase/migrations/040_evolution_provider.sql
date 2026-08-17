-- ============================================================
-- 040_evolution_provider
--
-- Prepara o schema para um segundo provedor de WhatsApp (Evolution
-- API / Baileys) ao lado da Meta Cloud API.
--
-- Decisão de escopo: UM provedor por conta POR VEZ. O
-- `UNIQUE(account_id)` da migração 017 continua valendo — trocar de
-- provedor reescreve a mesma linha, não cria uma segunda. Coexistência
-- (Meta e Evolution ativos juntos na mesma conta) foi deliberadamente
-- adiada; abrir isso depois é trocar a constraint por
-- UNIQUE(account_id, provider), e essa migração não fecha essa porta.
--
-- Cinco mudanças:
--
--   1. `provider` — o discriminador. DEFAULT 'meta' porque toda linha
--      existente É Meta; sem o default, a coluna NOT NULL não poderia
--      ser adicionada a uma tabela populada.
--
--   2. `evolution_url` / `evolution_instance` — os dois campos que a
--      Evolution precisa e a Meta não tem. A CREDENCIAL não ganha
--      coluna nova: vai no `access_token` existente, que já é cifrado
--      com AES-256-GCM por `src/lib/whatsapp/encryption.ts` e já tem o
--      caminho de auto-upgrade de ciphertext CBC legado. A coluna
--      `provider` diz o que está lá dentro.
--
--      Uma `evolution_api_key` dedicada foi considerada e recusada.
--      Ela é mais legível, mas obriga a derrubar o `NOT NULL` de
--      `access_token` (uma linha Evolution o deixaria vazio) e cria
--      uma SEGUNDA coluna cifrada, que o auto-upgrade de ciphertext
--      legado não conhece — ou seja, um caminho de criptografia sem
--      manutenção. Reusar a coluna mantém uma constraint intacta e um
--      único lugar onde segredo é cifrado.
--
--      O preço é que `provider` vira LOAD-BEARING: descriptografar
--      `access_token` sem checar `provider` entrega o segredo do
--      provedor errado — e sete rotas exclusivas da Meta (templates,
--      proxy de mídia, registro, webhook) mandariam a chave da
--      Evolution para graph.facebook.com. A contenção tem duas metades:
--      os caminhos de ENVIO passam a ler só via `resolveProvider()`, e
--      os que sobram ganham `assertMetaConfig()` (Task 13), que falha
--      alto antes de descriptografar.
--
--   3. `phone_number_id` deixa de ser NOT NULL. Uma conexão Evolution
--      não conhece o número antes do QR ser lido, e depois de lido o
--      valor não é um phone_number_id da Meta. O `UNIQUE` da migração
--      013 NÃO precisa mudar: Postgres trata NULLs como distintos por
--      padrão (a constraint não usa NULLS NOT DISTINCT), então N linhas
--      Evolution com NULL convivem sem colidir.
--
--   4. `status` ganha 'connecting'. O Baileys tem um estado
--      intermediário real (socket abrindo, QR pendente) que a Meta não
--      tem, e o CHECK de duas posições da 001 não tem onde guardá-lo.
--
--   5. `whatsapp_config_provider_fields_check` — cada linha carrega os
--      campos do SEU provedor e NENHUM do outro. As metades negativas
--      importam tanto quanto as positivas: trocar de provedor reescreve
--      a mesma linha (decisão D1), então colunas residuais do provedor
--      anterior seriam o estado NORMAL, não acidente — e um
--      `phone_number_id` residual numa linha Evolution continuaria
--      roteável pelo webhook da Meta e continuaria reivindicando o
--      número no UNIQUE da migração 013. O CHECK torna o híbrido
--      irrepresentável; a troca de provedor é obrigada a limpar a
--      identidade do provedor anterior na mesma escrita.
--
-- O QR Code NÃO ganha coluna. Ele é credencial de pareamento de
-- dispositivo e expira em ~20s; será servido por rota autenticada e
-- nunca persistido.
-- ============================================================

-- 1. Discriminador de provedor.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_provider_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_provider_check
      CHECK (provider IN ('meta', 'evolution'));
  END IF;
END $$;

-- 2. Campos específicos da Evolution. Nullable: uma linha Meta não os usa.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS evolution_url      TEXT,
  ADD COLUMN IF NOT EXISTS evolution_instance TEXT;

-- 3. phone_number_id deixa de ser obrigatório.
ALTER TABLE whatsapp_config
  ALTER COLUMN phone_number_id DROP NOT NULL;

-- 4. status ganha 'connecting'. Não há ADD/DROP condicional para CHECK,
--    então derruba e recria — o nome vem do autogerado da migração 001.
ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_status_check;

ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_status_check
  CHECK (status IN ('connected', 'disconnected', 'connecting'));

-- 5. Integridade por provedor: cada linha carrega os campos do SEU
--    provedor. Sem isso, uma linha Evolution com evolution_url NULL
--    passa pelo INSERT e só falha na hora do primeiro envio.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_provider_fields_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_provider_fields_check
      CHECK (
        (provider = 'meta'      AND phone_number_id IS NOT NULL
                                AND evolution_url IS NULL
                                AND evolution_instance IS NULL)
        OR
        (provider = 'evolution' AND evolution_url IS NOT NULL
                                AND evolution_instance IS NOT NULL
                                AND phone_number_id IS NULL)
      );
  END IF;
END $$;

-- Documentação de catálogo — mesmo padrão das migrações 038/039, para
-- o fato mais surpreendente do schema ficar visível num \d+ e não só
-- enterrado neste arquivo.
COMMENT ON COLUMN whatsapp_config.provider IS
  'Transporte de WhatsApp da conta: ''meta'' (Cloud API) ou ''evolution'' (Baileys). Determina o que access_token contém.';
COMMENT ON COLUMN whatsapp_config.evolution_url IS
  'Base URL do servidor Evolution API. Preenchida só quando provider=''evolution''.';
COMMENT ON COLUMN whatsapp_config.evolution_instance IS
  'Nome da instância no servidor Evolution. Preenchido só quando provider=''evolution''.';
