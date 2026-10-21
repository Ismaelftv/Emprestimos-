# Caixa — Etapa 1: arquitetura, modelo de dados e plano

## 1. O que o protótipo faz hoje (leitura de `demo/`)

- **Uma só "tabela de verdade" no navegador**: `db = {config, users, clients, loans, requests, cashOps, fechamentos, log}` em localStorage. Cada tela lê `db` e re-renderiza HTML por template string; as ações são funções `window.*` que mutam `db` e chamam `save()`.
- **Parcelas são objetos dentro do empréstimo** (`loan.parcelas[]`), com campos de estado misturados: `paid`, `paidAt`, `paidBy`, `paidAmount`, `paidSum`, `pagos[]`, `reported`, `proofRejected`, `waived`, `lembrete`.
- **Valores em reais com ponto flutuante** (`Math.round(x*100)/100`), IDs `Date.now()*1000+random`, datas como string `YYYY-MM-DD` (fuso já corrigido via `iso()`).
- **Atraso é calculado na leitura** (`owed()`): multa única + mora proporcional (`dias/30`) sobre `p.amount`, usando a config *global atual*. Pago parcial entra como `paidSum`.
- **Cliente e usuário são entidades diferentes** (`users` vs `clients` com `email/senha/portal`), logins distintos.
- **Imagens** (comprovante, documentos) viram base64 JPEG 900–1100px dentro do `db`.
- **Pontos que não podem ir para produção** (e como vou tratar):
  | Prototype | Produção |
  |---|---|
  | Senha em texto no `db` e **enviada no link do WhatsApp** ("senha: …") | argon2id; acesso do cliente por **convite de uso único** (link com token que expira), nunca senha em mensagem |
  | Sessão = id em localStorage | cookie httpOnly + sessão no banco |
  | Config global muda o passado (mudar a multa altera parcelas já vencidas e o texto do contrato) | **snapshot** de multa/mora/desconto de quitação no empréstimo, no momento da proposta |
  | Floats | inteiros em centavos |
  | "Desfazer pagamento" apaga campos | estorno como lançamento (o histórico fica; ver §3) |
  | Recibo numerado por `loanId.slice(-5)` | sequência por empresa, sem repetição |
  | Exclusão de cliente/empréstimo apaga | soft-delete + anonimização LGPD; auditoria imutável |
  | Quitação por cliente = `l.quitReq` solto | tabela própria de solicitações de quitação |
  | Caixa "saldo inicial" = último fechamento do funcionário | mantém a regra, mas calculada no servidor e travada após fechar |

## 2. Arquitetura

```
caixa/
├─ apps/
│  ├─ api/            Fastify + TypeScript + Drizzle (PostgreSQL)
│  └─ web/            o demo/ atual (HTML/CSS/JS), migrado aos poucos para chamar a API
├─ packages/
│  └─ core/           funções PURAS compartilhadas: cronograma, multa/mora, parcial, quitação, CPF, datas (TS)
├─ deploy/            docker-compose.yml, Caddyfile, backup.sh
└─ docs/
```

**Decisões e porquê**

