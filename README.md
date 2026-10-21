# Caixa — controle de empréstimos pessoais

Back end (Node + Fastify + TypeScript + Drizzle + PostgreSQL) e front PWA em `apps/web`.

> ## ⚠️ Aviso legal
> Emprestar dinheiro de forma **habitual e com juros** pode exigir enquadramento legal (ex.: **SCD/ESC**, reguladas pelo Banco Central). Há **limites de juros** (Lei de Usura) e a **LGPD** se aplica a CPF, telefone e documentos. O **contrato do sistema é apenas um modelo**: faça revisar por **advogado** e valide a operação, a tributação e a retenção de documentos com **contador**. Este software não substitui orientação jurídica.

## Estrutura
- `packages/core` — cálculos puros (parcelas, multa/mora, quitação, datas em America/Sao_Paulo). Dinheiro em centavos, juros em pontos-base.
- `apps/api` — API `/api/v1`, banco, fila de e-mail/push, auditoria.
- `apps/web` — interface (PWA).
- `deploy/` — Docker Compose (Postgres + API + Caddy HTTPS), backup.
- `docs/` — arquitetura (Etapa 1) e política de privacidade modelo.

## Desenvolvimento
```bash
npm install
npm test            # núcleo + API (PGlite em memória)
npm run typecheck
BOOTSTRAP_ADMIN_EMAIL=eu@x.com BOOTSTRAP_ADMIN_PASSWORD='senha-longa-123' npm run dev   # http://localhost:3000
npm run doctor      # valida configuração
```
Sem `DATABASE_URL` o servidor usa PGlite em `./data` (só para testar). Em produção use PostgreSQL.

## Deploy (Docker Compose + HTTPS)
1. Servidor Linux com Docker e um domínio apontado (A/AAAA) para ele; portas 80/443 abertas.
2. `cp .env.example .env` e preencha. Gere as chaves: `openssl rand -hex 32` (SECRET_KEY) e `openssl rand -base64 32` (FILE_KEY).
   **Guarde a FILE_KEY fora do servidor**: sem ela, documentos e 2FA não podem ser abertos.
3. `cd deploy && docker compose up -d --build` — o Caddy emite o certificado sozinho.
4. `docker compose exec api npm run doctor -w @caixa/api` — deve terminar em "Tudo certo".
5. Entre com o administrador inicial, **troque a senha, ative o 2FA** e remova `BOOTSTRAP_ADMIN_PASSWORD` do `.env`.
6. Agende `deploy/backup.sh` no cron (diário) e copie os backups para fora do servidor.

## Variáveis de ambiente
| Variável | Para quê |
|---|---|
| `PUBLIC_URL`, `DOMAIN` | endereço público (links de e-mail, HTTPS) |
| `DATABASE_URL` | PostgreSQL (o compose define) |
| `SECRET_KEY` | segredo HMAC (códigos, tokens) — obrigatório em produção |
| `FILE_KEY` | chave mestra de criptografia de documentos/2FA — obrigatória em produção |
| `SMTP_URL`, `SMTP_FROM` | e-mails (reset de senha, convite, proposta, recibo) |
| `VAPID_*` | Web Push (opcional) |
| `TRUST_PROXY` | `true` atrás do Caddy |
| `BOOTSTRAP_ADMIN_*` | cria o 1º administrador |
| `DATA_DIR` | pasta dos arquivos criptografados |

## Segurança (resumo)
Senhas com argon2id; sessão em cookie httpOnly/SameSite + token CSRF; bloqueio de 5 min após 5 erros; 2FA TOTP; códigos de reset de uso único (15 min); autorização no servidor por papel e por recurso (cliente nunca acessa dado de outro: 404); arquivos criptografados (AES-256-GCM), só servidos por rota autenticada; auditoria encadeada por hash e imutável no banco; razão de pagamentos imutável (estorno = novo lançamento); CSV neutraliza injeção de fórmulas.

## LGPD
Consentimento registrado no autocadastro; cliente baixa seus dados e pede exclusão; admin anonimiza (apaga identificação e arquivos, mantém valores/datas por obrigação legal); documentos expiram pela retenção configurada. Modelo de política em `docs/POLITICA-DE-PRIVACIDADE.md`.

## Não incluído (opcional / depende de contratação)
Envio automático de WhatsApp (interface pronta; exige conta Meta Business) e conciliação Pix por PSP (webhook assinado); hoje o Pix é conferido manualmente e o WhatsApp usa link `wa.me`.

## Front (apps/web) e primeiro acesso

- O front é servido pela própria API (mesma origem) quando `apps/web/index.html` existe; não há build.
- Cliente com portal entra por **convite de uso único** (`#/convite/<token>`), enviado por e-mail/WhatsApp pela equipe — não existem mais senhas provisórias.
- Senha mínima: 8 caracteres. Avisos push exigem as chaves VAPID configuradas.
- A CSP permite apenas scripts do próprio domínio (handlers inline `onclick` liberados por `script-src-attr`).
