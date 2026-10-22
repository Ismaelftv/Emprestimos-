import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import { loadConfig } from './config.js';
import { bootCtx } from './boot.js';
import { users } from './db/schema.js';
import { verifyPassword } from './lib/crypto.js';
import { SENHA_PROVISORIA } from './bootstrap.js';
import { verifyAuditChain } from './lib/audit.js';

type R = { nivel: 'ok' | 'aviso' | 'erro'; msg: string };
const out: R[] = [];
const add = (nivel: R['nivel'], msg: string) => out.push({ nivel, msg });

let config;
try { config = loadConfig(); add('ok', `Configuração lida (NODE_ENV=${process.env.NODE_ENV ?? 'development'})`); }
catch (e) { console.log('✗ Configuração inválida: ' + (e as Error).message); process.exit(1); }

if (config.isProd) {
  if (!config.publicUrl.startsWith('https://')) add('erro', 'PUBLIC_URL deve começar com https:// em produção');
  else add('ok', 'PUBLIC_URL usa HTTPS');
  if (!config.cookieSecure) add('erro', 'COOKIE_SECURE deve ser true em produção');
  if (!config.databaseUrl) add('erro', 'DATABASE_URL (PostgreSQL) é obrigatório em produção; PGlite é só para testes/demonstração');
  else add('ok', 'Usando PostgreSQL');
  if (!config.trustProxy) add('aviso', 'TRUST_PROXY=false: atrás do Caddy/Nginx, ative para registrar o IP real e limitar tentativas por IP');
} else add('aviso', 'Ambiente de desenvolvimento: chaves de desenvolvimento em uso');
if (config.secret.length < 32) add('erro', 'SECRET_KEY curta');
if (!process.env.FILE_KEY && !config.isProd) add('aviso', 'FILE_KEY não definida (usando chave de desenvolvimento)');
else if (process.env.FILE_KEY) add('ok', 'FILE_KEY válida (32 bytes). Guarde uma cópia: sem ela, documentos e segredos 2FA não abrem.');

try {
  fs.mkdirSync(path.resolve(config.dataDir, 'files'), { recursive: true });
  const f = path.resolve(config.dataDir, 'files', '.doctor'); fs.writeFileSync(f, 'ok'); fs.rmSync(f);
  add('ok', `Pasta de arquivos gravável (${path.resolve(config.dataDir, 'files')})`);
} catch (e) { add('erro', 'Não consigo gravar em DATA_DIR: ' + (e as Error).message); }

try {
  const { ctx, handle } = await bootCtx(config);
  await ctx.db.execute(sql`select 1`); add('ok', `Banco conectado (${handle.kind}) e migrações aplicadas`);
  const admins = await ctx.db.select({ id: users.id, hash: users.passwordHash }).from(users).where(sql`${users.kind} = 'staff'`).limit(1);
  if (!admins.length) add('aviso', 'Nenhum administrador. Defina BOOTSTRAP_ADMIN_EMAIL e BOOTSTRAP_ADMIN_PASSWORD e inicie o servidor.');
  else {
    add('ok', 'Administrador cadastrado');
    const todos = await ctx.db.select({ hash: users.passwordHash }).from(users).where(sql`${users.kind} = 'staff'`);
    for (const t of todos) if (await verifyPassword(t.hash, SENHA_PROVISORIA)) add('erro', 'Um usuário da equipe ainda usa a SENHA PROVISÓRIA (pública no repositório). Troque-a agora em Ajustes > Segurança.');
  }
  const orgs = await ctx.db.execute(sql`select id from orgs`).then((r) => (r as unknown as { rows: { id: string }[] }).rows);
  for (const o of orgs) { const v = await verifyAuditChain(ctx.db, o.id); add(v.ok ? 'ok' : 'erro', v.ok ? `Trilha de auditoria íntegra (${v.checked} registros)` : 'TRILHA DE AUDITORIA ADULTERADA no registro ' + v.brokenAtSeq); }
  await handle.close();
} catch (e) { add('erro', 'Banco: ' + (e as Error).message); }

if (config.smtpUrl) {
  try { await nodemailer.createTransport(config.smtpUrl).verify(); add('ok', 'SMTP respondeu'); } catch (e) { add('erro', 'SMTP não conectou: ' + (e as Error).message); }
} else add(config.isProd ? 'erro' : 'aviso', 'SMTP_URL ausente: sem e-mail não há recuperação de senha nem convite');
if (config.vapid) add('ok', 'Web Push configurado (VAPID)'); else add('aviso', 'VAPID_* ausente: notificações push desativadas (gere com: npx web-push generate-vapid-keys)');

const icon = { ok: '✓', aviso: '!', erro: '✗' };
for (const r of out) console.log(`${icon[r.nivel]} ${r.msg}`);
const erros = out.filter((r) => r.nivel === 'erro').length;
console.log(erros ? `\n${erros} problema(s) a corrigir.` : '\nTudo certo para subir.');
console.log('\nLembrete: o contrato é só um modelo. Valide com advogado/contador (SCD/ESC, Lei de Usura, LGPD).');
process.exit(erros ? 1 : 0);
