// Portal do cliente: o servidor só devolve ao cliente os dados DELE (isolamento verificado por testes automatizados).
const ST = { analise: ['Em análise', 't-today'], aprovada: ['Aprovada', 't-ok'], recusada: ['Recusada', 't-late'] };
let ptab = 'home', pdata = null;

async function loadPortal() {
  const [loans, reqs] = await Promise.all([GET('/me/loans'), GET('/me/requests')]);
  const live = loans.filter((l) => l.status === 'ativo' || l.status === 'quitado');
  pdata = { loans, live, reqs, parcels: live.flatMap((l) => l.installments.map((i) => ({ ...i, loan: l }))) };
  return pdata;
}
const lastPayC = (p) => (p.pagamentos || []).filter((x) => x.kind !== 'estorno' && x.method !== 'desconto' && !x.estornado).at(-1);

function prow(p) {
  const paid = p.status === 'paid', rep = p.relato && p.relato.status === 'pendente', rej = p.relato && p.relato.status === 'recusado' && !paid, lp = lastPayC(p);
  return `<div class="item"><div class="av" style="background:${p.status === 'late' ? 'var(--danger)' : paid ? 'var(--teal)' : 'var(--ink)'};width:44px;height:44px">${paid ? ico('check') : p.numero}</div>
  <div class="grow"><b>Parcela ${p.numero}/${p.nTotal} · ${fd(p.dueDate)}</b>
   <span class="small muted">${paid ? `Paga${lp ? ` em ${fd(lp.data)} · ${lp.method === 'dinheiro' ? 'dinheiro' : 'Pix'}` : ''}` : p.status === 'late' ? `<span class="tag t-late">Atrasada ${p.days}d</span>` : p.status === 'today' ? '<span class="tag t-today">Vence hoje</span>' : 'A vencer'}${rep && !paid ? ` <span class="tag t-today">${p.relato.method === 'dinheiro' ? 'Dinheiro combinado · aguardando a equipe' : 'Comprovante em conferência'}</span>` : ''}</span>
   ${rej && p.relato.motivoRecusa ? `<span class="xs" style="color:var(--danger)">Comprovante recusado: ${esc(p.relato.motivoRecusa)}</span>` : ''}
   ${p.partial && !paid ? `<span class="xs" style="color:var(--teal)">Você já pagou ${brl(p.paidCents)} · falta ${brl(p.balanceCents)}</span>` : ''}${p.extraCents && !paid ? `<span class="xs" style="color:var(--danger)">inclui ${brl(p.extraCents)} de multa e mora</span>` : ''}</div>
  <div class="amt">${brl(paid ? p.recebidoCents : p.balanceCents)}</div>
  ${!paid && !rep && p.loan.status === 'ativo' ? `<button class="btn btn-primary btn-sm" onclick="paySheet('${p.id}')">Pagar</button>` : ''}${paid && lp ? `<button class="btn btn-light btn-sm" onclick="receiptSheet('${lp.id}')">Recibo</button>` : ''}</div>`;
}

