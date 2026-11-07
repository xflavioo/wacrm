-- ============================================================
-- 041_evolution_channel
--
-- Completa o canal WhatsApp por QR code (Evolution API) sobre a base da
-- migração 040. Continua valendo D1/D2/D3 daquela migração: UMA linha de
-- `whatsapp_config` por conta, a API key da Evolution cifrada em
-- `access_token`, e `provider` como discriminador. Aqui só entram as
-- colunas que a 040 não previu.
--
--   1. `evolution_webhook_secret_hash` — SHA-256 do segredo que vai na
--      URL do webhook registrado no Evolution
--      (`/api/evolution/webhook/<segredo>`). O segredo em claro NUNCA é
--      guardado: o webhook calcula o hash do que chegou na URL, acha a
--      linha pelo índice único e confere em tempo constante. Quem lê a
--      tabela (inclusive um membro da conta pela RLS) não consegue forjar
--      eventos a partir do hash. Rotaciona a cada "salvar".
--
--   2. `evolution_phone` — número conectado (só dígitos), preenchido
--      quando a conexão abre. Não é `phone_number_id`: esse campo é da
--      Meta e o CHECK da 040 o exige NULL numa linha Evolution.
--
--   3. Ritmo antibanimento: `evolution_min_interval_ms` +
--      `evolution_jitter_ms` (intervalo mínimo entre envios para números
--      DIFERENTES, mais um atraso aleatório) e a fila propriamente dita,
--      `evolution_next_send_at` / `evolution_last_to`, reservada
--      atomicamente por `claim_evolution_send_slot`. A reserva é no
--      banco porque o app roda em serverless: um limitador em memória
--      não enxerga as outras instâncias.
--
--   4. `evolution_broadcast_max` — teto de destinatários por disparo.
--
--   5. `notifications.type` aceita 'whatsapp_disconnected' (aviso aos
--      owner/admin quando o QR cai).
--
-- O QR Code continua SEM coluna (D9): é credencial de pareamento.
-- ============================================================

-- 1-4. Colunas novas.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS evolution_webhook_secret_hash TEXT,
  ADD COLUMN IF NOT EXISTS evolution_phone               TEXT,
  ADD COLUMN IF NOT EXISTS evolution_next_send_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS evolution_last_to             TEXT,
  ADD COLUMN IF NOT EXISTS evolution_min_interval_ms     INTEGER NOT NULL DEFAULT 6000,
  ADD COLUMN IF NOT EXISTS evolution_jitter_ms           INTEGER NOT NULL DEFAULT 4000,
  ADD COLUMN IF NOT EXISTS evolution_broadcast_max       INTEGER NOT NULL DEFAULT 50;

-- Faixas sãs para as três configuráveis. Sem teto, "0" desligaria a
-- proteção por engano e "10000000" travaria um envio por horas.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_evolution_pacing_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_evolution_pacing_check
      CHECK (
        evolution_min_interval_ms BETWEEN 1000 AND 120000
        AND evolution_jitter_ms BETWEEN 0 AND 60000
        AND evolution_broadcast_max BETWEEN 1 AND 1000
      );
  END IF;
END $$;

-- O segredo identifica a conta: precisa ser único.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_evolution_secret_hash_idx
  ON whatsapp_config (evolution_webhook_secret_hash)
  WHERE evolution_webhook_secret_hash IS NOT NULL;

-- 1-3 (cont.). O CHECK da 040 cobria só as colunas que ela conhecia.
-- Recria incluindo as novas: uma linha Meta não pode carregar estado
-- Evolution (a troca de provedor tem que limpar na MESMA escrita).
-- As três colunas de configuração com DEFAULT ficam de fora de propósito:
-- são NOT NULL e valem para qualquer linha.
ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_provider_fields_check;

ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_provider_fields_check
  CHECK (
    (provider = 'meta'      AND phone_number_id IS NOT NULL
                            AND evolution_url IS NULL
                            AND evolution_instance IS NULL
                            AND evolution_webhook_secret_hash IS NULL
                            AND evolution_phone IS NULL
                            AND evolution_next_send_at IS NULL
                            AND evolution_last_to IS NULL)
    OR
    (provider = 'evolution' AND evolution_url IS NOT NULL
                            AND evolution_instance IS NOT NULL
                            AND phone_number_id IS NULL
                            AND waba_id IS NULL
                            AND verify_token IS NULL
                            AND registered_at IS NULL
                            AND subscribed_apps_at IS NULL
                            AND last_registration_error IS NULL)
  );

COMMENT ON COLUMN whatsapp_config.evolution_webhook_secret_hash IS
  'SHA-256 (hex) do segredo na URL do webhook da Evolution. O segredo em claro não é guardado. Só provider=''evolution''.';
COMMENT ON COLUMN whatsapp_config.evolution_phone IS
  'Número conectado via QR (só dígitos). Só provider=''evolution''.';
COMMENT ON COLUMN whatsapp_config.evolution_next_send_at IS
  'Quando o próximo envio para um número DIFERENTE pode sair (fila antibanimento). Ver claim_evolution_send_slot.';

-- 3 (cont.). Reserva atômica do próximo slot de envio.
--
-- Regras:
--   * Mesmo destinatário do último envio → sem espera (é uma conversa,
--     um humano responde em sequência) e a janela do próximo número
--     diferente não anda.
--   * Destinatário diferente → o slot é o maior entre "agora" e
--     `evolution_next_send_at`; o próximo slot fica a
--     `min_interval + random(0..jitter)` ms depois.
--
-- FOR UPDATE serializa chamadas concorrentes da mesma conta, então duas
-- instâncias serverless nunca recebem o mesmo slot.
CREATE OR REPLACE FUNCTION claim_evolution_send_slot(
  p_account_id UUID,
  p_to         TEXT
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cfg  whatsapp_config%ROWTYPE;
  v_slot TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_cfg
    FROM whatsapp_config
   WHERE account_id = p_account_id
     AND provider = 'evolution'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN now();
  END IF;

  IF v_cfg.evolution_last_to IS NOT NULL AND v_cfg.evolution_last_to = p_to THEN
    RETURN now();
  END IF;

  v_slot := GREATEST(now(), COALESCE(v_cfg.evolution_next_send_at, now()));

  UPDATE whatsapp_config
     SET evolution_last_to = p_to,
         evolution_next_send_at = v_slot
           + (v_cfg.evolution_min_interval_ms
              + floor(random() * (v_cfg.evolution_jitter_ms + 1))::INTEGER)
             * INTERVAL '1 millisecond'
   WHERE id = v_cfg.id;

  RETURN v_slot;
END;
$$;

-- Só o service role (o servidor do wacrm) pode reservar slots.
REVOKE ALL ON FUNCTION claim_evolution_send_slot(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_evolution_send_slot(UUID, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_evolution_send_slot(UUID, TEXT) TO service_role;

-- 5. Tipo de notificação novo. O nome é o autogerado da migração 027.
ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'whatsapp_disconnected'));
