// Caixa — front (PWA). Todas as regras, permissões e cálculos vivem no servidor; aqui só desenhamos as telas.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// dinheiro: o servidor fala em centavos inteiros
const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const num = (s) => { s = String(s ?? '').trim().replace(/[^\d.,-]/g, ''); if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, ''); return parseFloat(s) || 0; };
const cents = (s) => Math.round(num(s) * 100);
const reais = (c) => (c / 100).toFixed(2).replace('.', ',').replace(/,00$/, '');
const bpsOf = (s) => Math.round(num(s) * 100);
const pctOf = (bps) => String(bps / 100).replace('.', ',');
// datas: sempre no fuso de São Paulo (o toISOString() em UTC viraria "amanhã" depois das 21h)
const todaySP = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
let hoje = todaySP();
const addDaysISO = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dt = (s) => new Date(s + 'T12:00:00');
const fd = (s) => dt(s).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '');
const fdl = (s) => dt(s).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
const fts = (s) => new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fdi = (s) => (s ? fd(String(s).slice(0, 10)) : '');
const FL = { 1: 'diário', 7: 'semanal', 15: 'quinzenal', 30: 'mensal' };
const COLORS = ['#D9381E', '#0B6B61', '#2a78d6', '#B45309', '#7c3aed', '#be185d'];
const ini = (n) => String(n || '?').trim().split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase();
const color = (n) => COLORS[[...String(n || '')].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const ico = (n) => `<svg class="ic"><use href="#i-${n}"/></svg>`;
const cpfOk = (v) => { const d = String(v).replace(/\D/g, ''); if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false; for (const n of [9, 10]) { let sum = 0; for (let i = 0; i < n; i++) sum += +d[i] * (n + 1 - i); if (((sum * 10) % 11) % 10 !== +d[n]) return false; } return true; };
const waNum = (f) => { const d = String(f || '').replace(/\D/g, ''); return d && d.length <= 11 ? '55' + d : d; };
const PERMS = { criar: 'Criar empréstimos', clientes: 'Cadastrar e editar clientes', excluir: 'Excluir (cancelar) empréstimos e clientes', lucro: 'Ver lucro e totais emprestados', todos: 'Ver clientes de outros funcionários' };
const DOCS = { rg_frente: 'Documento com foto (frente)', rg_verso: 'Documento (verso)', residencia: 'Comprovante de residência', selfie: 'Selfie segurando o documento' };
const LEGAL = 'Emprestar dinheiro de forma habitual e com juros pode exigir enquadramento legal (ex.: SCD/ESC, reguladas pelo Banco Central), há limites de juros (Lei de Usura) e a LGPD se aplica a CPF, telefone e documentos. O contrato do sistema é apenas um modelo: peça a um advogado para revisá-lo e confirme a operação com um contador.';

// ---------- estado ----------
let me = null, staffList = [], inbox = { solicitacoes: 0, comprovantes: 0, quitacoes: 0 };
let tab = 'home', filt = 'todos', term = '', clientId = null, freq = 7, installEv = null, sfilt = 'analise', renderSeq = 0, busy = false;
const isAdmin = () => me.role === 'admin';
const can = (p) => isAdmin() || !!(me.perms && me.perms[p]);
const cfg = () => (me && me.config) || {};
const uname = (id) => (staffList.find((u) => u.id === id) || { nome: '—' }).nome;
const IX = new Map(); // parcelas desenhadas na tela, por id (os botões consultam aqui)

function toast(t) { const e = $('toast'); e.textContent = t; e.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove('on'), 2600); }
// executa uma ação de botão/formulário: bloqueia clique duplo e mostra o erro do servidor como aviso
async function run(fn, ok) {
  if (busy) return; busy = true;
  try { const r = await fn(); if (ok) toast(ok); return r === undefined ? true : r; }
  catch (e) { if (!(e instanceof ApiError) || e.status !== 401) toast(e.message || 'Algo deu errado'); return false; }
  finally { busy = false; }
}
function openSheet(html) { $('sheet').innerHTML = html; $('sb').classList.add('open'); }
function closeSheet() { $('sb').classList.remove('open'); }
$('sb').onclick = (e) => { if (e.target === $('sb')) closeSheet(); };
const head = (t) => `<div class="row between"><h2 class="display" style="font-size:24px">${t}</h2><button type="button" class="ib" onclick="closeSheet()" aria-label="Fechar">${ico('x')}</button></div>`;
const FORM = 'display:flex;flex-direction:column;gap:12px';
const legalBox = () => `<div class="notice notice-warn" style="margin-top:16px">${ico('alert')}<span class="small">${LEGAL}</span></div>`;

// ---------- linhas de parcela ----------
const tagH = (p) => ({ paid: '<span class="tag t-ok">Pago</span>', late: '<span class="tag t-late">Atrasado</span>', today: '<span class="tag t-today">Hoje</span>', open: '' }[p.status]);
const lastPay = (p) => (p.pagamentos || []).filter((x) => x.kind !== 'estorno' && x.method !== 'desconto' && !x.estornado).at(-1);
function msg(p) {
  const first = p.clientNome.split(' ')[0];
  return p.status === 'late' ? `Oi ${first}, tudo bem? Sua parcela ${p.numero}/${p.nTotal} de ${brl(p.amountCents)} venceu em ${fd(p.dueDate)} (${p.days} dia(s) de atraso, total hoje ${brl(p.balanceCents)}). Consegue me passar o comprovante hoje?`
    : `Oi ${first}, tudo bem? Lembrete: sua parcela ${p.numero}/${p.nTotal} de ${brl(p.amountCents)} vence ${p.dueDate === hoje ? 'hoje' : 'em ' + fd(p.dueDate)}.`;
}
const waLink = (p) => { const f = waNum(p.clientWhatsapp); return f ? `https://wa.me/${f}?text=${encodeURIComponent(msg(p))}` : ''; };

function row(p) {
  IX.set(p.id, p);
  const paid = p.status === 'paid', lp = lastPay(p), wa = !paid && waLink(p);
  return `<div class="item"><button class="chk ${paid ? 'on' : ''}" onclick="tg('${p.id}')" aria-label="Marcar pago">${ico('check')}</button>
  <div class="av" style="background:${color(p.clientNome)}">${esc(ini(p.clientNome))}</div>
  <div class="grow"><b>${esc(p.clientNome)}</b><span class="small muted">Parcela ${p.numero}/${p.nTotal} · ${fd(p.dueDate)} ${tagH(p)}</span>
  ${p.aviso && !paid ? `<span class="tag t-today" style="cursor:pointer" onclick="proofSheet('${p.id}')">${p.aviso.method === 'dinheiro' ? 'Dinheiro combinado' : 'Comprovante enviado'} · conferir</span>` : ''}${paid ? `<span class="xs muted">${lp ? `Recebido por ${esc(lp.recebidoPor || '—')} em ${fd(lp.data)} · ${lp.method === 'dinheiro' ? 'dinheiro' : 'Pix'} · <a href="#" class="bold" style="color:var(--accent);display:inline" onclick="receiptSheet('${lp.id}');return false">Recibo</a>` : 'Quitada'}</span>` : `${p.partial ? `<span class="xs" style="color:var(--teal)">Pago parcial ${brl(p.paidCents)} · falta ${brl(p.balanceCents)}</span>` : ''}${p.extraCents ? `<span class="xs" style="color:var(--danger)">+ ${brl(p.extraCents)} de multa e mora (${p.days}d)</span>` : ''}`}</div>
  <div class="amt">${brl(paid ? p.recebidoCents : p.balanceCents)}</div>
  ${wa ? `<a class="ib" style="color:var(--teal)" href="${wa}" target="_blank" rel="noopener" aria-label="Cobrar no WhatsApp">${ico('wa')}</a>` : ''}</div>`;
}
const instOf = (l) => l.installments.map((i) => ({ ...i, clientNome: l.clientNome, clientId: l.clientId }));