async function pHome() {
  const { live, reqs, parcels } = await loadPortal(); hoje = todaySP();
  const open = parcels.filter((p) => p.status !== 'paid' && p.loan.status === 'ativo').sort((a, b) => a.dueDate.localeCompare(b.dueDate)), late = open.filter((p) => p.status === 'late');
  const next = open[0], pend = reqs.filter((r) => r.status === 'analise').length, propostas = reqs.filter((r) => r.proposta && r.proposta.status === 'proposta').length;
  const aberto = open.reduce((a, p) => a + p.balanceCents, 0), pago = parcels.reduce((a, p) => a + p.recebidoCents, 0);
  return `<h1 class="hello display">${greet()}, ${esc(me.nome.split(' ')[0])} 👋</h1><span class="muted small">${late.length ? `<b style="color:var(--danger)">${late.length} parcela(s) em atraso</b>` : 'Seus pagamentos estão em dia'}</span>
  <div class="hero"><small>${next ? (next.status === 'late' ? 'Parcela em atraso' : 'Próximo vencimento') : 'Situação'}</small><div class="big">${next ? brl(next.balanceCents) : 'Tudo pago'}</div>
   <small style="position:relative;z-index:1">${next ? fdl(next.dueDate) : 'Você não tem parcelas em aberto.'}</small>
   <div class="pills"><div class="pill"><b>${brl(aberto)}</b><span>Em aberto</span></div><div class="pill"><b>${brl(pago)}</b><span>Já pago</span></div><div class="pill"><b>${live.length}</b><span>Empréstimos</span></div></div></div>
  <div class="qa">
   <button onclick="reqSheet()"><span class="c" style="background:var(--accent-soft);color:var(--accent)">${ico('plus')}</span>Solicitar</button>
   <button onclick="${next ? `paySheet('${next.id}')` : "toast('Nada para pagar agora')"}"><span class="c" style="background:var(--teal-soft);color:var(--teal)">${ico('coin')}</span>Pagar</button>
   <button onclick="pgo('emprest')"><span class="c" style="background:var(--warn-bg);color:var(--warn-fg)">${ico('cal')}</span>Parcelas</button>
   <button onclick="contato()"><span class="c" style="background:var(--teal-soft);color:var(--teal)">${ico('wa')}</span>Ajuda</button></div>
  ${propostas ? `<div class="notice notice-teal" style="margin-bottom:12px;cursor:pointer" onclick="pgo('solic')">${ico('check')}<span class="small"><b>Você tem uma proposta pronta.</b> Toque para ler o contrato e aceitar.</span></div>` : ''}
  ${pend ? `<div class="notice notice-teal" style="margin-bottom:12px">${ico('clock')}<span class="small">Você tem ${pend} solicitação(ões) em análise.</span></div>` : ''}
  ${me.situacao === 'em_verificacao' ? `<div class="notice notice-warn" style="margin-bottom:12px">${ico('alert')}<span class="small">Seu cadastro está em verificação. Você já pode enviar solicitações, mas a análise pode demorar mais. <a class="bold" href="#" onclick="docsSheet();return false">Enviar documentos</a></span></div>` : ''}
  <div class="sec"><h2>Próximas parcelas</h2></div>${open.slice(0, 4).map(prow).join('') || '<div class="empty2">Nenhuma parcela em aberto. Precisa de um novo valor? Toque em <b>Solicitar</b>.</div>'}`;
}
async function pEmprest() {
  const { live } = await loadPortal();
  return `<h1 class="hello display">Meus empréstimos</h1>${live.map((l) => { const done = l.pagas === l.nParcelas;
    return `<div class="card card-pad stack gap-8" style="margin:12px 0 8px"><div class="row between"><b>${brl(l.valorCents)} · ${FL[l.freqDays]}</b><span class="tag ${done ? 't-ok' : 't-today'}">${done ? 'Quitado' : l.quitacaoPendente ? 'Quitação em análise' : 'Em andamento'}</span></div>
   <span class="small muted">Contratado em ${fdi(l.acceptedAt || l.createdAt)} · total ${brl(l.totalCents)} · ${l.pagas}/${l.nParcelas} parcelas pagas</span><div class="bar"><i style="width:${(l.pagas / l.nParcelas) * 100}%"></i></div>
   <div class="row gap-8 wrap">${!done && !l.quitacaoPendente && l.status === 'ativo' ? `<button class="btn btn-light btn-sm" onclick="quitReqSheet('${l.id}')">Quitar antecipado</button>` : ''}<button class="btn btn-ghost btn-sm" onclick="viewContract('${l.id}')">Ver contrato</button></div></div>${l.installments.map((i) => prow({ ...i, loan: l })).join('')}`; }).join('') || '<div class="empty2">Você ainda não tem empréstimos. Toque em <b>+</b> para solicitar.</div>'}`;
}
async function pSolic() {
  const { reqs } = await loadPortal();
  return `<div class="row between" style="align-items:center"><h1 class="hello display">Solicitações</h1><button class="btn btn-primary btn-sm" onclick="reqSheet()">${ico('plus')} Nova</button></div>
  ${reqs.map((r) => `<div class="card card-pad stack gap-8" style="margin-top:12px"><div class="row between"><b>${brl(r.valorCents)} em ${r.nParcelas}x ${FL[r.freqDays]}</b><span class="tag ${ST[r.status][1]}">${ST[r.status][0]}</span></div>
   <span class="small muted">Enviada em ${fdi(r.createdAt)}${r.motivo ? ' · ' + esc(r.motivo) : ''}</span>
   ${r.status === 'recusada' && r.motivoRecusa ? `<div class="tile small">Motivo: ${esc(r.motivoRecusa)}</div>` : ''}
   ${r.status === 'aprovada' && r.proposta ? (r.proposta.status === 'proposta' ? `<div class="tile small"><b>Proposta pronta:</b> ${brl(r.proposta.valorCents)} · ${r.proposta.nParcelas}x de ${brl(r.proposta.parcelaCents)} · total ${brl(r.proposta.totalCents)}</div><button class="btn btn-primary btn-sm" style="align-self:flex-start" onclick="acceptSheet('${r.proposta.loanId}')">Ver contrato e aceitar</button>` : '<div class="tile small">Aceita! Veja as parcelas em <b>Parcelas</b>.</div>') : ''}</div>`).join('') || '<div class="empty2">Nenhuma solicitação ainda.</div>'}`;
}
async function pConta() {
  return `<h1 class="hello display">Minha conta</h1><div class="card card-pad stack gap-12" style="margin-top:12px">
   <div class="row gap-12"><div class="av" style="background:${color(me.nome)}">${esc(ini(me.nome))}</div><div><b>${esc(me.nome)}</b><div class="small muted">${esc(me.email || '')}</div></div></div>
   <div class="small muted">WhatsApp: ${esc(me.whatsapp || '—')}${me.cidade ? ' · ' + esc(me.cidade) : ''}</div>
   <div class="row gap-8 wrap"><button class="btn btn-light btn-sm" onclick="docsSheet()">Meus documentos</button><button class="btn btn-light btn-sm" onclick="avisosOn()">Ativar avisos</button><button class="btn btn-light btn-sm" onclick="passSheet()">Alterar senha</button><button class="btn btn-light btn-sm" onclick="twoFaSheet()">${me.totpEnabled ? 'Gerenciar 2FA' : 'Ativar 2FA'}</button><button class="btn btn-light btn-sm" onclick="toggleTheme()">Tema claro/escuro</button><button class="btn btn-ghost btn-sm" onclick="logout()">${ico('out')} Sair</button></div></div>
  <div class="card card-pad stack gap-8" style="margin-top:16px"><b>Seus dados (LGPD)</b><span class="small muted">Você pode baixar uma cópia dos seus dados ou pedir a exclusão. Registros financeiros podem ser mantidos pelo prazo legal.</span><div class="row gap-8 wrap"><button class="btn btn-light btn-sm" onclick="exportMine()">Baixar meus dados</button><button class="btn btn-light btn-sm" onclick="eraseMine()">Pedir exclusão dos dados</button><a class="btn btn-ghost btn-sm" href="privacidade.html" target="_blank" rel="noopener">Política de privacidade</a></div></div>
  <div class="notice notice-teal" style="margin-top:16px;display:block"><span class="small">Os dados de pagamento e contato são da <b>${esc(cfg().empresa)}</b>. Em caso de dúvida, fale com a equipe pelo WhatsApp.</span></div>`;
}
window.exportMine = () => run(() => download('/me/privacy/export', 'meus-dados.json'));
window.eraseMine = () => { if (!confirm('Pedir a exclusão dos seus dados? A empresa vai analisar o pedido.')) return; run(() => POST('/me/privacy/erase-request'), 'Pedido enviado ✓'); };
const PT = { home: pHome, emprest: pEmprest, solic: pSolic, conta: pConta };
window.pgo = (t) => { ptab = t; closeSheet(); if ($('view')) $('view').innerHTML = ''; portalRender(); scrollTo(0, 0); };
window.contato = () => { const f = waNum(cfg().whatsapp); if (!f) return toast('A empresa ainda não cadastrou o WhatsApp'); open(`https://wa.me/${f}?text=${encodeURIComponent('Olá, sou ' + me.nome + ' e preciso de ajuda.')}`, '_blank'); };