- **`packages/core` compartilhado**: o front já faz simulação (novo empréstimo, solicitação). Com o mesmo código no servidor e no navegador, a prévia nunca diverge do valor gravado. O servidor é sempre a fonte de verdade.
- **Monólito Fastify**, plugins por módulo (`auth`, `staff`, `clients`, `loans`, `payments`, `requests`, `cash`, `reports`, `files`, `notifications`, `audit`). Sem microserviços.
- **PostgreSQL + Drizzle** com migrações versionadas. Testes rodam em **PGlite** (Postgres de verdade em memória, mesmo dialeto), então não preciso de SQLite com SQL diferente.
- **Fila e agendador no próprio Postgres (pg-boss)**: e-mail, push, lembretes diários e backup, sem Redis a mais para operar. Novas tentativas persistem.
- **Autenticação**: argon2id; sessão opaca (token aleatório, só o hash fica no banco) em cookie `httpOnly; Secure; SameSite=Lax`; CSRF com token duplo (cabeçalho `X-CSRF`); 2FA TOTP (RFC 6238) com segredo criptografado em repouso; recuperação por código de 6 dígitos, hash + expiração 15 min + uso único; **bloqueio de 5 tentativas / 5 min persistido no banco** por conta e por IP (o protótipo guarda no localStorage, contornável); rate limit adicional no Fastify.
- **Autorização em três camadas**: (1) papel (`admin`/`staff`/`client`) por rota; (2) permissão do funcionário (`criar`, `clientes`, `excluir`, `lucro`, `todos`); (3) **escopo por recurso**. Toda consulta passa por *scopes* centrais (`clientsVisibleTo(actor)`, `loansVisibleTo(actor)`) — nenhum handler monta `WHERE` sozinho. Cliente: o escopo é sempre `client_id = actor.clientId` vindo da sessão, **nunca do corpo ou da URL**. Recurso de outro cliente responde 404 (não 403), para não revelar existência.
- **Arquivos**: interface `StorageProvider` (disco privado agora, S3 privado depois). Nome aleatório (UUID), validação por *magic bytes* (jpeg/png/webp/pdf), limite 5 MB, **AES-256-GCM** por arquivo (chave de dados cifrada por chave mestra do `.env`), entrega apenas por rota autenticada com checagem de escopo e `Cache-Control: private, no-store`. Nada de base64 no banco.
- **Auditoria imutável**: tabela `audit_log` *append-only* (trigger bloqueia `UPDATE/DELETE`), com `prev_hash`/`hash` encadeado para detectar adulteração. Registra ator, ação, entidade, antes/depois resumido, IP e user-agent.
- **E-mail**: interface `Mailer` (SMTP genérico + `console` em dev), templates em pt-BR, fila com retentativas.
- **Push**: Web Push (VAPID) com `push_subscriptions`; o `sw.js` ganha o handler `push`. **WhatsApp**: interface `WhatsAppSender` com duas implementações — `WaLink` (wa.me, o que existe hoje) e `CloudApi` (stub pronto para ligar depois).
- **Pix automático (opcional)**: interface `PixProvider` + webhook com assinatura (HMAC) — desligado por configuração; não será implementado sem você escolher o PSP.
- **Multi-empresa**: toda tabela de negócio tem `org_id` desde já (custa quase nada agora e muito depois). A interface continua de uma empresa só.
- **Front**: manter o JS atual. Cria-se `api.js` (fetch + CSRF + tratamento de 401), e `db` vira um cache de DTOs vindos da API. Os campos calculados (`owed`, `status`, `quitCalc`) passam a vir prontos do servidor; o front deixa de recalcular, salvo a prévia dos formulários via `core`. Layout, CSS e classes ficam intocados.
- **Fuso**: banco guarda `timestamptz` (UTC) e `date` para vencimentos; "hoje" é sempre calculado no servidor em `America/Sao_Paulo`. Teste explícito às 23h.

## 3. Modelo de dados (dinheiro em centavos `bigint`; percentuais em *basis points* `int`, 1% = 100)

**Identidade e acesso**
- `orgs(id, nome, …)`
- `users(id, org_id, kind: staff|client, email unique/org, password_hash, status: active|disabled, totp_secret_enc, totp_enabled, must_change_password, failed_count, locked_until, last_login_at)`
- `staff_profiles(user_id, nome, role: admin|staff, comissao_bps, perm_criar, perm_clientes, perm_excluir, perm_lucro, perm_todos)`
- `sessions(id, user_id, token_hash, ip, user_agent, expires_at, revoked_at)`
- `login_attempts(id, key (email|ip), at, ok)` · `password_resets(user_id, code_hash, expires_at, used_at)` · `invites(user_id, token_hash, expires_at, used_at)`

**Clientes**
- `clients(id, org_id, user_id null, nome, whatsapp, cpf, cpf_hash, cidade, obs, responsavel_staff_id, situacao: verificado|em_verificacao, bloqueado, limite_cents null, portal_enabled, consent_at, consent_version, anonymized_at, deleted_at)`
- `client_documents(id, client_id, tipo: rg_frente|rg_verso|residencia|selfie, file_id, status: enviado|aprovado|recusado, motivo, reviewed_by, reviewed_at)` — uma linha por tipo ativo; reenvio cria nova e arquiva a antiga.
- `files(id, org_id, storage_key, mime, size, sha256, enc_iv, enc_tag, owner_client_id, created_by, created_at, purge_after)`