// ---------- telas ----------
const greet = () => { const h = new Date().getHours(); return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'; };
async function home() {
  const [d, ib] = await Promise.all([GET('/dashboard'), GET('/inbox')]); inbox = ib; hoje = d.hoje; paintBadges();
  const pend = ib.solicitacoes + ib.quitacoes, vazio = d.aReceberCents === 0 && d.recebidoCents === 0;
  return `<h1 class="hello display">${greet()}, ${esc(me.nome.split(' ')[0])} 👋</h1><span class="muted small">${d.vencemHoje ? `${d.vencemHoje} vencimento(s) hoje` : 'Nenhum vencimento hoje'}${d.atrasadas ? ` · <b style="color:var(--danger)">${d.atrasadas} em atraso</b>` : ''}</span>
  <div class="hero"><small>A receber</small><div class="big">${brl(d.aReceberCents)}</div>
   <div class="pills"><div class="pill"><b>${d.emprestadoCents !== null ? brl(d.emprestadoCents) : brl(d.recebiHojeCents)}</b><span>${d.emprestadoCents !== null ? 'Emprestado' : 'Recebi hoje'}</span></div><div class="pill"><b>${brl(d.recebidoCents)}</b><span>Recebido</span></div><div class="pill"><b style="color:${d.atrasadas ? '#ff9d8f' : 'inherit'}">${brl(d.emAtrasoCents)}</b><span>Em atraso</span></div></div></div>
  ${pend || ib.comprovantes ? `<div class="notice notice-teal" style="margin-bottom:12px;cursor:pointer" onclick="${pend ? "go('solic')" : "go('agenda')"}">${ico('clock')}<span class="small"><b>${pend}</b> solicitação(ões) e <b>${ib.comprovantes}</b> comprovante(s) para conferir</span></div>` : ''}
  <div class="qa">
   <button onclick="${can('criar') ? 'openNew()' : "toast('Sem permissão')"}"><span class="c" style="background:var(--accent-soft);color:var(--accent)">${ico('plus')}</span>Novo</button>
   <button onclick="go('agenda','hoje')"><span class="c" style="background:var(--warn-bg);color:var(--warn-fg)">${ico('cal')}</span>Hoje</button>
   <button onclick="go('agenda','atraso')"><span class="c" style="background:var(--danger-soft);color:var(--danger)">${ico('alert')}</span>Atrasos</button>
   <button onclick="go('clientes')"><span class="c" style="background:var(--teal-soft);color:var(--teal)">${ico('users')}</span>Clientes</button></div>
  ${d.emAtraso.length ? `<div class="sec"><h2>Em atraso</h2></div>${d.emAtraso.map(row).join('')}` : ''}
  <div class="sec"><h2>Próximos vencimentos</h2><a class="small bold" href="#" onclick="go('agenda');return false" style="color:var(--accent)">Ver tudo</a></div>
  ${d.proximas.map(row).join('') || `<div class="empty2">${vazio ? 'Toque no <b>+</b> para criar o primeiro empréstimo.' : 'Tudo em dia!'}</div>`}`;
}

async function agenda() {
  const chips = [['todos', 'Abertos'], ['atraso', 'Atrasados'], ['hoje', 'Hoje'], ['semana', '7 dias'], ['pagos', 'Pagos']];
  const r = await GET('/installments' + qs({ filtro: filt, q: term })); hoje = r.hoje;
  let last = '', html = '';
  for (const p of r.items) { if (p.dueDate !== last) { last = p.dueDate; html += `<div class="day">${p.dueDate === hoje ? 'Hoje · ' : ''}${fdl(p.dueDate)}</div>`; } html += row(p); }
  return `<div class="row between" style="align-items:center"><h1 class="hello display">Agenda</h1><button class="btn btn-light btn-sm" onclick="lembretesSheet()">${ico('wa')} Lembretes</button></div><div class="chips">${chips.map(([k, t]) => `<button class="chip ${filt === k ? 'on' : ''}" onclick="filt='${k}';render()">${t}</button>`).join('')}</div>${html || '<div class="empty2">Nada por aqui.</div>'}`;
}

async function clientes() {
  if (clientId) {
    const [c, ls] = await Promise.all([GET('/clients/' + clientId).catch((e) => { if (e.status === 404) return null; throw e; }), GET('/loans' + qs({ clientId }))]);
    if (!c) { clientId = null; return clientes(); }
    const wa = waNum(c.whatsapp);
    return `<button class="chip" onclick="clientId=null;render()" style="margin-top:16px">← Clientes</button>
    <div class="row gap-12" style="margin:16px 0"><div class="av" style="background:${color(c.nome)};width:56px;height:56px;font-size:20px">${esc(ini(c.nome))}</div>
     <div class="grow"><h1 class="display" style="font-size:26px">${esc(c.nome)}</h1><span class="small muted">${esc(c.whatsapp || 'Sem WhatsApp')}${c.cidade ? ' · ' + esc(c.cidade) : ''} · Resp.: ${esc(uname(c.responsavelId))}</span></div>
     ${can('clientes') ? `<button class="ib" onclick="clientSheet('${c.id}')" aria-label="Editar">${ico('edit')}</button>` : ''}</div>
    ${c.portalEnabled && c.email ? `<div class="notice notice-teal" style="margin-bottom:12px">${ico('user')}<span class="small">${c.portalStatus === 'invited' ? `Convite enviado para ${esc(c.email)} (aguardando criar a senha).` : `Acesso ao portal ativo (${esc(c.email)}).`} ${can('clientes') && c.portalStatus === 'invited' ? `<a class="bold" href="#" onclick="portalInvite('${c.id}');return false">Reenviar convite</a>` : ''}</span></div>` : ''}${c.situacao === 'em_verificacao' ? '<div class="notice notice-warn" style="margin-bottom:12px"><span class="small">Cadastro em verificação — confira os dados e documentos; ao aprovar todos os documentos ele é marcado como verificado.</span></div>' : ''}${c.bloqueado ? '<div class="notice notice-warn" style="margin-bottom:12px"><span class="small">Cliente bloqueado para novos empréstimos.</span></div>' : ''}
    ${c.obs ? `<div class="tile small" style="margin-bottom:12px">${esc(c.obs)}</div>` : ''}
    ${c.portalEnabled || c.documentos.some((d) => d.status !== 'pendente') ? docsStaff(c) : ''}
    ${can('criar') ? `<button class="btn btn-primary btn-sm" style="margin-bottom:12px" onclick="openNew('${c.id}')">${ico('plus')} Novo empréstimo</button>` : ''}
    ${ls.map((l) => `<div class="card card-pad stack gap-8" style="margin-bottom:12px"><div class="row between"><b>${brl(l.valorCents)} · ${pctOf(l.jurosBps)}% · ${FL[l.freqDays]}</b>${l.status === 'proposta' ? '<span class="tag t-today">Aguardando aceite</span>' : l.status === 'cancelado' ? '<span class="tag t-off">Cancelado</span>' : l.status === 'quitado' ? '<span class="tag t-ok">Quitado</span>' : l.disbursedAt ? '' : '<span class="tag t-today">Valor não liberado</span>'}${can('criar') ? `<button class="ib" onclick="loanMenu('${l.id}')" aria-label="Mais">${ico('more')}</button>` : ''}</div>
    <span class="small muted">${l.pagas}/${l.nParcelas} parcelas pagas · total ${brl(l.totalCents)} · criado por ${esc(uname(l.createdBy))}</span><div class="bar"><i style="width:${(l.pagas / l.nParcelas) * 100}%"></i></div></div>${l.status === 'cancelado' ? '' : instOf(l).map(row).join('')}`).join('') || '<div class="empty2">Nenhum empréstimo para este cliente.</div>'}`;
  }
  const list = await GET('/clients' + qs({ q: term }));
  return `<div class="row between" style="align-items:center"><h1 class="hello display">Clientes</h1>${can('clientes') ? `<button class="btn btn-primary btn-sm" onclick="clientSheet()">${ico('plus')} Cliente</button>` : ''}</div>
  ${list.map((c) => `<div class="item click" onclick="clientId='${c.id}';render()"><div class="av" style="background:${color(c.nome)}">${esc(ini(c.nome))}</div><div class="grow"><b>${esc(c.nome)}</b><span class="small muted">${c.resumo.abertas} parcela(s) em aberto${isAdmin() ? ' · ' + esc(uname(c.responsavelId)) : ''}</span></div><div style="text-align:right"><div class="amt">${brl(c.resumo.emAbertoCents)}</div>${c.resumo.atrasado ? '<span class="tag t-late">Atrasado</span>' : '<span class="tag t-ok">Em dia</span>'}</div></div>`).join('') || '<div class="empty2">Nenhum cliente ainda.</div>'}`;
}

async function relat() {
  if (!can('lucro')) return '<div class="empty2">Você não tem acesso a esta tela.</div>';
  const [s, rb] = await Promise.all([GET('/reports/summary'), isAdmin() ? GET('/reports/received-by-staff') : null]);
  const mx = Math.max(1, ...s.aReceberPorMes.map((m) => m.valorCents));
  return `<h1 class="hello display">Resumo</h1><div class="dash-grid" style="margin-top:16px">
   <div class="stat"><span class="small muted bold">Lucro previsto</span><span class="v" style="color:var(--teal)">${brl(s.lucroPrevistoCents)}</span></div>
   <div class="stat"><span class="small muted bold">Empréstimos</span><span class="v">${s.emprestimos}</span></div>
   <div class="stat"><span class="small muted bold">Já recebido</span><span class="v">${s.percentualRecebido}%</span></div></div>
   <div class="sec"><h2>Inadimplência por faixa de atraso</h2></div>
   <div class="dash-grid">${s.inadimplencia.map((b) => `<div class="stat"><span class="small muted bold">${esc(b.faixa)}</span><span class="v" style="color:${b.parcelas ? 'var(--danger)' : ''}">${brl(b.valorCents)}</span><span class="xs muted">${b.parcelas} parcela(s)</span></div>`).join('')}</div>
   ${rb ? `<div class="sec"><h2>Recebido no mês por funcionário</h2></div><div class="card card-pad stack gap-8">${rb.itens.map((u) => `<div class="row between small"><b>${esc(u.nome)}</b><span>${brl(u.recebidoCents)} · ${u.recebimentos} recebimento(s)</span></div>`).join('')}</div>` : ''}
   <div class="sec"><h2>A receber por mês</h2></div><div class="card card-pad stack gap-12">${s.aReceberPorMes.map((m) => `<div><div class="row between small"><b>${new Date(m.mes + '-15T12:00:00').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}</b><span>${brl(m.valorCents)}</span></div><div class="bar"><i style="width:${(m.valorCents / mx) * 100}%;background:var(--accent)"></i></div></div>`).join('') || '<span class="muted small">Sem parcelas em aberto.</span>'}</div>
   ${legalBox()}
   <div class="row gap-8" style="margin-top:16px"><button class="btn btn-light btn-sm" onclick="csv()">Exportar CSV</button></div>`;
}

async function equipe() {
  if (!isAdmin()) return '<div class="empty2">Somente o administrador acessa a equipe.</div>';
  const [list, rb] = await Promise.all([GET('/staff'), GET('/reports/received-by-staff')]); staffList = list;
  const rec = new Map(rb.itens.map((x) => [x.staffId, x]));
  return `<div class="row between" style="align-items:center"><h1 class="hello display">Equipe</h1><button class="btn btn-primary btn-sm" onclick="userSheet()">${ico('plus')} Funcionário</button></div>
  <span class="muted small">Cada pessoa entra com o próprio e-mail e senha (criada por convite). O que ela vê e faz é definido pelas permissões.</span><div style="height:14px"></div>
  ${list.map((u) => { const r = rec.get(u.id) || { recebidoCents: 0, comissaoCents: 0 };
    return `<div class="item click" onclick="userSheet('${u.id}')"><div class="av" style="background:${color(u.nome)}">${esc(ini(u.nome))}</div><div class="grow"><b>${esc(u.nome)}</b><span class="small muted">${esc(u.email)} · ${u.clientes} cliente(s)${u.totpEnabled ? ' · 2FA' : ''}</span></div>
    <div style="text-align:right"><div class="amt">${brl(r.recebidoCents)}</div><span class="tag ${u.status === 'disabled' ? 't-off' : u.status === 'invited' ? 't-today' : u.role === 'admin' ? 't-adm' : 't-ok'}">${u.status === 'disabled' ? 'Inativo' : u.status === 'invited' ? 'Convidado' : u.role === 'admin' ? 'Admin' : 'Funcionário'}</span>${u.comissaoBps ? `<div class="xs muted">comissão ${brl(r.comissaoCents)}</div>` : ''}</div></div>`; }).join('')}
  <div class="xs muted" style="margin-top:8px">Valores = recebido no mês por cada pessoa.</div>`;
}

let auditItems = [], auditNext = null;
async function atividade() {
  if (!isAdmin()) return '<div class="empty2">Somente o administrador acessa o histórico.</div>';
  const r = await GET('/audit' + qs({ limit: 50 })); auditItems = r.items; auditNext = r.next;
  return `<h1 class="hello display">Atividade</h1><div class="card card-pad" style="margin-top:12px" id="alist">${auditHtml(auditItems)}</div>
  <div class="row gap-8" style="margin-top:12px">${auditNext ? '<button class="btn btn-light btn-sm" id="amore" onclick="auditMore()">Carregar mais</button>' : ''}<button class="btn btn-ghost btn-sm" onclick="auditVerify()">Verificar integridade do histórico</button></div>`;
}
const auditHtml = (items) => items.map((x) => `<div class="log-i"><div class="av" style="width:34px;height:34px;font-size:13px;background:${color(x.actor)}">${esc(ini(x.actor))}</div><div class="grow"><b>${esc(x.actor)}</b><span style="white-space:normal">${esc(x.summary)}</span></div><time>${fts(x.at)}</time></div>`).join('') || '<span class="muted small">Nada registrado ainda.</span>';
window.auditMore = () => run(async () => { const r = await GET('/audit' + qs({ limit: 50, before: auditNext })); auditItems = auditItems.concat(r.items); auditNext = r.next; $('alist').innerHTML = auditHtml(auditItems); if (!auditNext) $('amore').remove(); });
window.auditVerify = () => run(async () => { const r = await GET('/audit/verify'); toast(r.ok ? `Histórico íntegro (${r.checked} registros) ✓` : `ATENÇÃO: histórico adulterado a partir do registro ${r.brokenAtSeq}`); });

async function config() {
  if (!isAdmin()) return '<div class="empty2">Somente o administrador acessa os ajustes.</div>';
  const [c, priv] = await Promise.all([GET('/settings'), GET('/privacy/requests')]);
  return `<h1 class="hello display">Ajustes</h1><form class="card card-pad stack gap-12" style="margin-top:12px" onsubmit="saveCfg(event)">
   <div class="field"><label>Nome da carteira / empresa</label><input class="input" id="c-emp" value="${esc(c.empresa)}" /></div>
   <div class="row2"><div class="field"><label>Multa por atraso (%)</label><input class="input" id="c-multa" inputmode="decimal" value="${pctOf(c.multaBps)}" /></div>
   <div class="field"><label>Juros de mora (% ao mês)</label><input class="input" id="c-mora" inputmode="decimal" value="${pctOf(c.moraBpsMes)}" /></div></div>
   <span class="xs muted">A multa é cobrada uma vez quando a parcela atrasa; a mora cresce por dia de atraso. Vale para empréstimos criados daqui para frente (cada contrato guarda as condições da época).</span>
   <hr style="border:0;border-top:1px solid var(--line);width:100%"><b>Pagamento e portal do cliente</b>
   <label class="switch"><span>Aceitar pagamento por Pix</span><input type="checkbox" id="c-apix" ${c.aceitaPix ? 'checked' : ''} /></label>
   <label class="switch"><span>Aceitar pagamento em dinheiro</span><input type="checkbox" id="c-adin" ${c.aceitaDinheiro ? 'checked' : ''} /></label>
   <div class="row2"><div class="field"><label>Chave Pix da empresa</label><input class="input" id="c-pix" value="${esc(c.pixKey)}" /></div><div class="field"><label>Nome do recebedor</label><input class="input" id="c-pixn" value="${esc(c.pixNome)}" /></div></div>
   <div class="field"><label>WhatsApp da empresa (ajuda do cliente)</label><input class="input" id="c-wa" inputmode="tel" value="${esc(c.whatsapp)}" /></div>
   <div class="row2"><div class="field"><label>Valor mínimo (R$)</label><input class="input" id="c-min" inputmode="decimal" value="${reais(c.minValorCents)}" /></div><div class="field"><label>Valor máximo (R$)</label><input class="input" id="c-max" inputmode="decimal" value="${reais(c.maxValorCents)}" /></div></div>
   <div class="field"><label>Desconto nos juros futuros ao quitar antes (%)</label><input class="input" id="c-dq" inputmode="decimal" value="${pctOf(c.descQuitBps)}" /></div>
   <div class="field"><label>Máximo de parcelas</label><input class="input" id="c-mn" type="number" min="1" value="${c.maxParcelas}" /></div>
   <b class="small">Juros total sugerido nas solicitações (%)</b>
   <div class="row2">${[[1, 'Diário'], [7, 'Semanal'], [15, 'Quinzenal'], [30, 'Mensal']].map(([f, t]) => `<div class="field"><label>${t}</label><input class="input" id="c-t${f}" inputmode="decimal" value="${pctOf(c.taxasBps[f])}" /></div>`).join('')}</div>
   <hr style="border:0;border-top:1px solid var(--line);width:100%"><b>Segurança e privacidade</b>
   <label class="switch"><span>Exigir 2FA dos administradores</span><input type="checkbox" id="c-2fa" ${c.exigir2faAdmin ? 'checked' : ''} /></label>
   <div class="field"><label>Guardar documentos dos clientes por (anos, sem movimentação)</label><input class="input" id="c-ret" type="number" min="1" max="20" value="${c.retencaoDocumentosAnos}" /></div>
   <button class="btn btn-primary" style="align-self:flex-start">Salvar ajustes</button></form>
   ${priv.length ? `<div class="card card-pad stack gap-8" style="margin-top:16px"><b>Pedidos de exclusão de dados (LGPD)</b>${priv.map((p) => `<div class="row between gap-8"><span class="small">${esc(p.nome)} · ${fdi(p.em)}</span><button class="btn btn-light btn-sm" onclick="anonSheet('${p.clientId}')">Analisar</button></div>`).join('')}</div>` : ''}
   <div class="card card-pad stack gap-8" style="margin-top:16px"><b>Segurança da sua conta</b><span class="small muted">Verificação em duas etapas: ${me.totpEnabled ? 'ativada' : 'desativada'}.</span><div class="row gap-8 wrap"><button class="btn btn-light btn-sm" onclick="twoFaSheet()">${me.totpEnabled ? 'Gerenciar 2FA' : 'Ativar 2FA'}</button><button class="btn btn-light btn-sm" onclick="avisosOn()">Ativar avisos no aparelho</button><button class="btn btn-light btn-sm" onclick="passSheet()">Alterar senha</button></div></div>
   <div class="row gap-8 wrap" style="margin-top:16px"><button class="btn btn-light btn-sm" onclick="csv()">Exportar parcelas (CSV)</button><button class="btn btn-light btn-sm" onclick="csv('payments')">Exportar recebimentos (CSV)</button><button class="btn btn-light btn-sm" onclick="backup()">Backup (JSON)</button><a class="btn btn-ghost btn-sm" href="privacidade.html" target="_blank" rel="noopener">Política de privacidade</a></div>
   ${legalBox()}`;
}
window.saveCfg = (e) => { e.preventDefault(); run(async () => {
  const body = { empresa: $('c-emp').value.trim() || 'Minha Carteira', multaBps: bpsOf($('c-multa').value), moraBpsMes: bpsOf($('c-mora').value), pixKey: $('c-pix').value.trim(), pixNome: $('c-pixn').value.trim(), whatsapp: $('c-wa').value.trim(),
    aceitaPix: $('c-apix').checked, aceitaDinheiro: $('c-adin').checked, descQuitBps: Math.min(10000, bpsOf($('c-dq').value)), minValorCents: cents($('c-min').value) || 10000, maxValorCents: cents($('c-max').value) || 500000, maxParcelas: +$('c-mn').value || 12,
    taxasBps: Object.fromEntries([1, 7, 15, 30].map((f) => [String(f), bpsOf($('c-t' + f).value)])), exigir2faAdmin: $('c-2fa').checked, retencaoDocumentosAnos: +$('c-ret').value || 5 };
  await PATCH('/settings', body); await refreshMe(); shell();
}, 'Ajustes salvos ✓'); };
window.csv = (w) => run(() => (w === 'payments' ? download('/export/payments.csv', 'recebimentos.csv') : download('/export/installments.csv', 'parcelas.csv')));
window.backup = () => run(() => download('/export/backup', 'caixa-backup.json'));

// ---------- solicitações e comprovantes (lado da equipe) ----------
async function solic() {
  if (!can('criar')) return '<div class="empty2">Você não tem acesso a esta tela.</div>';
  const [list, quits] = await Promise.all([GET('/requests' + qs({ status: sfilt })), sfilt === 'analise' ? GET('/payoff-requests') : []]);
  const chips = [['analise', 'Em análise'], ['aprovada', 'Aprovadas'], ['recusada', 'Recusadas']];
  return `<h1 class="hello display">Solicitações</h1><span class="muted small">Pedidos feitos pelos clientes no portal.</span><div style="height:12px"></div>
  ${quits.map(quitItem).join('')}
  <div class="chips">${chips.map(([k, t]) => `<button class="chip ${sfilt === k ? 'on' : ''}" onclick="sfilt='${k}';render()">${t}</button>`).join('')}</div>
  ${list.map((r) => `<div class="card card-pad stack gap-8" style="margin-bottom:12px"><div class="row between"><div class="row gap-12"><div class="av" style="background:${color(r.clienteNome)}">${esc(ini(r.clienteNome))}</div><div><b>${esc(r.clienteNome)}</b><div class="small muted">${esc(r.whatsapp || 'sem WhatsApp')}</div></div></div><b class="amt">${brl(r.valorCents)}</b></div>
    <span class="small">${r.nParcelas}x ${FL[r.freqDays]} · enviada em ${fdi(r.createdAt)}${r.motivo ? ' · “' + esc(r.motivo) + '”' : ''}</span>
    <div class="row gap-8 wrap"><span class="tag ${r.cadastroVerificado ? 't-ok' : 't-today'}">${r.cadastroVerificado ? 'Cadastro verificado' : 'Cadastro não verificado'}</span><span class="tag ${r.parcelasAtrasadas ? 't-late' : 't-ok'}">${r.parcelasAtrasadas ? r.parcelasAtrasadas + ' parcela(s) atrasada(s)' : 'Sem atrasos'}</span><span class="tag t-off">${r.emprestimosAbertos} empréstimo(s) em aberto</span></div>
    ${r.status === 'analise' ? `<div class="row gap-8"><button class="btn btn-primary btn-sm" onclick="approveSheet('${r.id}')">Aprovar…</button><button class="btn btn-light btn-sm" onclick="refuseSheet('${r.id}')">Recusar</button><button class="btn btn-ghost btn-sm" onclick="go('clientes');clientId='${r.clientId}';render()">Ver cliente</button></div>`
      : r.status === 'recusada' ? `<div class="tile small">Motivo: ${esc(r.motivoRecusa || '—')} · por ${esc(uname(r.decidedBy))}</div>` : `<div class="tile small">Aprovada por ${esc(uname(r.decidedBy))}</div>`}</div>`).join('') || '<div class="empty2">Nenhuma solicitação aqui.</div>'}`;
}
let reqCache = new Map();
window.approveSheet = (id) => run(async () => {
  const r = (await GET('/requests?status=analise')).find((x) => x.id === id); if (!r) throw new Error('Esta solicitação já foi decidida');
  reqCache.set(id, r);
  openSheet(`<form onsubmit="doApprove(event,'${id}')" style="${FORM}">${head('Aprovar proposta')}
   <span class="small muted">${esc(r.clienteNome)} pediu ${brl(r.valorCents)} em ${r.nParcelas}x ${FL[r.freqDays]}. Ajuste as condições se quiser.</span>
   <div class="row2"><div class="field"><label>Valor</label><input class="input" id="a-v" inputmode="decimal" value="${reais(r.valorCents)}" /></div><div class="field"><label>Juros total (%)</label><input class="input" id="a-t" inputmode="decimal" value="${pctOf(r.jurosSugeridoBps)}" /></div></div>
   <div class="row2"><div class="field"><label>Parcelas</label><input class="input" id="a-n" type="number" min="1" value="${r.nParcelas}" /></div><div class="field"><label>1º vencimento</label><input class="input" id="a-d" type="date" value="${addDaysISO(hoje, r.freqDays)}" /></div></div>
   <div class="sum" id="a-prev"></div>
   <button class="btn btn-primary btn-lg" style="justify-content:center">${ico('check')} Aprovar e enviar proposta ao cliente</button></form>`);
  const pv = () => previewInto('a-prev', { valorCents: cents($('a-v').value), jurosBps: bpsOf($('a-t').value), freqDays: r.freqDays, nParcelas: Math.max(1, +$('a-n').value || 1), firstDue: $('a-d').value, pulaDomingo: r.freqDays === 1 });
  ['a-v', 'a-t', 'a-n', 'a-d'].forEach((i) => $(i).addEventListener('input', pv)); pv();
});
window.doApprove = (e, id) => { e.preventDefault(); run(async () => {
  const v = cents($('a-v').value), t = bpsOf($('a-t').value);
  if (!(v > 0) || t < 0 || !$('a-d').value) throw new Error('Valor, juros ou vencimento inválidos');
  await POST(`/requests/${id}/approve`, { valorCents: v, jurosBps: t, nParcelas: Math.max(1, +$('a-n').value || 1), firstDue: $('a-d').value });
  closeSheet(); render();
}, 'Proposta enviada ao cliente ✓ Aguardando o aceite.'); };
window.refuseSheet = (id) => openSheet(`<form onsubmit="doRefuse(event,'${id}')" style="${FORM}">${head('Recusar solicitação')}
   <div class="field"><label>Motivo (o cliente verá)</label><textarea class="textarea" id="rf-m" required minlength="3" placeholder="Ex.: existe parcela em atraso"></textarea></div><button class="btn btn-danger btn-lg" style="justify-content:center">Recusar</button></form>`);
window.doRefuse = (e, id) => { e.preventDefault(); run(async () => { await POST(`/requests/${id}/refuse`, { motivo: $('rf-m').value.trim() }); closeSheet(); render(); }, 'Solicitação recusada'); };

// prévia de parcelas calculada pelo servidor (mesma conta do contrato), com pequena espera ao digitar
let pvTimer = 0, pvSeq = 0;
function previewInto(elId, b) {
  clearTimeout(pvTimer);
  const el = $(elId); if (!el) return;
  if (!(b.valorCents > 0) || !b.firstDue) { el.innerHTML = 'Preencha valor e 1º vencimento para ver o resumo.'; return; }
  const seq = ++pvSeq;
  pvTimer = setTimeout(async () => {
    try { const r = await POST('/loans/preview', b); if (seq !== pvSeq || !$(elId)) return;
      $(elId).innerHTML = `Você recebe <b>${brl(r.totalCents)}</b><br>${b.nParcelas}x de <b>${brl(r.installments[0].amountCents)}</b> · lucro ${brl(r.lucroCents)}<br>Último vencimento: ${fd(r.installments.at(-1).due)}`;
    } catch (e) { if (seq === pvSeq && $(elId)) $(elId).textContent = e.message; }
  }, 200);
}

window.proofSheet = (id) => {
  const p = IX.get(id); if (!p || !p.aviso) return;
  const a = p.aviso, cash = a.method === 'dinheiro';
  openSheet(`${head(cash ? 'Pagamento em dinheiro' : 'Conferir comprovante')}<span class="small muted">${esc(p.clientNome)} · parcela ${p.numero}/${p.nTotal} · informado ${brl(a.valorCents)}</span>
   ${cash ? `<div class="tile small"><b>Cliente vai pagar em dinheiro.</b><br>${esc(a.note || 'Sem observação.')}</div>` : a.fileId ? `<img src="${API}/files/${a.fileId}" alt="Comprovante" style="width:100%;max-height:50vh;object-fit:contain;border-radius:12px;background:var(--soft)" />` : ''}
   <button class="btn btn-primary btn-lg" style="justify-content:center" onclick="confirmReported('${a.id}')">${ico('check')} ${cash ? 'Recebi o dinheiro' : 'Confirmar recebimento'}</button>
   <div class="field"><label>Ou recusar com motivo</label><input class="input" id="pr-m" placeholder="Ex.: valor diferente do informado" /></div>
   <button class="btn btn-light" onclick="refuseProof('${a.id}')">${cash ? 'Cancelar combinado' : 'Recusar comprovante'}</button>`);
};
window.confirmReported = (rid) => run(async () => { const r = await POST(`/payment-reports/${rid}/confirm`, {}); closeSheet(); render(); await receiptView(r.paymentId); });
window.refuseProof = (rid) => run(async () => { await POST(`/payment-reports/${rid}/refuse`, { motivo: $('pr-m').value.trim() }); closeSheet(); render(); }, 'Comprovante recusado');

let cmethod = 'pix';
window.collectSheet = (id) => {
  const p = IX.get(id); if (!p) return;
  openSheet(`${head('Receber parcela')}<div class="sum"><span class="small">${esc(p.clientNome)} · parcela ${p.numero}/${p.nTotal}</span><br><b>${brl(p.balanceCents)}</b>${p.extraCents ? `<br><span class="small">inclui ${brl(p.extraCents)} de multa e mora</span>` : ''}${p.paidCents ? `<br><span class="small">já pago ${brl(p.paidCents)}</span>` : ''}</div>
   <div class="field"><label>Valor recebido agora (parcial é permitido)</label><input class="input" id="cv" inputmode="decimal" value="${reais(p.balanceCents)}" /></div>
   <div class="field"><label>Forma de pagamento</label><div class="chips" id="cm">${[['pix', 'Pix'], ['dinheiro', 'Dinheiro']].map(([k, t]) => `<button type="button" class="chip ${cmethod === k ? 'on' : ''}" data-m="${k}">${t}</button>`).join('')}</div></div>
   <button class="btn btn-primary btn-lg" style="justify-content:center" id="cok">${ico('check')} Confirmar recebimento</button>`);
  $('cm').onclick = (e) => { const b = e.target.closest('[data-m]'); if (!b) return; cmethod = b.dataset.m; document.querySelectorAll('#cm .chip').forEach((c) => c.classList.toggle('on', c === b)); };
  $('cok').onclick = () => run(async () => {
    const v = cents($('cv').value); if (!(v > 0)) throw new Error('Informe um valor válido');
    const r = await POST(`/installments/${id}/payments`, { valorCents: v, method: cmethod });
    closeSheet(); render(); await receiptView(r.paymentId); toast(r.quitada ? 'Pagamento registrado ✓' : 'Pagamento parcial registrado ✓');
  });
};
window.tg = (id) => {
  const p = IX.get(id); if (!p) return;
  if (p.status === 'paid') {
    const lp = lastPay(p); if (!lp) return;
    if (!(isAdmin() || lp.recebidoPorId === me.id)) return toast('Só o administrador ou quem recebeu pode desfazer');
    return openSheet(`<form onsubmit="doUndo(event,'${lp.id}')" style="${FORM}">${head('Desfazer recebimento')}<span class="small muted">Desfaz o último recebimento desta parcela (${brl(lp.valorCents)}, recibo ${esc(lp.receiptNo || '')}). Nada é apagado: o estorno fica registrado no histórico.</span>
     <div class="field"><label>Motivo</label><input class="input" id="un-m" required minlength="3" maxlength="200" placeholder="Ex.: lançado por engano" /></div><button class="btn btn-danger btn-lg" style="justify-content:center">Desfazer recebimento</button></form>`);
  }
  if (p.aviso) return proofSheet(id);
  collectSheet(id);
};
window.doUndo = (e, payId) => { e.preventDefault(); run(async () => { await POST(`/payments/${payId}/reverse`, { reason: $('un-m').value.trim() }); closeSheet(); render(); }, 'Pagamento desfeito'); };

// ---------- clientes e equipe (folhas) ----------
window.clientSheet = (id) => run(async () => {
  const c = id ? await GET('/clients/' + id) : { nome: '', whatsapp: '', cpf: '', cidade: '', obs: '', responsavelId: me.id, portalEnabled: false, email: '', situacao: 'verificado', bloqueado: false, limiteCents: null };
  const active = staffList.filter((u) => u.status !== 'disabled');
  openSheet(`<form class="stack gap-12" onsubmit="saveClient(event,'${id || ''}')" style="${FORM}">${head(id ? 'Editar cliente' : 'Novo cliente')}
   <div class="field"><label>Nome completo</label><input class="input" id="c-nome" value="${esc(c.nome)}" required autocomplete="off" /></div>
   <div class="row2"><div class="field"><label>WhatsApp</label><input class="input" id="c-fone" inputmode="tel" placeholder="(11) 90000-0000" value="${esc(c.whatsapp)}" /></div>
   <div class="field"><label>CPF (opcional)</label><input class="input" id="c-doc" inputmode="numeric" value="${esc(c.cpf)}" /></div></div>
   <div class="field"><label>Cidade / bairro</label><input class="input" id="c-cid" value="${esc(c.cidade)}" /></div>
   ${isAdmin() ? `<div class="field"><label>Responsável</label><select class="select" id="c-resp">${active.map((u) => `<option value="${u.id}" ${u.id === c.responsavelId ? 'selected' : ''}>${esc(u.nome)}</option>`).join('')}</select></div>` : ''}
   <div><b class="small">Acesso do cliente ao portal</b><label class="switch"><span>Pode entrar e acompanhar os empréstimos</span><input type="checkbox" id="c-portal" ${c.portalEnabled ? 'checked' : ''} /></label>
   <div class="field" style="margin-top:8px"><label>E-mail (login) — o cliente recebe um convite para criar a senha</label><input class="input" id="c-email" type="email" value="${esc(c.email || '')}" ${c.email ? 'readonly' : ''} /></div>
   ${isAdmin() ? `<div class="field" style="margin-top:8px"><label>Situação do cadastro</label><select class="select" id="c-status"><option value="verificado" ${c.situacao !== 'em_verificacao' ? 'selected' : ''}>Verificado</option><option value="em_verificacao" ${c.situacao === 'em_verificacao' ? 'selected' : ''}>Em verificação</option></select></div>` : ''}</div>
   ${isAdmin() ? `<div><label class="switch"><span>Bloquear novos empréstimos</span><input type="checkbox" id="c-bloq" ${c.bloqueado ? 'checked' : ''} /></label><div class="field" style="margin-top:8px"><label>Limite por empréstimo (R$, vazio = padrão)</label><input class="input" id="c-lim" inputmode="decimal" value="${c.limiteCents ? reais(c.limiteCents) : ''}" /></div></div>` : ''}
   <div class="field"><label>Observações</label><textarea class="textarea" id="c-obs" placeholder="Ex.: trabalha de dia, paga na sexta">${esc(c.obs || '')}</textarea></div>
   <button class="btn btn-primary btn-lg" style="justify-content:center">${ico('check')} Salvar cliente</button>
   ${id && can('excluir') ? `<button type="button" class="btn btn-ghost" onclick="rmClient('${id}')">${ico('trash')} Excluir cliente</button>` : ''}
   ${id && isAdmin() ? `<button type="button" class="btn btn-ghost" onclick="anonSheet('${id}')">Dados do titular (LGPD)</button>` : ''}</form>`);
  window.__client = c; setTimeout(() => $('c-nome') && $('c-nome').focus(), 50);
});
window.saveClient = (e, id) => { e.preventDefault(); run(async () => {
  const c = window.__client, doc = $('c-doc').value.trim();
  if (doc && !cpfOk(doc)) throw new Error('CPF inválido');
  const body = { nome: $('c-nome').value.trim(), whatsapp: $('c-fone').value.trim(), cpf: doc, cidade: $('c-cid').value.trim(), obs: $('c-obs').value.trim() };
  const adminBits = isAdmin() ? { responsavelId: $('c-resp').value, situacao: $('c-status').value, bloqueado: $('c-bloq').checked, limiteCents: cents($('c-lim').value) || 0 } : {};
  let saved;
  if (id) saved = await PATCH('/clients/' + id, { ...body, ...adminBits });
  else { saved = await POST('/clients', { ...body, responsavelId: adminBits.responsavelId }); if (isAdmin() && (adminBits.situacao !== 'verificado' || adminBits.bloqueado || adminBits.limiteCents)) await PATCH('/clients/' + saved.id, { situacao: adminBits.situacao, bloqueado: adminBits.bloqueado, limiteCents: adminBits.limiteCents }); }
  const want = $('c-portal').checked, email = $('c-email').value.trim();
  let invite = null;
  if (want && !c.portalEnabled) { if (!email) throw new Error('Para liberar o portal, informe o e-mail do cliente'); invite = await POST(`/clients/${saved.id}/portal-invite`, { email }); }
  else if (!want && c.portalEnabled) await POST(`/clients/${saved.id}/portal-disable`);
  if (!id) { clientId = saved.id; tab = 'clientes'; }
  closeSheet(); await render(); toast('Cliente salvo ✓');
  if (invite) inviteSheet(invite.inviteUrl, saved.nome, saved.whatsapp, 'cliente');
}); };
window.portalInvite = (cid) => run(async () => { const c = await GET('/clients/' + cid), r = await POST(`/clients/${cid}/portal-invite`, {}); inviteSheet(r.inviteUrl, c.nome, c.whatsapp, 'cliente'); });
// o convite é de uso único e vale por 7 dias; também sai por e-mail, mas o link pode ser mandado pelo WhatsApp
window.inviteSheet = (url, nome, fone, tipo) => {
  const wa = waNum(fone), text = `Olá ${String(nome).split(' ')[0]}! Crie sua senha de acesso (o link vale por 7 dias): ${url}`;
  openSheet(`${head('Convite enviado')}<span class="small muted">Enviamos o convite por e-mail. Se preferir, mande o link abaixo ao ${tipo}. Ele vale por 7 dias e só funciona uma vez.</span>
   <input class="input" id="inv-u" readonly value="${esc(url)}" onclick="this.select()" />
   <div class="row gap-8 wrap"><button class="btn btn-light" onclick="copyText('inv-u')">Copiar link</button>${wa ? `<a class="btn btn-primary" target="_blank" rel="noopener" href="https://wa.me/${wa}?text=${encodeURIComponent(text)}">${ico('wa')} Enviar por WhatsApp</a>` : ''}</div>`);
};
window.copyText = async (elId) => { const el = $(elId); try { await navigator.clipboard.writeText(el.value); toast('Copiado ✓'); } catch { el.select(); toast('Selecione e copie'); } };
window.rmClient = (id) => { if (!confirm('Excluir este cliente? O histórico financeiro é mantido.')) return; run(async () => { await DEL('/clients/' + id); clientId = null; closeSheet(); render(); }, 'Cliente excluído'); };

window.userSheet = (id) => run(async () => {
  const list = await GET('/staff'); staffList = list;
  const u = id ? list.find((x) => x.id === id) : { nome: '', email: '', role: 'staff', comissaoBps: 0, perms: { criar: true, clientes: true, excluir: false, lucro: false, todos: false }, status: 'active' };
  window.__user = u;
  openSheet(`<form onsubmit="saveUser(event,'${id || ''}')" style="${FORM}">${head(id ? 'Editar funcionário' : 'Novo funcionário')}
   <div class="field"><label>Nome</label><input class="input" id="u-nome" value="${esc(u.nome)}" required /></div>
   <div class="field"><label>E-mail (login) — a pessoa recebe um convite para criar a senha</label><input class="input" id="u-email" type="email" value="${esc(u.email)}" required ${id ? 'readonly' : ''} /></div>
   <div class="row2"><div class="field"><label>Função</label><select class="select" id="u-role"><option value="staff" ${u.role === 'staff' ? 'selected' : ''}>Funcionário</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrador</option></select></div>
   <div class="field"><label>Comissão (%)</label><input class="input" id="u-com" inputmode="decimal" value="${pctOf(u.comissaoBps)}" /></div></div>
   <div><b class="small">Permissões (funcionário)</b>${Object.entries(PERMS).map(([k, t]) => `<label class="switch"><span>${t}</span><input type="checkbox" id="p-${k}" ${u.perms[k] ? 'checked' : ''} /></label>`).join('')}
   ${id ? `<label class="switch"><span>Acesso ativo</span><input type="checkbox" id="u-ativo" ${u.status !== 'disabled' ? 'checked' : ''} /></label>` : ''}</div>
   <button class="btn btn-primary btn-lg" style="justify-content:center">${ico('check')} Salvar</button>
   ${id && u.status === 'invited' ? `<button type="button" class="btn btn-light" onclick="reinvite('${id}')">Reenviar convite</button>` : ''}</form>`);
});
window.saveUser = (e, id) => { e.preventDefault(); run(async () => {
  const u = window.__user, perms = Object.fromEntries(Object.keys(PERMS).map((k) => [k, $('p-' + k).checked]));
  const base = { nome: $('u-nome').value.trim(), role: $('u-role').value, comissaoBps: bpsOf($('u-com').value), perms };
  if (id) {
    const body = { ...base }; const ativo = $('u-ativo').checked;
    if (!ativo && u.status !== 'disabled') { if (!confirm('Desativar este acesso? Os clientes dele passam para você.')) return; body.status = 'disabled'; }
    if (ativo && u.status === 'disabled') body.status = 'active';
    await PATCH('/staff/' + id, body); closeSheet(); render(); toast('Equipe atualizada ✓');
  } else {
    const r = await POST('/staff', { ...base, email: $('u-email').value.trim() }); closeSheet(); render(); inviteSheet(r.inviteUrl, base.nome, '', 'novo funcionário');
  }
  await loadStaff();
}); };
window.reinvite = (id) => run(async () => { const u = window.__user, r = await POST(`/staff/${id}/invite`); inviteSheet(r.inviteUrl, u.nome, '', 'funcionário'); });

// novo empréstimo
const cLabel = (c, all) => { const dup = all.filter((x) => x.nome.toLowerCase() === c.nome.toLowerCase()).length > 1; return dup ? `${c.nome} · ${(c.whatsapp || '').replace(/\D/g, '').slice(-4) || c.id.slice(0, 4)}` : c.nome; };
window.openNew = (cid) => run(async () => {
  const cs = await GET('/clients'); window.__cs = cs;
  const pre = cid ? cs.find((c) => c.id === cid) : null;
  openSheet(`<form onsubmit="saveLoan(event)" style="${FORM}">${head('Novo empréstimo')}
   <div class="field"><label>Cliente</label><input class="input" id="nome" list="cl" autocomplete="off" placeholder="Digite o nome ou cadastre um novo" value="${pre ? esc(cLabel(pre, cs)) : ''}" required />
    <datalist id="cl">${cs.map((c) => `<option value="${esc(cLabel(c, cs))}">`).join('')}</datalist></div>
   <div class="field" id="newcl" style="display:none"><label>WhatsApp do novo cliente</label><input class="input" id="nfone" inputmode="tel" placeholder="(11) 90000-0000" /></div>
   <div class="row2"><div class="field"><label>Valor emprestado</label><input class="input" id="valor" inputmode="decimal" placeholder="R$ 0,00" required /></div>
   <div class="field"><label>Juros total (%)</label><input class="input" id="taxa" inputmode="decimal" placeholder="20" value="${pctOf((cfg().taxasBps || {})[freq] ?? 2000)}" required /></div></div>
   <div class="field"><label>Frequência de pagamento</label><div class="chips" id="freq">${[[1, 'Diário'], [7, 'Semanal'], [15, 'Quinzenal'], [30, 'Mensal']].map(([f, t]) => `<button type="button" class="chip ${f === freq ? 'on' : ''}" data-f="${f}">${t}</button>`).join('')}</div></div>
   <div class="row2"><div class="field"><label>Parcelas</label><div class="step"><button type="button" data-s="-1">−</button><input id="n" type="number" min="1" value="4" /><button type="button" data-s="1">+</button></div></div>
   <div class="field"><label>1º vencimento</label><input class="input" id="ini" type="date" required value="${addDaysISO(hoje, 1)}" /></div></div>
   <label class="row gap-8 small" id="domRow" style="display:${freq === 1 ? 'flex' : 'none'}"><input type="checkbox" id="pulaDom" checked /> Pular domingos</label>
   <label class="row gap-8 small"><input type="checkbox" id="cashout" /> Entreguei o valor em dinheiro agora (lança saída no caixa)</label>
   <div class="sum" id="prev"></div>
   <button class="btn btn-primary btn-lg" style="justify-content:center">${ico('check')} Salvar empréstimo</button></form>`);
  $('freq').onclick = (e) => { const b = e.target.closest('[data-f]'); if (!b) return; freq = +b.dataset.f; document.querySelectorAll('#freq .chip').forEach((c) => c.classList.toggle('on', c === b)); $('domRow').style.display = freq === 1 ? 'flex' : 'none'; $('taxa').value = pctOf((cfg().taxasBps || {})[freq] ?? 2000); prev(); };
  document.querySelectorAll('#sheet [data-s]').forEach((b) => (b.onclick = () => { $('n').value = Math.max(1, (+$('n').value || 1) + +b.dataset.s); prev(); }));
  ['valor', 'taxa', 'n', 'ini', 'pulaDom'].forEach((i) => $(i).addEventListener('input', prev));
  $('nome').addEventListener('input', () => { $('newcl').style.display = $('nome').value.trim() && !cs.some((c) => cLabel(c, cs).toLowerCase() === $('nome').value.trim().toLowerCase()) ? 'block' : 'none'; });
  prev(); setTimeout(() => $(pre ? 'valor' : 'nome').focus(), 50);
});
const prev = () => previewInto('prev', { valorCents: cents($('valor').value), jurosBps: bpsOf($('taxa').value), freqDays: freq, nParcelas: Math.max(1, +$('n').value || 1), firstDue: $('ini').value, pulaDomingo: $('pulaDom').checked && freq === 1 });
window.saveLoan = (e) => { e.preventDefault(); run(async () => {
  const cs = window.__cs, nome = $('nome').value.trim();
  let c = cs.find((x) => cLabel(x, cs).toLowerCase() === nome.toLowerCase());
  if (!c) { const same = cs.filter((x) => x.nome.toLowerCase() === nome.toLowerCase()); if (same.length > 1) throw new Error('Há clientes com esse nome: escolha na lista (com os 4 últimos dígitos do telefone)'); }
  const v = cents($('valor').value), t = bpsOf($('taxa').value);
  if (!(v > 0) || t < 0 || !$('ini').value) throw new Error('Confira valor, juros e vencimento');
  if (!c) { if (!can('clientes')) throw new Error('Você não tem permissão para cadastrar clientes'); c = await POST('/clients', { nome, whatsapp: $('nfone').value.trim() }); }
  await POST('/loans', { clientId: c.id, valorCents: v, jurosBps: t, freqDays: freq, nParcelas: Math.max(1, +$('n').value || 1), firstDue: $('ini').value, pulaDomingo: freq === 1 && $('pulaDom').checked, entrega: $('cashout').checked ? 'dinheiro' : 'nenhuma' });
  closeSheet(); go('agenda');
}, 'Empréstimo criado ✓'); };

// ---------- shell ----------
const TABS = { home, agenda, clientes, solic, caixa: (...a) => caixa(...a), relat, equipe, atividade, config };
function shell() {
  $('root').innerHTML = `<header class="top"><div class="in"><div class="logo">${ico('coin')}</div>
    <label class="search">${ico('search')}<input id="q" placeholder="Buscar cliente" value="${esc(term)}" /><span class="kbd">/</span></label>
    <button class="ib" id="theme" aria-label="Tema">${ico('moon')}</button></div></header>
    <main class="app" id="view"></main>
    <nav class="nav"><div class="in">
      <div class="brand"><div class="logo">${ico('coin')}</div><span>${esc(cfg().empresa || 'Caixa')}</span></div>
      <button data-t="home">${ico('home')}Início</button>
      <button data-t="agenda">${ico('cal')}Agenda</button>
      <button class="fab" id="fab" aria-label="Novo empréstimo">${ico('plus')}<span class="t">Novo empréstimo</span></button>
      <button data-t="clientes">${ico('users')}Clientes</button>
      <button class="side-only" data-t="solic">${ico('clock')}Solicitações <span id="bd-solic"></span></button>
      <button class="side-only" data-t="caixa">${ico('wallet')}Caixa</button>
      ${can('lucro') ? `<button class="side-only" data-t="relat">${ico('chart')}Resumo</button>` : ''}
      ${isAdmin() ? `<button class="side-only" data-t="equipe">${ico('team')}Equipe</button><button class="side-only" data-t="atividade">${ico('clock')}Atividade</button><button class="side-only" data-t="config">${ico('gear')}Ajustes</button>` : ''}
      <button class="mobile-only" id="more">${ico('more')}Mais</button>
      <div class="spacer"></div>
      <button class="side-only" id="out">${ico('out')}Sair (${esc(me.nome.split(' ')[0])})</button>
    </div></nav>`;
  document.querySelectorAll('.nav [data-t]').forEach((b) => (b.onclick = () => go(b.dataset.t)));
  $('fab').onclick = () => (can('criar') ? openNew() : toast('Você não tem permissão para criar empréstimos'));
  $('more').onclick = moreSheet; $('out').onclick = logout;
  let qt = 0;
  $('q').oninput = (e) => { term = e.target.value.toLowerCase(); if (!['agenda', 'clientes'].includes(tab)) tab = 'clientes'; clearTimeout(qt); qt = setTimeout(render, 250); };
  $('theme').onclick = toggleTheme;
  render();
}
function paintBadges() { const n = inbox.solicitacoes + inbox.quitacoes, el = $('bd-solic'); if (el) el.innerHTML = n ? `<span class="tag t-adm">${n}</span>` : ''; }
async function render() {
  if (!me) return loginView();
  if (me.kind === 'client') return portalRender();
  if (!$('view')) return shell();
  const seq = ++renderSeq;
  if (!$('view').innerHTML) $('view').innerHTML = '<div class="empty2">Carregando…</div>';
  let html;
  try { html = await TABS[tab](); }
  catch (e) { if (e instanceof ApiError && e.status === 401) return; html = `<div class="empty2">${esc(e.message)}<br><br><button class="btn btn-light btn-sm" onclick="render()">Tentar de novo</button></div>`; }
  if (seq !== renderSeq || !$('view')) return;
  $('view').innerHTML = html;
  document.querySelectorAll('.nav [data-t]').forEach((b) => b.classList.toggle('on', b.dataset.t === tab));
  $('more').classList.toggle('on', ['solic', 'caixa', 'relat', 'equipe', 'atividade', 'config'].includes(tab));
  const q = $('q'); if (q && q.value !== term) q.value = term;
}
window.go = (t, f) => { tab = t; if (f) filt = f; else if (t === 'agenda') filt = 'todos'; clientId = null; term = ''; closeSheet(); $('view') && ($('view').innerHTML = ''); render(); scrollTo(0, 0); };
window.render = render;

function moreSheet() {
  const it = (i, l, fn) => `<button class="menu-i" onclick="${fn}"><span class="c">${ico(i)}</span>${l}</button>`;
  const n = inbox.solicitacoes + inbox.quitacoes;
  openSheet(`${head('Mais')}
   <div class="row gap-12" style="padding:4px 0"><div class="av" style="background:${color(me.nome)}">${esc(ini(me.nome))}</div><div><b>${esc(me.nome)}</b><div class="small muted">${esc(me.email)} · ${isAdmin() ? 'Administrador' : 'Funcionário'}</div></div></div>
   ${it('clock', 'Solicitações' + (n ? ' (' + n + ')' : ''), "go('solic')")}
   ${it('wallet', 'Caixa', "go('caixa')")}
   ${can('lucro') ? it('chart', 'Resumo', "go('relat')") : ''}
   ${isAdmin() ? it('team', 'Equipe', "go('equipe')") + it('clock', 'Atividade', "go('atividade')") + it('gear', 'Ajustes', "go('config')") : ''}
   ${it('gear', 'Alterar minha senha', 'passSheet()')}
   ${installEv ? it('dl', 'Instalar app no celular', 'installApp()') : ''}
   ${it('moon', 'Tema claro / escuro', 'toggleTheme();closeSheet()')}
   ${it('out', 'Sair', 'logout()')}`);
}

// ---------- tema, atalhos, PWA ----------
function toggleTheme() { const d = document.documentElement, k = d.dataset.theme === 'dark' ? 'light' : 'dark'; d.dataset.theme = k; try { localStorage.setItem('caixa-theme', k); } catch {} }
window.toggleTheme = toggleTheme;
try { const t = localStorage.getItem('caixa-theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
addEventListener('keydown', (e) => {
  if (!me) return; if (e.key === 'Escape') return closeSheet();
  if (me.kind !== 'staff') return; const t = e.target.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t)) { if (e.key === 'Escape') closeSheet(); return; }
  if (e.key === 'n' && can('criar')) openNew(); else if (e.key === '/') { e.preventDefault(); $('q') && $('q').focus(); } else if (e.key === 'Escape') closeSheet();
  else if ('1234'.includes(e.key)) go(['home', 'agenda', 'clientes', 'relat'][+e.key - 1]);
});
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEv = e; });
window.installApp = async () => { if (installEv) { installEv.prompt(); installEv = null; closeSheet(); } };