async function portalRender() {
  if (!$('view')) {
    $('root').innerHTML = `<header class="top"><div class="in"><div class="logo">${ico('coin')}</div><b class="display" style="font-size:20px;flex:1">${esc(cfg().empresa)}</b><button class="ib" id="theme" aria-label="Tema">${ico('moon')}</button></div></header>
    <main class="app" id="view"></main>
    <nav class="nav"><div class="in"><div class="brand"><div class="logo">${ico('coin')}</div><span>${esc(cfg().empresa)}</span></div>
     <button data-t="home">${ico('home')}Início</button><button data-t="emprest">${ico('cal')}Parcelas</button>
     <button class="fab" id="fab" aria-label="Solicitar empréstimo">${ico('plus')}<span class="t">Solicitar empréstimo</span></button>
     <button data-t="solic">${ico('clock')}Solicitações</button><button data-t="conta">${ico('user')}Conta</button>
     <div class="spacer"></div><button class="side-only" id="out">${ico('out')}Sair</button></div></nav>`;
    document.querySelectorAll('.nav [data-t]').forEach((b) => (b.onclick = () => pgo(b.dataset.t)));
    $('fab').onclick = () => reqSheet(); $('out').onclick = logout; $('theme').onclick = toggleTheme;
  }
  const seq = ++renderSeq;
  if (!$('view').innerHTML) $('view').innerHTML = '<div class="empty2">Carregando…</div>';
  let html;
  try { html = await PT[ptab](); } catch (e) { if (e instanceof ApiError && e.status === 401) return; html = `<div class="empty2">${esc(e.message)}<br><br><button class="btn btn-light btn-sm" onclick="portalRender()">Tentar de novo</button></div>`; }
  if (seq !== renderSeq || !$('view')) return;
  $('view').innerHTML = html;
  document.querySelectorAll('.nav [data-t]').forEach((b) => b.classList.toggle('on', b.dataset.t === ptab));
}
window.portalRender = portalRender;