**Empréstimos**
- `loan_requests(id, client_id, valor_cents, n_parcelas, freq_days, motivo, status: analise|aprovada|recusada, motivo_recusa, decided_by, decided_at, loan_id null)`
- `loans(id, org_id, client_id, request_id null, valor_cents, juros_bps, freq_days (1|7|15|30), n_parcelas, pula_domingo, total_cents, status: proposta|ativo|quitado|cancelado, multa_bps, mora_bps_mes, desc_quit_bps` ← **snapshot**, `contract_version, contract_text_snapshot, accepted_at, accepted_ip, disbursed_at, disbursed_method, created_by, created_at)`
- `installments(id, loan_id, numero, due_date, amount_cents, multa_perdoada bool, perdoada_por, lembrete_enviado_em)` — **só dados do contrato**; sem `paid` gravado. O estado (aberto / parcial / pago / atrasado, saldo, multa e mora do dia) é **derivado** dos lançamentos.
- `payments(id, org_id, installment_id, valor_cents, method: pix|dinheiro, received_by, received_at, receipt_no, kind: parcela|quitacao, reverses_payment_id null, reversal_reason, source_report_id null)` — **livro-razão**: pagamento parcial = várias linhas; "desfazer" = linha de estorno (negativa) apontando para a original, com motivo e ator.
- `payment_reports(id, installment_id|loan_id, method, valor_informado_cents, file_id null, note, status: pendente|confirmado|recusado, motivo_recusa, decided_by, decided_at)` — comprovante Pix / aviso de dinheiro enviado pelo cliente.
- `payoff_requests(id, loan_id, method, file_id null, note, valor_cents, status, decided_by)` — pedido de quitação do cliente.
- `receipt_sequences(org_id, last_no)` — número do recibo `R-000123`, gerado na mesma transação do pagamento.

**Caixa**
- `cash_ops(id, org_id, staff_id, date, tipo: emprestimo|despesa|sangria, valor_cents, descricao, loan_id null)`
- `cash_closings(id, staff_id, date, inicial, entradas_dinheiro, pix_informativo, saidas, esperado, contado, diff, obs, closed_at)` — único por (staff, data); depois de fechado não aceita novos lançamentos naquela data.

**Operação**
- `settings(org_id, empresa, multa_bps, mora_bps_mes, pix_key, pix_nome, aceita_pix, aceita_dinheiro, desc_quit_bps, whatsapp, min_valor, max_valor, max_parcelas, taxas_sugeridas jsonb, exigir_2fa_admin)` — ajustes valem para **novos** contratos.
- `audit_log(id, org_id, at, actor_user_id, actor_kind, action, entity, entity_id, summary, meta jsonb, ip, ua, prev_hash, hash)`
- `outbox_emails`, `push_subscriptions`, `notification_log` (via pg-boss + tabelas próprias)
- `privacy_requests(id, client_id, tipo: exportacao|exclusao, status, done_at)`

**Regras de cálculo (em `packages/core`, todas testadas)**
- `total = round(valor × (1 + juros))`; parcela = `floor(total / n)`; **última absorve os centavos**.
- Datas: diário (opção pular domingos), semanal/quinzenal (+7/+15), **mensal mantém o dia e cai no último dia do mês curto** (31/jan → 28/fev → 31/mar, calculado a partir da data-âncora, não da anterior).
- Atraso: `dias = hoje − vencimento` em dias de calendário (SP). `multa = round(parcela × multa)` uma vez; `mora = round(parcela × mora_mês × dias/30)`. Perdoar zera os dois, sem apagar.
- Saldo da parcela = `parcela + multa + mora − Σ pagamentos` (com estornos). Pagamento acima do saldo é rejeitado.
- Quitação antecipada: para cada parcela futura, abate `desc_quit × (juros do empréstimo ÷ n)`; parcelas vencidas entram integrais (com multa/mora). Valor calculado no servidor no momento da confirmação.

## 4. API (resumo; tudo sob `/api/v1`, validação zod, erro padronizado)