// documentos do cliente (visão da equipe)
function docsStaff(c) {
  return `<div class="card card-pad stack gap-8" style="margin-bottom:12px"><b>Documentos</b>${c.documentos.map((x) => { const t = DOCS[x.tipo];
    return `<div class="row between gap-8"><span class="small">${t}</span>${x.status !== 'pendente' ? `<span class="row gap-8"><img src="${API}/files/${x.fileId}" alt="${t}" style="width:44px;height:44px;object-fit:cover;border-radius:8px;cursor:zoom-in" onclick="docView('${c.id}','${x.tipo}')"><span class="tag ${x.status === 'aprovado' ? 't-ok' : x.status === 'recusado' ? 't-late' : 't-today'}">${x.status === 'aprovado' ? 'Aprovado' : x.status === 'recusado' ? 'Recusado' : 'Enviado'}</span></span>` : '<span class="tag t-off">Pendente</span>'}</div>`; }).join('')}</div>`;
}
window.docView = (cid, k) => run(async () => {
  const docs = await GET(`/clients/${cid}/documents`), x = docs.find((y) => y.tipo === k); if (!x || !x.fileId) return;
  openSheet(`${head(DOCS[k])}<span class="small muted">Enviado em ${fdi(x.createdAt)}${x.motivo ? ' · recusado: ' + esc(x.motivo) : ''}</span><img src="${API}/files/${x.fileId}" alt="${DOCS[k]}" style="width:100%;max-height:55vh;object-fit:contain;border-radius:12px;background:var(--soft)">
   <div class="row gap-8"><button class="btn btn-primary" onclick="docSet('${cid}','${x.id}','aprovado')">Aprovar</button><button class="btn btn-light" onclick="docSet('${cid}','${x.id}','recusado')">Recusar</button></div><input class="input" id="dm" placeholder="Motivo (se recusar)" />`);
});
window.docSet = (cid, did, st) => run(async () => { await PATCH(`/clients/${cid}/documents/${did}`, { status: st, motivo: st === 'recusado' ? ($('dm').value.trim() || 'Imagem ilegível') : undefined }); closeSheet(); render(); }, st === 'aprovado' ? 'Documento aprovado ✓' : 'Documento recusado');