// ----- pagar por Pix + comprovante -----
let pmethod = 'pix';
window.paySheet = (instId) => {
  const p = pdata && pdata.parcels.find((x) => x.id === instId); if (!p) return;
  const c = cfg(); if (!c.aceitaPix && c.aceitaDinheiro) pmethod = 'dinheiro'; else if (!c.aceitaDinheiro) pmethod = 'pix';
  const both = c.aceitaPix && c.aceitaDinheiro;
  const pix = `${c.pixKey ? `<div class="field"><label>1. Pague por Pix para ${esc(c.pixNome || c.empresa)}</label><div class="row gap-8"><input class="input" id="pixk" readonly value="${esc(c.pixKey)}" /><button type="button" class="btn btn-light" onclick="copyPix()">Copiar</button></div></div>` : '<div class="notice notice-warn">A empresa ainda não cadastrou a chave Pix. Fale com a equipe.</div>'}
   <div class="field"><label>2. Envie o comprovante</label><input class="input" id="proof" type="file" accept="image/*,application/pdf" /></div>
   <span class="xs muted">A equipe confere o comprovante e confirma o pagamento. Você acompanha o status aqui.</span>
   <button class="btn btn-primary btn-lg" style="justify-content:center" onclick="sendProof('${instId}')">${ico('check')} Já paguei, enviar comprovante</button>`;
  const cash = `<div class="field"><label>Quando e onde você vai entregar? (opcional)</label><input class="input" id="cnote" maxlength="140" placeholder="Ex.: sexta, 10h, no balcão" /></div>
   <span class="xs muted">Combine a entrega com a equipe. O pagamento só é baixado quando a equipe confirmar que recebeu o dinheiro. Peça sempre o recibo.</span>
   <button class="btn btn-primary btn-lg" style="justify-content:center" onclick="sendCash('${instId}')">${ico('check')} Vou pagar em dinheiro</button>`;
  openSheet(`${head('Pagar parcela')}
   <div class="sum"><span class="small">Parcela ${p.numero}/${p.nTotal} · vence ${fd(p.dueDate)}</span><br><b>${brl(p.balanceCents)}</b>${p.extraCents ? `<br><span class="small">inclui ${brl(p.extraCents)} de multa e mora</span>` : ''}</div>
   ${both ? `<div class="field"><label>Como você vai pagar?</label><div class="chips" id="pm">${[['pix', 'Pix'], ['dinheiro', 'Dinheiro']].map(([k, t]) => `<button type="button" class="chip ${pmethod === k ? 'on' : ''}" data-m="${k}">${t}</button>`).join('')}</div></div>` : ''}
   <div id="pbody" style="display:flex;flex-direction:column;gap:12px">${pmethod === 'pix' ? pix : cash}</div>`);
  if (both) $('pm').onclick = (e) => { const b = e.target.closest('[data-m]'); if (!b) return; pmethod = b.dataset.m; document.querySelectorAll('#pm .chip').forEach((x) => x.classList.toggle('on', x === b)); $('pbody').innerHTML = pmethod === 'pix' ? pix : cash; };
};
window.sendCash = (instId) => run(async () => { await POST(`/me/installments/${instId}/report${qs({ method: 'dinheiro', note: $('cnote').value.trim() })}`); closeSheet(); portalRender(); }, 'Aviso enviado à equipe ✓');
window.copyPix = () => copyText('pixk');
window.sendProof = (instId) => run(async () => {
  const f = $('proof').files[0]; if (!f) throw new Error('Anexe a foto do comprovante');
  await sendFile(`/me/installments/${instId}/report?method=pix`, f); closeSheet(); portalRender();
}, 'Comprovante enviado ✓');

