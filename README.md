# wacrm — CRM Template for WhatsApp

> Self-hostable CRM template for WhatsApp® — shared inbox, contacts,
> sales pipelines, broadcasts, and no-code automations. Fork it, brand
> it, host it.

<p align="center">
  <a href="https://www.hostinger.com/web-apps-hosting?REFERRALCODE=WACRMHOST">
    <img src="./.github/assets/hostinger-deploy.png" alt="Ship your Node.js app in one click — Deploy to Hostinger" width="900">
  </a>
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-violet.svg)](./LICENSE)
[![CI](https://github.com/ArnasDon/wacrm/actions/workflows/ci.yml/badge.svg)](https://github.com/ArnasDon/wacrm/actions/workflows/ci.yml)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs)](https://nextjs.org)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%2B%20Auth-3ecf8e?logo=supabase)](https://supabase.com)
[![Stars](https://img.shields.io/github/stars/ArnasDon/wacrm?style=social)](https://github.com/ArnasDon/wacrm/stargazers)

The marketing site and self-host docs live in a separate repo:
[ArnasDon/wacrm-site](https://github.com/ArnasDon/wacrm-site)
([wacrm.tech](https://wacrm.tech)). This repo is the product —
clone or fork it to run your own CRM.

## What you get out of the box

- **Shared inbox** on the official WhatsApp Business API — multiple
  agents working one number, per-conversation assignment, status, and
  notes.
- **Contacts + tags + custom fields**, CSV import, deduplication.
- **Sales pipelines** (Kanban) with deals linked to conversations.
- **Broadcasts** with Meta-approved templates, delivery + read
  tracking, per-recipient variable substitution.
- **No-code automations** — triggers on inbound messages, new
  contacts, keywords, or schedule; conditional branches, waits,
  tags, webhooks. Visual builder.
- **AI reply assistant** — bring your own OpenAI or Anthropic key
  (stored encrypted; no per-seat AI fee, your data stays yours).
  One-click AI-drafted replies in the inbox, plus an optional
  auto-reply bot with a per-conversation cap and clean human handoff.
  Add a **knowledge base** (FAQs, policies, product docs) and it
  answers from your own content — hybrid retrieval (Postgres full-text,
  or semantic pgvector when an embeddings key is set).
- **Real-time dashboard** — response times, daily volume, pipeline
  value, cross-module activity feed.
- **Team accounts** — invite teammates by link, role-based access
  (owner / admin / agent / viewer), ownership transfer. Every install
  is account-scoped, so one shared inbox can be staffed by a whole
  team. Solo use stays single-user with zero setup.
- **Account management** — email, password, avatar, global sign-out.
- **Public REST API** (`/api/v1`) with scoped, revocable API keys —
  build your own automations on top of your CRM. See
  [docs/public-api.md](./docs/public-api.md).
- **MCP server** — drive your CRM from Claude, Cursor, and other AI
  assistants over the [Model Context Protocol](https://modelcontextprotocol.io).
  Read-only by default, opt-in writes. See [docs/mcp.md](./docs/mcp.md)
  (server in [`mcp-server/`](./mcp-server)).

## Why fork this?

This is a **template**, not a product. Forking means you get:

- **Full ownership** — your code, your Supabase project, your domain,
  your data. No SaaS lock-in, no seat pricing, no trust dance.
- **Full customisation** — add the fields your team needs, remove the
  modules you don't, redesign anything. The stack is boring on
  purpose (Next.js + Supabase + Tailwind) so the learning curve is
  short.
- **Zero ops to start** — [Hostinger](https://www.hostinger.com/web-apps-hosting?REFERRALCODE=WACRMHOST)
  Managed Node.js deploys a fork in a few clicks. No Docker, no
  Kubernetes, no infra team needed.
  ([See below ↓](#-deploy-on-hostinger-recommended))
- **Real security primitives** — token encryption (AES-256-GCM), RLS
  on every table, HMAC-verified webhooks, CSP, rate limiting, CI
  typecheck/build on every PR.

Not a framework. Not an SDK. A concrete, working CRM you can stand up
in an afternoon and make yours.

## Quick start

```bash
# Fork on GitHub first: https://github.com/ArnasDon/wacrm → Fork
git clone https://github.com/<your-username>/wacrm.git
cd wacrm
npm install
cp .env.local.example .env.local   # fill in Supabase + Meta creds
npm run dev
```

Open <http://localhost:3000>. You'll be redirected to `/login` (or
`/dashboard` if already signed in).

Prefer containers? See [docs/docker.md](./docs/docker.md) for the
Dockerfile + Docker Compose setup.

## 🚀 Deploy on Hostinger (recommended)

<p align="center">
  <a href="https://www.hostinger.com/web-apps-hosting?REFERRALCODE=WACRMHOST">
    <img src="./.github/assets/hostinger-deploy.png" alt="Ship your Node.js app in one click — Deploy to Hostinger" width="1000">
  </a>
</p>
<p align="center">
  <a href="https://wacrm.tech/docs/deployment-hostinger">
    <img src="https://img.shields.io/badge/Step--by--step_guide-wacrm.tech%2Fdocs-111?style=for-the-badge" alt="Step-by-step guide" height="44">
  </a>
</p>

**wacrm is built to run on [Hostinger](https://www.hostinger.com/web-apps-hosting?REFERRALCODE=WACRMHOST).**
It's the path we test, document, and recommend — and the fastest way
to get a production-grade CRM live without owning a VPS or a
Kubernetes cluster.

### Why Hostinger?

| | |
|---|---|
| **One-click Git deploy** | Connect your fork, push to `main`, Hostinger builds and ships it. No SSH, no Docker, no CI to wire up — this repo's own `main` deploys this way. |
| **Managed Node.js** | Next.js 16 (App Router, server actions, ISR) runs out of the box on [Premium, Business, and Cloud](https://www.hostinger.com/web-apps-hosting?REFERRALCODE=WACRMHOST) shared plans. You don't manage Node versions, processes, or reverse proxies. |
| **Free SSL + free domain** | Automatic Let's Encrypt on your custom domain (or a free one included with annual plans). HTTPS is on by default — required for the WhatsApp Business webhook. |
| **Global CDN + LiteSpeed** | Static assets cached at the edge, dynamic routes served from LiteSpeed. Snappy dashboards out of the box, no Cloudflare setup required. |
| **Env vars + logs in hPanel** | Set `SUPABASE_*`, `WHATSAPP_*`, and `ENCRYPTION_KEY` from the panel — no `.env` on the server. Live application logs in the same UI. |
| **DDoS protection + daily backups** | Built-in, no add-ons. The webhook endpoint is a public target — having protection at the edge matters. |
| **Cheaper than a VPS** | Plans start at a few dollars a month — order-of-magnitude less than a comparable managed Node.js host, and you don't pay extra for the database (that's Supabase). |
| **24/7 human support** | Live chat support in 20+ languages — useful when your CRM is the thing your team relies on to talk to customers. |

### The 60-second version

1. **Fork** this repo on GitHub.
2. In **hPanel → Websites → Create**, pick **Node.js** and connect
   your fork.
3. Paste your Supabase + Meta env vars into hPanel.
4. Push to `main`. Hostinger builds and serves it. Done.

Full walkthrough with screenshots:
**[wacrm.tech/docs/deployment-hostinger](https://wacrm.tech/docs/deployment-hostinger)**.

> _Note: wacrm is MIT-licensed and runs anywhere Node.js does
> (Vercel, Railway, your own VPS). Hostinger is recommended, not
> required._

## Language (pt-BR)

The UI ships in English (`en`), Brazilian Portuguese (`pt` / `pt-BR`) and
Korean (`ko`). Pick it with `NEXT_PUBLIC_APP_LOCALE` in `.env.local`
(`.env.local.example` defaults to `pt`). Dates, relative times and the
default currency (BRL) follow the locale.

> `NEXT_PUBLIC_*` variables are inlined at **build time**. After changing the
> locale you must rebuild (`npm run build`) — restarting the server is not enough.

## Canal Evolution (QR code)

Besides the official Meta Cloud API, an account can use **WhatsApp by QR code**
through your own [Evolution API](https://github.com/EvolutionAPI/evolution-api)
server (v2.x). Pick the channel in **Settings → WhatsApp**; one channel is
active per account.

**Variáveis de ambiente**

| Variável | Para quê |
|---|---|
| `ENCRYPTION_KEY` | Criptografa a API key do Evolution (AES-256-GCM), como o token da Meta |
| `SUPABASE_SERVICE_ROLE_KEY` | O webhook e a fila antibanimento gravam com ela |
| `NEXT_PUBLIC_SITE_URL` | URL **pública** do wacrm (https). É o endereço que o Evolution chama. `localhost` não funciona |
| `NEXT_PUBLIC_APP_LOCALE` | `pt` para a interface em português do Brasil (refaça o build) |

A API key do Evolution **não** vai em variável de ambiente: é digitada na tela de
configurações e fica criptografada no banco.

**Como configurar o webhook** — não é preciso fazer nada à mão. Ao salvar em
Configurações → WhatsApp, o wacrm gera um segredo, registra o webhook da instância no
Evolution apontando para `/api/evolution/webhook/<segredo>` (eventos
`MESSAGES_UPSERT`, `MESSAGES_UPDATE`, `CONNECTION_UPDATE`, `QRCODE_UPDATED`) e guarda só o
hash do segredo. Salvar de novo rotaciona o segredo. Roteiro completo de teste:
[docs/evolution-teste-manual.md](./docs/evolution-teste-manual.md); decisões e mapeamento de
eventos: [docs/evolution-plano.md](./docs/evolution-plano.md).

**Migrations** — aplique `040_evolution_provider.sql` e `041_evolution_channel.sql`
antes de usar o canal (o repositório não roda migration por você).

**Limitações conhecidas**

- É uma conexão **não oficial** (Baileys): o WhatsApp pode banir números que enviem rápido
  ou em massa. O wacrm limita o ritmo (intervalo mínimo + atraso aleatório, configurável) e o
  tamanho de cada disparo (padrão 50), mas o risco existe.
- **Sem templates** nem janela de 24 h: modelos, sincronização, verificação de número e
  saúde do número só existem na API oficial. Passos de automação/fluxo que enviam
  *template* falham com uma mensagem clara no canal QR.
- **Botões e listas** são enviados como texto numerado ("Responda 1, 2 ou 3"); a resposta
  numérica do cliente é convertida de volta no toque da opção.
- Disparos no canal QR são **mensagem livre** (texto + mídia opcional), enviados da aba do
  navegador (como o fluxo por template) e **não retomam** sozinhos se a aba fechar no meio.
- O QR code **nunca é gravado**; a tela busca um novo a cada ~20 s direto no Evolution.
- Mensagens de **grupos**, **status** e **canais (newsletter)** são ignoradas.
- Um contato que chega só com `@lid` (sem número real no payload) é descartado, com log.
- O webhook usa o formato de payload do Evolution v2.x; o registro do webhook tenta o
  formato aninhado (2.2+) e cai para o plano (2.0/2.1).

## Documentation

Full self-host documentation — Supabase migrations, WhatsApp Business
API config, and production deploy — lives at
**[wacrm.tech/docs](https://wacrm.tech/docs)**
(source: [ArnasDon/wacrm-site](https://github.com/ArnasDon/wacrm-site)).

Key pages:
- [Getting started](https://wacrm.tech/docs/getting-started)
- [Supabase setup](https://wacrm.tech/docs/supabase-setup)
- [WhatsApp setup](https://wacrm.tech/docs/whatsapp-setup)
- [Environment variables](https://wacrm.tech/docs/environment-variables)
- [Deploy on Hostinger](https://wacrm.tech/docs/deployment-hostinger)
- [Architecture](https://wacrm.tech/docs/architecture)
- [Troubleshooting](https://wacrm.tech/docs/troubleshooting)

## Stack

- **App** — Next.js 16 (App Router), React 19, TypeScript, Tailwind v4.
- **Data** — Supabase (Postgres + Auth + Storage + RLS).
- **WhatsApp** — Meta Cloud API (official WhatsApp Business API).

## Contributing

This is a template, not a collaborative product — the expected flow is
fork → customise → deploy, **not** upstream contribution. Bug reports
and security issues are welcome; feature PRs often belong in your fork
rather than here. Details in
[`CONTRIBUTING.md`](./CONTRIBUTING.md) and
[`.github/SECURITY.md`](./.github/SECURITY.md).

## License

[MIT](./LICENSE). Fork it, brand it, host it.
