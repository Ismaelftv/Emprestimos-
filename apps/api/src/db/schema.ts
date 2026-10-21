import { sql } from 'drizzle-orm';
import { bigint, boolean, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const cents = (name: string) => bigint(name, { mode: 'number' });

export const orgs = pgTable('orgs', {
  id: id(), nome: text('nome').notNull().default('Minha Carteira'), createdAt: ts('created_at').notNull().defaultNow(),
});

// Ajustes da empresa: valem para NOVOS contratos (o empréstimo guarda um snapshot).
export const settings = pgTable('settings', {
  orgId: uuid('org_id').primaryKey().references(() => orgs.id),
  empresa: text('empresa').notNull().default('Minha Carteira'),
  multaBps: integer('multa_bps').notNull().default(200),
  moraBpsMes: integer('mora_bps_mes').notNull().default(100),
  descQuitBps: integer('desc_quit_bps').notNull().default(5000),
  pixKey: text('pix_key').notNull().default(''),
  pixNome: text('pix_nome').notNull().default(''),
  aceitaPix: boolean('aceita_pix').notNull().default(true),
  aceitaDinheiro: boolean('aceita_dinheiro').notNull().default(true),
  whatsapp: text('whatsapp').notNull().default(''),
  minValorCents: cents('min_valor_cents').notNull().default(10000),
  maxValorCents: cents('max_valor_cents').notNull().default(500000),
  maxParcelas: integer('max_parcelas').notNull().default(12),
  taxasBps: jsonb('taxas_bps').$type<Record<string, number>>().notNull().default({ '1': 1000, '7': 2000, '15': 2500, '30': 3000 }),
  exigir2faAdmin: boolean('exigir_2fa_admin').notNull().default(false),
  retencaoDocumentosAnos: integer('retencao_documentos_anos').notNull().default(5),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: id(), orgId: uuid('org_id').notNull().references(() => orgs.id),
  kind: varchar('kind', { length: 10 }).notNull(), // staff | client
  email: text('email').notNull(),
  passwordHash: text('password_hash'),
  status: varchar('status', { length: 12 }).notNull().default('active'), // invited | active | disabled
  totpSecretEnc: text('totp_secret_enc'), totpEnabled: boolean('totp_enabled').notNull().default(false),
  lastLoginAt: ts('last_login_at'), createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => ({ emailUq: uniqueIndex('users_org_email_uq').on(t.orgId, t.email) }));

export const staffProfiles = pgTable('staff_profiles', {
  userId: uuid('user_id').primaryKey().references(() => users.id),
  nome: text('nome').notNull(), role: varchar('role', { length: 10 }).notNull(), // admin | staff
  comissaoBps: integer('comissao_bps').notNull().default(0),
  permCriar: boolean('perm_criar').notNull().default(true),
  permClientes: boolean('perm_clientes').notNull().default(true),
  permExcluir: boolean('perm_excluir').notNull().default(false),
  permLucro: boolean('perm_lucro').notNull().default(false),
  permTodos: boolean('perm_todos').notNull().default(false),
});

export const sessions = pgTable('sessions', {
  id: id(), userId: uuid('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(), csrfToken: text('csrf_token').notNull(),
  stage: varchar('stage', { length: 8 }).notNull().default('full'), // mfa | full
  ip: text('ip'), userAgent: text('user_agent'),
  createdAt: ts('created_at').notNull().defaultNow(), expiresAt: ts('expires_at').notNull(), revokedAt: ts('revoked_at'),
});

export const loginThrottle = pgTable('login_throttle', {
  key: text('key').primaryKey(), failCount: integer('fail_count').notNull().default(0),
  lockedUntil: ts('locked_until'), updatedAt: ts('updated_at').notNull().defaultNow(),
});

// kind: reset | invite
export const authTokens = pgTable('auth_tokens', {
  id: id(), userId: uuid('user_id').notNull().references(() => users.id), kind: varchar('kind', { length: 10 }).notNull(),
  tokenHash: text('token_hash').notNull(), attempts: integer('attempts').notNull().default(0),
  expiresAt: ts('expires_at').notNull(), usedAt: ts('used_at'), createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => ({ byUser: index('auth_tokens_user_idx').on(t.userId, t.kind) }));

export const files = pgTable('files', {
  id: id(), orgId: uuid('org_id').notNull().references(() => orgs.id),
  storageKey: text('storage_key').notNull(), mime: text('mime').notNull(), size: integer('size').notNull(),
  sha256: text('sha256').notNull(), encIv: text('enc_iv').notNull(), encTag: text('enc_tag').notNull(),
  ownerClientId: uuid('owner_client_id'), createdBy: uuid('created_by'), createdAt: ts('created_at').notNull().defaultNow(),
  purgeAfter: ts('purge_after'), purgedAt: ts('purged_at'),
});

export const clients = pgTable('clients', {
  id: id(), orgId: uuid('org_id').notNull().references(() => orgs.id),
  userId: uuid('user_id').references(() => users.id),
  nome: text('nome').notNull(), whatsapp: text('whatsapp').notNull().default(''),
  cpfEnc: text('cpf_enc'), cpfHash: text('cpf_hash'), cpfLast4: varchar('cpf_last4', { length: 4 }),
  cidade: text('cidade').notNull().default(''), obs: text('obs').notNull().default(''),
  responsavelId: uuid('responsavel_id').references(() => users.id),
  situacao: varchar('situacao', { length: 14 }).notNull().default('verificado'), // verificado | em_verificacao
  bloqueado: boolean('bloqueado').notNull().default(false), limiteCents: cents('limite_cents'),
  portalEnabled: boolean('portal_enabled').notNull().default(false),
  consentAt: ts('consent_at'), consentVersion: text('consent_version'),
  anonymizedAt: ts('anonymized_at'), deletedAt: ts('deleted_at'), createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => ({ cpfUq: uniqueIndex('clients_org_cpf_uq').on(t.orgId, t.cpfHash).where(sql`cpf_hash is not null and deleted_at is null`), respIdx: index('clients_resp_idx').on(t.responsavelId) }));

export const clientDocuments = pgTable('client_documents', {
  id: id(), clientId: uuid('client_id').notNull().references(() => clients.id),
  tipo: varchar('tipo', { length: 12 }).notNull(), // rg_frente | rg_verso | residencia | selfie
  fileId: uuid('file_id').notNull().references(() => files.id),
  status: varchar('status', { length: 10 }).notNull().default('enviado'), // enviado | aprovado | recusado | arquivado
  motivo: text('motivo'), reviewedBy: uuid('reviewed_by'), reviewedAt: ts('reviewed_at'), createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => ({ byClient: index('client_docs_client_idx').on(t.clientId) }));

export const loanRequests = pgTable('loan_requests', {
  id: id(), orgId: uuid('org_id').notNull().references(() => orgs.id), clientId: uuid('client_id').notNull().references(() => clients.id),
  valorCents: cents('valor_cents').notNull(), nParcelas: integer('n_parcelas').notNull(), freqDays: integer('freq_days').notNull(),
  motivo: text('motivo').notNull().default(''), status: varchar('status', { length: 10 }).notNull().default('analise'), // analise | aprovada | recusada
  motivoRecusa: text('motivo_recusa'), decidedBy: uuid('decided_by'), decidedAt: ts('decided_at'), loanId: uuid('loan_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const loans = pgTable('loans', {
  id: id(), orgId: uuid('org_id').notNull().references(() => orgs.id), clientId: uuid('client_id').notNull().references(() => clients.id),
  requestId: uuid('request_id'),
  valorCents: cents('valor_cents').notNull(), jurosBps: integer('juros_bps').notNull(), freqDays: integer('freq_days').notNull(),
  nParcelas: integer('n_parcelas').notNull(), pulaDomingo: boolean('pula_domingo').notNull().default(false),
  totalCents: cents('total_cents').notNull(),
  status: varchar('status', { length: 10 }).notNull(), // proposta | ativo | quitado | cancelado
  // snapshot das condições no momento da proposta
  multaBps: integer('multa_bps').notNull(), moraBpsMes: integer('mora_bps_mes').notNull(), descQuitBps: integer('desc_quit_bps').notNull(),
  contractText: text('contract_text').notNull().default(''), contractVersion: text('contract_version').notNull().default('v1'),
  acceptedAt: ts('accepted_at'), acceptedIp: text('accepted_ip'), acceptedBy: uuid('accepted_by'),
  disbursedAt: ts('disbursed_at'), disbursedMethod: varchar('disbursed_method', { length: 10 }), disbursedBy: uuid('disbursed_by'),
  canceledAt: ts('canceled_at'), canceledBy: uuid('canceled_by'),
  createdBy: uuid('created_by').notNull(), createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => ({ byClient: index('loans_client_idx').on(t.clientId) }));

export const installments = pgTable('installments', {
  id: id(), loanId: uuid('loan_id').notNull().references(() => loans.id),
  numero: integer('numero').notNull(), dueDate: date('due_date', { mode: 'string' }).notNull(), amountCents: cents('amount_cents').notNull(),
  waived: boolean('waived').notNull().default(false), waivedBy: uuid('waived_by'),
  settledAt: date('settled_at', { mode: 'string' }), settledExtraCents: cents('settled_extra_cents'),
  lembreteEm: date('lembrete_em', { mode: 'string' }),
}, (t) => ({ byLoan: index('inst_loan_idx').on(t.loanId), due: index('inst_due_idx').on(t.dueDate), uq: uniqueIndex('inst_loan_num_uq').on(t.loanId, t.numero) }));

// Livro-razão. kind: parcela | quitacao | desconto | estorno. Estorno tem valor negativo.
export const payments = pgTable('payments', {
  id: id(), orgId: uuid('org_id').notNull().references(() => orgs.id), installmentId: uuid('installment_id').notNull().references(() => installments.id),
  valorCents: cents('valor_cents').notNull(), method: varchar('method', { length: 10 }).notNull(), // pix | dinheiro | desconto
  kind: varchar('kind', { length: 10 }).notNull().default('parcela'),
  receivedBy: uuid('received_by').notNull(), receivedAt: ts('received_at').notNull().defaultNow(), receivedOn: date('received_on', { mode: 'string' }).notNull(),
  receiptNo: text('receipt_no'), reversesPaymentId: uuid('reverses_payment_id'), reversalReason: text('reversal_reason'), reportId: uuid('report_id'),
}, (t) => ({ byInst: index('pay_inst_idx').on(t.installmentId), byDay: index('pay_day_idx').on(t.receivedOn, t.receivedBy) }));

export const receiptSequences = pgTable('receipt_sequences', { orgId: uuid('org_id').primaryKey().references(() => orgs.id), lastNo: integer('last_no').notNull().default(0) });

export const paymentReports = pgTable('payment_reports', {
  id: id(), orgId: uuid('org_id').notNull().references(() => orgs.id), clientId: uuid('client_id').notNull().references(() => clients.id),
  installmentId: uuid('installment_id').references(() => installments.id),
  method: varchar('method', { length: 10 }).notNull(), valorCents: cents('valor_cents').notNull(), fileId: uuid('file_id').references(() => files.id), note: text('note').notNull().default(''),
  status: varchar('status', { length: 10 }).notNull().default('pendente'), // pendente | confirmado | recusado
  motivoRecusa: text('motivo_recusa'), decidedBy: uuid('decided_by'), decidedAt: ts('decided_at'), createdAt: ts('created_at').notNull().defaultNow(),
});

export const payoffRequests = pgTable('payoff_requests', {
  id: id(), orgId: uuid('org_id').notNull().references(() => orgs.id), loanId: uuid('loan_id').notNull().references(() => loans.id),
  clientId: uuid('client_id').notNull().references(() => clients.id),
  method: varchar('method', { length: 10 }).notNull(), fileId: uuid('file_id').references(() => files.id), note: text('note').notNull().default(''),
  valorCents: cents('valor_cents').notNull(), status: varchar('status', { length: 10 }).notNull().default('pendente'), // pendente | confirmado | recusado
  motivoRecusa: text('motivo_recusa'), decidedBy: uuid('decided_by'), decidedAt: ts('decided_at'), createdAt: ts('created_at').notNull().defaultNow(),
});

export const cashOps = pgTable('cash_ops', {
  id: id(), orgId: uuid('org_id').notNull().references(() => orgs.id), staffId: uuid('staff_id').notNull().references(() => users.id),
  date: date('date', { mode: 'string' }).notNull(), tipo: varchar('tipo', { length: 12 }).notNull(), // emprestimo | despesa | sangria
  valorCents: cents('valor_cents').notNull(), descricao: text('descricao').notNull().default(''), loanId: uuid('loan_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => ({ byDay: index('cash_ops_day_idx').on(t.staffId, t.date) }));

export const cashClosings = pgTable('cash_closings', {
  id: id(), orgId: uuid('org_id').notNull().references(() => orgs.id), staffId: uuid('staff_id').notNull().references(() => users.id),
  date: date('date', { mode: 'string' }).notNull(),
  inicialCents: cents('inicial_cents').notNull(), entradasCents: cents('entradas_cents').notNull(), pixCents: cents('pix_cents').notNull(), saidasCents: cents('saidas_cents').notNull(),
  esperadoCents: cents('esperado_cents').notNull(), contadoCents: cents('contado_cents').notNull(), diffCents: cents('diff_cents').notNull(),
  obs: text('obs').notNull().default(''), closedAt: ts('closed_at').notNull().defaultNow(),
}, (t) => ({ uq: uniqueIndex('cash_closing_uq').on(t.staffId, t.date) }));

export const auditLog = pgTable('audit_log', {
  seq: bigint('seq', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  orgId: uuid('org_id').notNull(), at: ts('at').notNull().defaultNow(),
  actorUserId: uuid('actor_user_id'), actorKind: varchar('actor_kind', { length: 10 }).notNull(), actorName: text('actor_name').notNull().default(''),
  action: text('action').notNull(), entity: text('entity'), entityId: text('entity_id'), summary: text('summary').notNull(),
  meta: jsonb('meta'), ip: text('ip'), ua: text('ua'), prevHash: text('prev_hash').notNull(), hash: text('hash').notNull(),
});

export const jobs = pgTable('jobs', {
  id: id(), kind: varchar('kind', { length: 20 }).notNull(), payload: jsonb('payload').notNull(),
  runAt: ts('run_at').notNull().defaultNow(), attempts: integer('attempts').notNull().default(0), maxAttempts: integer('max_attempts').notNull().default(6),
  status: varchar('status', { length: 10 }).notNull().default('pending'), // pending | done | failed
  lastError: text('last_error'), dedupeKey: text('dedupe_key').unique(), createdAt: ts('created_at').notNull().defaultNow(), doneAt: ts('done_at'),
}, (t) => ({ due: index('jobs_due_idx').on(t.status, t.runAt) }));

export const pushSubscriptions = pgTable('push_subscriptions', {
  id: id(), userId: uuid('user_id').notNull().references(() => users.id),
  endpoint: text('endpoint').notNull().unique(), p256dh: text('p256dh').notNull(), auth: text('auth').notNull(), createdAt: ts('created_at').notNull().defaultNow(),
});

export const privacyRequests = pgTable('privacy_requests', {
  id: id(), orgId: uuid('org_id').notNull(), clientId: uuid('client_id').notNull(), tipo: varchar('tipo', { length: 12 }).notNull(),
  status: varchar('status', { length: 10 }).notNull().default('feito'), requestedBy: uuid('requested_by'), createdAt: ts('created_at').notNull().defaultNow(),
});