// ----- solicitar empréstimo -----
const lim = () => { const c = cfg(); return { min: c.minValorCents, max: Math.min(c.maxValorCents, me.limiteCents || Infinity), maxN: c.maxParcelas }; };
let rfreq = 7;
window.reqSheet = () => {
  if (me.bloqueado) return toast('Novos empréstimos indisponíveis para o seu cadastro. Fale com a equipe.');
  const L = lim();
  openSheet(`<form onsubmit="sendReq(event)" style="${FORM}">${head('Solicitar empréstimo')}
   <div class="field"><label>Quanto você precisa? (${brl(L.min)} a ${brl(L.max)})</label><input class="input" id="r-v" inputmode="decimal" placeholder="R$ 0,00" required /></div>
   <div class="field"><label>Como prefere pagar?</label><div class="chips" id="r-f">${[[1, 'Diário'], [7, 'Semanal'], [15, 'Quinzenal'], [30, 'Mensal']].map(([f, t]) => `<button type="button" class="chip ${f === rfreq ? 'on' : ''}" data-f="${f}">${t}</button>`).join('')}</div></div>
   <div class="field"><label>Número de parcelas (até ${L.maxN})</label><div class="step"><button type="button" data-s="-1">−</button><input id="r-n" type="number" min="1" max="${L.maxN}" value="4" /><button type="button" data-s="1">+</button></div></div>
   <div class="field"><label>Para que vai usar? (opcional)</label><input class="input" id="r-m" maxlength="120" placeholder="Ex.: capital de giro, reforma" /></div>
   <div class="sum" id="r-prev"></div>
   <span class="xs muted">Valores estimados. A taxa final é definida na análise e você só assume o compromisso se aceitar a proposta aprovada.</span>
   <button class="btn btn-primary btn-lg" style="justify-content:center">${ico('check')} Enviar solicitação</button></form>`);
  $('r-f').onclick = (e) => { const b = e.target.closest('[data-f]'); if (!b) return; rfreq = +b.dataset.f; document.querySelectorAll('#r-f .chip').forEach((c) => c.classList.toggle('on', c === b)); rprev(); };
  document.querySelectorAll('#sheet [data-s]').forEach((b) => (b.onclick = () => { $('r-n').value = Math.min(L.maxN, Math.max(1, (+$('r-n').value || 1) + +b.dataset.s)); rprev(); }));
  ['r-v', 'r-n'].forEach((i) => $(i).addEventListener('input', rprev)); rprev();
};
function rprev() {
  const v = cents($('r-v').value), n = Math.min(lim().maxN, Math.max(1, +$('r-n').value || 1)), bps = (cfg().taxasBps || {})[rfreq] ?? 2000;
  if (!v) { $('r-prev').textContent = 'Informe o valor para ver uma estimativa.'; return; }
  const tot = v + Math.round((v * bps) / 10000);
  $('r-prev').innerHTML = `Estimativa: <b>${n}x de ${brl(Math.floor(tot / n))}</b><br>Total a pagar ${brl(tot)} (juros ${pctOf(bps)}%)`;
}
window.sendReq = (e) => { e.preventDefault(); run(async () => {
  const L = lim(), v = cents($('r-v').value), n = Math.min(L.maxN, Math.max(1, +$('r-n').value || 1));
  if (v < L.min || v > L.max) throw new Error(`O valor deve ficar entre ${brl(L.min)} e ${brl(L.max)}`);
  await POST('/me/requests', { valorCents: v, nParcelas: n, freqDays: rfreq, motivo: $('r-m').value.trim() }); closeSheet(); pgo('solic');
}, 'Solicitação enviada ✓'); };
window.passSheet = () => openSheet(`<form onsubmit="savePass(event)" style="${FORM}">${head('Alterar senha')}
   <div class="field"><label>Senha atual</label><input class="input" id="pw0" type="password" autocomplete="current-password" required /></div>
   <div class="field"><label>Nova senha (mín. 8)</label><input class="input" id="pw1" type="password" minlength="8" autocomplete="new-password" required /></div>
   <button class="btn btn-primary btn-lg" style="justify-content:center">Salvar</button></form>`);
