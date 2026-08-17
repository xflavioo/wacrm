# Integração com Evolution API (WhatsApp Baileys / QR Code)

Este documento descreve como funciona a integração da **Evolution API** no **wacrm**, permitindo a conexão por QR Code (múltiplos aparelhos / WhatsApp Web) sem perder o histórico do celular.

---

## 📌 Sumário

1. [Visão Geral](#visão-geral)
2. [Vantagens e Diferenciais](#vantagens-e-diferenciais)
3. [Arquitetura de Conexão](#arquitetura-de-conexão)
4. [Como Configurar Passo a Passo](#como-configurar-passo-a-passo)
5. [Eventos de Webhook Suportados](#eventos-de-webhook-suportados)
6. [Segurança e Boas Práticas](#segurança-e-boas-práticas)

---

## 1. Visão Geral

O **wacrm** foi arquitetado com suporte a **Multi-Provedor de WhatsApp**, permitindo alternar de forma simples entre:

- **Meta Cloud API (Oficial)**: Ideal para operações que utilizam números dedicados e templates aprovados.
- **Evolution API (Baileys / QR Code)**: Ideal para manter o WhatsApp funcionando simultaneamente no aparelho celular, sem necessidade de aprovação de templates ou custos por mensagem da Meta.

---

## 2. Vantagens e Diferenciais

- **Seu celular não é desconectado:** O aplicativo do WhatsApp Business no aparelho celular físico continua funcionando normalmente com todas as conversas anteriores.
- **Leitura de QR Code direta na tela:** A interface do CRM gera o QR Code em tempo real nas Configurações.
- **Envio livre de mensagens:** Não há restrição de janela de 24 horas para início de conversa.
- **Áudios gravados na hora (PTT):** Suporte ao envio de notas de voz simulando gravação pelo microfone.
- **Compatibilidade total com o CRM:** Mensagens recebidas e enviadas alimentam o Kanban de vendas, contatos, automações, chatbots (fluxos) e assistente de IA.

---

## 3. Arquitetura de Conexão

```
[ Usuário no Navegador ] ──▶ [ CRM wacrm (Next.js + Supabase) ]
                                    │               ▲
                         (Envio HTTP)               │ (Webhook)
                                    ▼               │
                         [ Servidor Evolution API (ex: evolution.xflavio.com) ]
                                    │
                              (Socket Baileys)
                                    ▼
                         [ Servidores do WhatsApp ] ◀──▶ [ Celular do Usuário ]
```

---

## 4. Como Configurar Passo a Passo

1. **Acesse as Configurações do CRM:**
   - No menu lateral do CRM, clique em **Configurações** ➔ **WhatsApp**.
2. **Selecione o Provedor:**
   - Escolha a opção **Evolution API (Baileys / QR Code)**.
3. **Preencha os dados do Servidor:**
   - **URL do Servidor:** `https://evolution.xflavio.com`
   - **API Key Global:** Cole a chave de API da sua Evolution.
   - **Nome da Instância:** Digite um nome para a sua conexão (ex: `wacrm_principal`).
4. **Gerar e Escanear QR Code:**
   - Clique no botão **Conectar / Gerar QR Code**.
   - Abra o WhatsApp no seu celular ➔ **Aparelhos Conectados** ➔ **Conectar um aparelho**.
   - Aponte a câmera para o QR Code exibido na tela.
5. **Pronto!** O status mudará para **Conectado** e todas as mensagens recebidas e enviadas serão sincronizadas com o CRM.

---

## 5. Eventos de Webhook Suportados

A integração processa automaticamente os seguintes eventos enviados pela Evolution API para o endpoint `/api/evolution/webhook`:

| Evento              | Ação no CRM                                                                                              |
| :------------------ | :------------------------------------------------------------------------------------------------------- |
| `MESSAGES_UPSERT`   | Salva mensagens recebidas e enviadas, cria contatos se não existirem e atualiza conversas em tempo real. |
| `MESSAGES_UPDATE`   | Atualiza status de entrega (`ENVIADO`, `ENTREGUE`, `LIDO`).                                              |
| `CONNECTION_UPDATE` | Atualiza o status da conexão (`open`, `close`, `connecting`) no painel de configurações.                 |
| `QRCODE_UPDATED`    | Atualiza o QR Code dinamicamente caso expire antes da leitura.                                           |

---

## 6. Monitoramento de Queda, Alertas e Reconexão

Para garantir que você ou seus atendentes nunca fiquem no escuro caso a conexão caia, o sistema possui:

1. **Toast de Alerta Imediato (`sonner`):**
   - Notificação instantânea na tela assim que o evento de desconexão é detectado.
2. **Banner Global de Aviso no Topo:**
   - Exibe uma barra destacada no cabeçalho de todas as telas avisando que o WhatsApp está desconectado.
3. **Indicador de Status na Caixa de Entrada:**
   - Badge visual (🟢 Conectado / 🔴 Desconectado) na barra de mensagens.
4. **Reconexão com 1 Clique:**
   - Botão rápido no próprio aviso para abrir o gerador de QR Code e reconectar na hora.
5. **Tentativa de Auto-reconexão:**
   - Caso seja apenas uma oscilação momentânea de internet no celular, a Evolution API tenta reconectar automaticamente antes de declarar desconexão definitiva.

---

## 7. Segurança e Boas Práticas

- **Criptografia de Chaves:** A chave de API da Evolution é armazenada no banco criptografada com algoritmo **AES-256-GCM**.
- **Autenticação nos Webhooks:** Os webhooks recebidos são validados para garantir a autenticidade das mensagens enviadas pela Evolution.
- **Aquecimento de Chip:** Para números novos, evite disparos em massa repentinos para proteger a reputação do número junto ao WhatsApp.
