# Teste manual — canal WhatsApp por QR code (Evolution)

Roteiro ponta a ponta para validar o canal no seu ambiente. Leva uns 20 minutos.
Use um **número de teste** (um chip que você aceite perder) antes de ligar o
número real do Niverlândia — o WhatsApp não oficial pode ser banido.

## 0. Pré-requisitos

1. **Migrations aplicadas** no Supabase de teste: todas as de `supabase/migrations/` em
   ordem, de `001` até `061`. As do canal são `060_evolution_provider.sql` e
   `061_evolution_channel.sql`; as `040`–`059` vêm do repositório oficial. Este repositório
   **não** aplica migration por você.
2. **Variáveis** no `.env.local` (veja `.env.local.example`):
   - `ENCRYPTION_KEY` (64 hex) — criptografa a API key do Evolution;
   - `SUPABASE_SERVICE_ROLE_KEY` — o webhook e a fila antibanimento usam;
   - `NEXT_PUBLIC_SITE_URL` — **URL pública do wacrm** (https). O Evolution precisa
     alcançá-la; `localhost` não funciona (use um túnel como ngrok/Cloudflare Tunnel
     em teste local e ponha a URL do túnel aqui).
   - `NEXT_PUBLIC_APP_LOCALE=pt` para a interface em português do Brasil.
3. **Refaça o build** depois de mudar qualquer `NEXT_PUBLIC_*`: `npm run build`
   (reiniciar o servidor não basta). Em desenvolvimento, reinicie o `npm run dev`.
4. **Evolution API v2.x no ar**, com a instância já criada (nome que você vai informar).
   Descubra a versão: `GET https://SEU-EVOLUTION/` retorna `{"version": "2.x.x", ...}`.
5. Dois celulares: o do **chip conectado** e outro **de cliente** para trocar mensagens.
6. Você precisa ser **owner ou admin** da conta no wacrm.

## 1. Conectar por QR code

1. Abra **Configurações → WhatsApp**. Escolha **QR code (Evolution)**.
2. Preencha:
   - **URL do servidor**: `https://SEU-EVOLUTION` (sem barra final);
   - **Nome da instância**: o da sua instância;
   - **API key**: a chave do Evolution (global ou da instância).
3. Clique em **Salvar e registrar o webhook**.
   - Esperado: toast verde "Configuração salva e webhook registrado no servidor Evolution."
   - Se aparecer o aviso de endereço local, ajuste `NEXT_PUBLIC_SITE_URL` (item 0.2).
   - Erros possíveis (todos em português): "A API key foi recusada…", "Instância não
     encontrada…", "Não foi possível conectar ao servidor Evolution…".
4. Clique em **Conectar**. O QR code aparece e se renova sozinho a cada ~20 s.
5. No celular do chip: WhatsApp → **Aparelhos conectados → Conectar um aparelho** → leia o QR.
6. Esperado em poucos segundos: o painel muda para **Conectado** e mostra
   **Número conectado: +55…**; toast "WhatsApp conectado.".

> Conferência no servidor (opcional): `GET {URL}/webhook/find/{instancia}` deve mostrar a
> URL `…/api/evolution/webhook/<segredo>` com os 4 eventos (`MESSAGES_UPSERT`,
> `MESSAGES_UPDATE`, `CONNECTION_UPDATE`, `QRCODE_UPDATED`).

## 2. Receber texto, áudio e foto de um celular

No **celular de cliente**, envie para o número conectado:

| Envie | Esperado na Caixa de entrada |
|---|---|
| Texto "Oi, quero fazer uma festa" | Conversa nova (ou existente) com o texto; contador de não lidas sobe; contato criado com o nome do WhatsApp e telefone no formato `55 + DDD + 9…` |
| **Nota de voz** (segure o microfone) | Balão de áudio tocável |
| **Foto** com legenda | Imagem visível, legenda embaixo |
| Um **PDF** e uma **figurinha** | Documento baixável; figurinha como imagem |
| Uma **localização** | Texto "nome - endereço - lat,lng" |
| Reaja com 👍 a uma mensagem sua | A reação aparece na mensagem |

Verificações:
- Reenviar/duplicar não cria mensagem repetida (a deduplicação é pelo id da mensagem).
- Uma mensagem em **grupo** ou um **status** não deve aparecer no CRM.
- Se o cliente tiver número sem o 9º dígito no WhatsApp, o contato **não** duplica.

## 3. Responder pela Caixa de entrada

1. Abra a conversa e responda com texto. Esperado: chega no celular do cliente com
   "digitando…" por ~1 s antes.