window.savePass = (e) => { e.preventDefault(); run(async () => { await POST('/me/password', { current: $('pw0').value, next: $('pw1').value }); closeSheet(); }, 'Senha alterada ✓'); };

window.quitReqSheet = (loanId) => run(async () => {
  const q = await GET(`/loans/${loanId}/payoff-quote`), c = cfg(), both = c.aceitaPix && c.aceitaDinheiro; let m = c.aceitaPix ? 'pix' : 'dinheiro';
  const body = () => m === 'pix' ? `${c.pixKey ? `<div class="field"><label>Pague por Pix para ${esc(c.pixNome || c.empresa)}</label><div class="row gap-8"><input class="input" id="pixk" readonly value="${esc(c.pixKey)}" /><button type="button" class="btn btn-light" onclick="copyPix()">Copiar</button></div></div>` : ''}<div class="field"><label>Comprovante</label><input class="input" id="qproof" type="file" accept="image/*,application/pdf" /></div>` : '<div class="field"><label>Quando e onde vai entregar? (opcional)</label><input class="input" id="qnote" maxlength="140" /></div>';
  openSheet(`${head('Quitar antecipado')}<div class="sum"><span class="small">Para quitar tudo hoje</span><br><b>${brl(q.totalCents)}</b><br><span class="small">você economiza ${brl(q.discountCents)} em juros</span></div>
   ${both ? `<div class="chips" id="qm">${[['pix', 'Pix'], ['dinheiro', 'Dinheiro']].map(([k, t]) => `<button type="button" class="chip ${m === k ? 'on' : ''}" data-m="${k}">${t}</button>`).join('')}</div>` : ''}
   <div id="qbody" style="display:flex;flex-direction:column;gap:12px">${body()}</div>
   <button class="btn btn-primary btn-lg" style="justify-content:center" id="qok">${ico('check')} Solicitar quitação</button>`);
  if (both) $('qm').onclick = (e) => { const b = e.target.closest('[data-m]'); if (!b) return; m = b.dataset.m; document.querySelectorAll('#qm .chip').forEach((x) => x.classList.toggle('on', x === b)); $('qbody').innerHTML = body(); };
  $('qok').onclick = () => run(async () => {
    if (m === 'pix') { const f = $('qproof').files[0]; if (!f) throw new Error('Anexe o comprovante'); await sendFile(`/me/loans/${loanId}/payoff-request?method=pix`, f); }
    else await POST(`/me/loans/${loanId}/payoff-request${qs({ method: 'dinheiro', note: $('qnote').value.trim() })}`);
    closeSheet(); portalRender();
  }, 'Quitação enviada para conferência ✓');
});