- **Auth**: `POST /auth/login`, `/auth/2fa`, `/auth/logout`, `/auth/forgot`, `/auth/reset`, `/auth/invite/accept`, `POST /auth/signup` (cliente, entra "em verificação"), `GET /me`, `POST /me/password`, `/me/2fa/{setup,enable,disable}`
- **Equipe (admin)**: `GET/POST/PATCH /staff`, `POST /staff/:id/{disable,enable,invite}` (ao desativar, transfere clientes)
- **Clientes**: `GET/POST /clients`, `GET/PATCH/DELETE /clients/:id`, `POST /clients/:id/portal-invite`, `GET/POST /clients/:id/documents`, `PATCH …/documents/:tipo` (aprovar/recusar)
- **Empréstimos**: `POST /loans/preview`, `POST /loans`, `GET /loans`, `GET /loans/:id`, `POST /loans/:id/{cancel,disburse,waive}`, `GET /loans/:id/contract`
- **Pagamentos**: `GET /installments?filtro=`, `POST /installments/:id/payments`, `POST /payments/:id/reverse`, `GET /payments/:id/receipt` (JSON + PDF), `POST /loans/:id/payoff` (equipe) · reports: `POST/PATCH /payment-reports…`
- **Solicitações**: `POST/GET /requests` (cliente: só as dele), `POST /requests/:id/approve|refuse`, `POST /loans/:id/accept|decline`
- **Caixa**: `GET /cash?staff=&date=`, `POST /cash/ops`, `POST /cash/close`
- **Relatórios**: `GET /reports/summary|delinquency|received-by-staff`, `GET /export/installments.csv`, `GET /export/backup` (admin)
- **Outros**: `GET/PATCH /settings`, `GET /audit`, `GET /files/:id` (autenticado), `POST /push/subscribe`, `GET /health`, `POST /privacy/export|erase`

## 5. Plano em etapas (cada uma termina com testes verdes e um resumo curto)

| # | Entrega | Saída verificável |
|---|---|---|
| 1 | Este documento | você valida decisões abaixo |
| 2 | Monorepo, Docker Compose de dev, migrações, **auth + equipe + permissões + 2FA + auditoria + bloqueio** | testes de login/bloqueio/2FA/reset; matriz papel×rota |
| 3 | Clientes, documentos privados, convite/portal, autocadastro, **isolamento do cliente** | testes provando que cliente A nunca lê/altera B nem acessa rota da equipe; funcionário sem "ver todos" |
| 4 | `core` + empréstimos, parcelas, pagamentos (parcial, Pix/dinheiro, recibo, estorno, quitação) | testes dos cálculos (inclusive dia 31 e 23h) |
| 5 | Solicitações, proposta, contrato, aceite, comprovantes | fluxo completo ponta a ponta |
| 6 | Caixa, relatórios, atividade, CSV/backup | testes do caixa e totais |
| 7 | E-mail, push, lembretes, LGPD, hardening, deploy (Compose + Caddy/HTTPS), README, `doctor` | `doctor` verde e checklist de produção |
| — | **Migração do front**: acompanha cada etapa (login na 2; clientes na 3; empréstimos/pagamentos na 4…) para o app nunca ficar meio quebrado | cada tela migrada mantém o comportamento atual |

## 6. Decisões em aberto (já com o padrão que vou seguir se você não disser o contrário)

1. **Juros**: simples sobre o total, como no protótipo; Price/compostos ficam como opção por empréstimo mais tarde. *(O BRIEF cita também "só-juros/renovação" — não está no prompt novo, deixei fora.)*
2. **Multa/mora e desconto de quitação ficam congelados no empréstimo** (valem os da data da proposta), em vez de mudarem retroativamente quando você altera Ajustes. É o que o contrato afirma ao cliente.
3. **Base da mora**: valor original da parcela (como hoje); pagamento parcial reduz o saldo, mas não reduz a base da mora.
4. **Liberação do valor**: ao aceitar a proposta o empréstimo fica `ativo` (como hoje), e a equipe registra "valor entregue" (dinheiro lança saída no caixa; Pix só marca). Datas das parcelas continuam as definidas na aprovação.
5. **Login do cliente**: e-mail único por empresa; CPF único por empresa (guardado cifrado, com hash para busca).
6. **Retenção de documentos** (LGPD): padrão 5 anos após a quitação do último empréstimo, depois exclusão automática. Esse prazo é jurídico — confirme com seu advogado.
7. **E-mail**: SMTP genérico (você escolhe o provedor no deploy). **Hospedagem**: um VPS com Docker Compose.