2. Envie uma **imagem**, um **documento** e um **áudio gravado** (botão do microfone):
   o áudio deve chegar como **nota de voz** (ícone de microfone, não anexo).
3. Mande 3 mensagens para **3 clientes diferentes** em sequência rápida: elas saem
   espaçadas (intervalo mínimo + atraso aleatório, padrão 6 s + 0–4 s). Respostas
   seguidas **ao mesmo cliente** não esperam.
4. Os tiques mudam: enviado → entregue → lido (✓ ✓✓ azul) conforme o cliente abre.
5. Confirme que **não existe** o aviso de "janela de 24 h", nem o contador no cabeçalho,
   nem o botão de modelos (templates).

## 4. A IA respondendo e passando para humano

1. **Configurações → Assistente de IA**: informe a chave do provedor, ative a
   **resposta automática** e escreva as instruções (cardápio, horários, regras).
2. Desative automações de "nova mensagem" (a IA se cala quando há uma ativa).
3. No celular do cliente, pergunte algo que a IA saiba responder. Esperado: resposta com o
   selo "IA" na conversa, enviada pelo Evolution.
4. Pergunte algo que ela **não** deve responder (preço fechado, reclamação). Esperado:
   a IA para, a conversa é atribuída ao agente de transferência (se configurado) e fica
   uma nota interna com o resumo; novas mensagens do cliente **não** disparam a IA.
5. **Botões/listas** (fluxos): no QR eles chegam como **texto numerado**
   ("1) Reservar festa / 2) Ver cardápio — Responda com o número…"). Responda "2": o fluxo
   deve seguir como se tivesse tocado no botão 2.

## 5. Mensagem enviada pelo celular aparecendo na conversa

1. Com o celular do chip (o WhatsApp do próprio número conectado), responda um cliente
   **direto no aplicativo**.
2. Esperado em alguns segundos: a mensagem aparece na conversa certa como **enviada
   por um agente**, **sem** disparar IA, automação nem fluxo, e **sem duplicar** quando
   foi o próprio wacrm que enviou (a conferência espera ~2,5 s e compara o id).

## 6. Desconectar e reconectar

1. **Configurações → WhatsApp → Desconectar** (confirme). Esperado: status
   **Desconectado**; no celular o aparelho some de "Aparelhos conectados".
2. Clique em **Reconectar**, leia o QR de novo. Esperado: volta a **Conectado**;
   mensagens recebidas voltam a chegar.
3. **Queda não intencional**: no celular, remova o aparelho em "Aparelhos conectados".
   Esperado: o status vira Desconectado e **owner/admin** recebem uma notificação
   "WhatsApp desconectado" (sino de notificações), que leva às Configurações.

## 7. Disparo (broadcast)

1. **Disparos → Novo disparo**. No canal QR o assistente é de **mensagem livre**: escreva o
   texto (use `{{nome}}` para o nome do contato), opcionalmente um link de mídia.
2. Leia o aviso de **risco de banimento**. Escolha o público (comece com **2–3 contatos de
   teste**) e envie.
3. Esperado: cada mensagem sai espaçada; o disparo mostra enviados/entregues/lidos.
4. Selecione um público maior que o limite (padrão **50**; ajuste em
   Configurações → WhatsApp → "Ritmo de envio e limites"). Esperado: recusa clara
   com a contagem.

## 8. Voltar para a Meta (não deve ter quebrado nada)

1. **Configurações → WhatsApp → API oficial (Meta)**, preencha e salve. A mesma linha é
   reescrita (um canal por conta) e as colunas do Evolution são zeradas.
2. Modelos, janela de 24 h e disparos por template voltam ao normal.

## Se algo falhar

| Sintoma | Causa provável |
|---|---|
| Salvou mas nada chega | O Evolution não alcança `NEXT_PUBLIC_SITE_URL` (webhook no vazio). Teste `curl -X POST https://SEU-WACRM/api/evolution/webhook/qualquer` → deve dar **401**. |
| 401 nos logs do Evolution | Segredo rotacionado: salve de novo a configuração (gera segredo novo e registra no servidor). |
| QR some antes de ler | Normal (~20 s); o painel renova sozinho. Se não renova, confira a API key e a URL. |
| Contato criado com número estranho (muitos dígitos) | LID sem número real no payload: veja `docs/evolution-plano.md` §4 e os logs `no_phone`; atualize o Evolution (v2.2+). |
| "Fila de envio cheia…" | Muitos envios simultâneos para números diferentes; aguarde ou diminua o intervalo (com cuidado). |
| Áudio chega como arquivo | O Evolution < 2.0 não tem `sendWhatsAppAudio`; atualize. |