const docsView = async () => {
  const d = await GET('/me/documents');
  openSheet(`${head('Meus documentos')}<span class="small muted">Envie fotos nítidas. Elas ficam disponíveis só para a equipe e servem para verificar seu cadastro. São guardadas criptografadas.</span>
   ${d.map((x) => `<div class="item" style="box-shadow:none;border:1px solid var(--line)"><div class="grow"><b>${DOCS[x.tipo]}</b><span class="small ${x.status === 'recusado' ? '' : 'muted'}" ${x.status === 'recusado' ? 'style="color:var(--danger)"' : ''}>${x.status === 'pendente' ? 'Não enviado' : x.status === 'aprovado' ? 'Aprovado ✓' : x.status === 'recusado' ? 'Recusado: ' + esc(x.motivo) : 'Em análise'}</span></div>
     ${x.status === 'aprovado' ? '' : `<label class="btn btn-light btn-sm" style="cursor:pointer">${x.status === 'pendente' ? 'Enviar' : 'Reenviar'}<input type="file" accept="image/*,application/pdf" hidden onchange="sendDoc('${x.tipo}',this)"></label>`}</div>`).join('')}`);
};
window.docsSheet = () => run(docsView);
window.sendDoc = (k, inp) => run(async () => { const f = inp.files[0]; if (!f) return; await sendFile(`/me/documents?tipo=${k}`, f, 1600); await docsView(); }, 'Documento enviado ✓');

// ----- contrato e aceite -----
const contractHtml = (text) => `<div style="font-size:13.5px;line-height:1.6">${esc(text).replace(/\n/g, '<br><br>')}</div>`;
window.viewContract = (loanId) => run(async () => {
  const c = await GET(`/loans/${loanId}/contract`);
  openSheet(`${head('Contrato')}<div class="card card-pad">${contractHtml(c.text)}</div>${c.aceitoEm ? `<span class="small muted">Aceito em ${new Date(c.aceitoEm).toLocaleString('pt-BR')}</span>` : '<span class="small muted">Ainda não aceito.</span>'}`);
});
window.acceptSheet = (loanId) => run(async () => {
  const [c, rs] = await Promise.all([GET(`/loans/${loanId}/contract`), GET('/me/requests')]);
  const pr = rs.find((r) => r.proposta && r.proposta.loanId === loanId)?.proposta; if (!pr) throw new Error('Proposta não encontrada');
  openSheet(`${head('Proposta aprovada')}<div class="sum"><b>${brl(pr.valorCents)}</b><br>${pr.nParcelas}x de <b>${brl(pr.parcelaCents)}</b> · total ${brl(pr.totalCents)}<br><span class="small">1º vencimento ${fd(pr.primeiroVencimento)} · juros ${pctOf(pr.jurosBps)}%</span></div>
   <div class="card card-pad" style="max-height:34vh;overflow:auto">${contractHtml(c.text)}</div>
   <label class="row gap-8 small"><input type="checkbox" id="ac-ok" /> Li o contrato e concordo com as condições.</label>
   <button class="btn btn-primary btn-lg" style="justify-content:center" onclick="doAccept('${loanId}')">${ico('check')} Aceitar proposta</button>
   <button class="btn btn-ghost" onclick="doDecline('${loanId}')">Não quero esta proposta</button>`);
});
window.doAccept = (loanId) => run(async () => { if (!$('ac-ok').checked) throw new Error('Marque que leu e concorda'); await POST(`/loans/${loanId}/accept`, { aceito: true }); closeSheet(); pgo('emprest'); }, 'Proposta aceita ✓ A equipe vai liberar o valor.');
window.doDecline = (loanId) => { if (!confirm('Recusar esta proposta?')) return; run(async () => { await POST(`/loans/${loanId}/decline`); closeSheet(); portalRender(); }, 'Proposta recusada'); };
