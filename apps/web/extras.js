// Recibos, quitação, caixa diário, menu do empréstimo, login, recuperação de senha, 2FA, LGPD e avisos (push).

// ---------- recibo ----------
const receiptView = async (payId) => {
  const r = await GET(`/payments/${payId}/receipt`);
  let fone = '';
  if (me.kind === 'staff') { try { fone = (await GET('/clients/' + r.clientId)).whatsapp; } catch { /* sem acesso ao cadastro */ } }
  const ref = r.kind === 'quitacao' ? `Quitação antecipada (${r.parcelas.length} parcela(s))` : `Parcela ${r.parcelas[0]?.numero}/${r.nTotal} (venc. ${r.parcelas[0] ? fd(r.parcelas[0].due) : ''})`;
  const row2 = (k, v) => `<tr><td style="color:#666;padding:4px 0">${k}</td><td style="text-align:right">${v}</td></tr>`;
  const wa = waNum(fone);
  openSheet(`${head('Recibo')}<div style="box-sizing:border-box;width:100%;font-family:Figtree,Arial,sans-serif;max-width:420px;margin:auto;border:1px solid #ddd;border-radius:16px;padding:24px;color:#121826;background:#fff">
   <div style="font-weight:800;font-size:20px">${esc(r.empresa)}</div><div style="color:#666;font-size:13px">Recibo nº ${esc(r.no)}${r.estornado ? ' · <b style="color:#D9381E">ESTORNADO</b>' : ''}</div><hr style="border:0;border-top:1px solid #eee;margin:14px 0">
   <div style="font-size:34px;font-weight:800;letter-spacing:-.02em">${brl(r.valorCents)}</div>
   <table style="width:100%;font-size:14px;margin-top:12px;border-collapse:collapse">
    ${row2('Cliente', `<b>${esc(r.clienteNome)}</b>`)}${row2('Referente a', esc(ref))}${row2('Forma', r.forma === 'dinheiro' ? 'Dinheiro' : 'Pix')}${row2('Data', dt(r.data).toLocaleDateString('pt-BR'))}${row2('Recebido por', esc(r.recebidoPor))}
    ${r.descontoCents ? row2('Desconto concedido', brl(r.descontoCents)) : ''}${r.kind === 'parcela' ? row2('Situação da parcela', r.saldoRestanteCents ? 'Saldo restante ' + brl(r.saldoRestanteCents) : 'Quitada') : ''}</table>
   <div style="font-size:11px;color:#888;margin-top:16px">Documento gerado eletronicamente. Guarde este comprovante.</div></div>
   <div class="row gap-8 wrap">${wa ? `<a class="btn btn-light" target="_blank" rel="noopener" href="https://wa.me/${wa}?text=${encodeURIComponent(`Recibo ${r.no}: recebi ${brl(r.valorCents)} (${r.forma === 'dinheiro' ? 'dinheiro' : 'Pix'}) referente a: ${ref}. Obrigado, ${r.clienteNome.split(' ')[0]}!`)}">${ico('wa')} Enviar por WhatsApp</a>` : ''}
   <a class="btn btn-primary" href="${API}/payments/${payId}/receipt.pdf" target="_blank" rel="noopener">Abrir PDF / imprimir</a></div>`);
};
window.receiptSheet = (payId) => run(() => receiptView(payId));

// ---------- quitação antecipada ----------
window.quitSheet = (loanId) => run(async () => {
  const [l, q] = await Promise.all([GET('/loans/' + loanId), GET(`/loans/${loanId}/payoff-quote`)]);
  openSheet(`${head('Quitar empréstimo')}<div class="sum"><span class="small">${esc(l.clientNome)} · ${q.parts.length} parcela(s) em aberto</span><br><b>${brl(q.totalCents)}</b><br><span class="small">desconto de ${brl(q.discountCents)} nos juros das parcelas futuras (${pctOf(l.descQuitBps)}%)</span></div>
   <div class="field"><label>Forma de pagamento</label><div class="chips" id="cm">${[['pix', 'Pix'], ['dinheiro', 'Dinheiro']].map(([k, t]) => `<button type="button" class="chip ${cmethod === k ? 'on' : ''}" data-m="${k}">${t}</button>`).join('')}</div></div>
   <button class="btn btn-primary btn-lg" style="justify-content:center" id="cok">${ico('check')} Confirmar quitação</button>`);
  $('cm').onclick = (e) => { const b = e.target.closest('[data-m]'); if (!b) return; cmethod = b.dataset.m; document.querySelectorAll('#cm .chip').forEach((c) => c.classList.toggle('on', c === b)); };
  $('cok').onclick = () => run(async () => { const r = await POST(`/loans/${loanId}/payoff`, { method: cmethod }); closeSheet(); await render(); await receiptByNo(loanId, r.receiptNo); toast('Empréstimo quitado ✓'); });
});
// após a quitação o servidor devolve o nº do recibo; localizamos o lançamento para abrir o recibo
async function receiptByNo(loanId, no) {
  const l = await GET('/loans/' + loanId);
  const pay = l.installments.flatMap((i) => i.pagamentos).find((x) => x.receiptNo === no && x.method !== 'desconto' && x.kind !== 'estorno');
  if (pay) await receiptView(pay.id);
}
function quitItem(q) {
  return `<div class="card card-pad stack gap-8" style="margin-bottom:12px;border-color:var(--teal)"><div class="row between"><div><b>Quitação · ${esc(q.clienteNome)}</b><div class="small muted">${q.method === 'dinheiro' ? 'Dinheiro' : 'Pix'} · ${fdi(q.createdAt)}${q.note ? ' · ' + esc(q.note) : ''}</div></div><b class="amt">${brl(q.valorHojeCents ?? q.valorInformadoCents)}</b></div>
   ${q.valorHojeCents !== null && q.valorHojeCents !== q.valorInformadoCents ? `<span class="xs" style="color:var(--danger)">O valor mudou desde o pedido (informado ${brl(q.valorInformadoCents)}). Confira o comprovante.</span>` : ''}
   ${q.fileId ? `<img src="${API}/files/${q.fileId}" alt="Comprovante" style="max-height:180px;object-fit:contain;border-radius:12px;background:var(--soft)">` : ''}
   <div class="row gap-8"><button class="btn btn-primary btn-sm" onclick="payoffOk('${q.id}','${q.loanId}')">Confirmar recebimento</button><button class="btn btn-light btn-sm" onclick="payoffNo('${q.id}')">Recusar</button></div></div>`;
}
window.payoffOk = (id, loanId) => run(async () => { const r = await POST(`/payoff-requests/${id}/confirm`); await render(); await receiptByNo(loanId, r.receiptNo); toast('Empréstimo quitado ✓'); });
window.payoffNo = (id) => openSheet(`<form onsubmit="payoffNoGo(event,'${id}')" style="${FORM}">${head('Recusar quitação')}<div class="field"><label>Motivo (o cliente verá)</label><input class="input" id="pn-m" placeholder="Ex.: comprovante não confere" /></div><button class="btn btn-danger btn-lg" style="justify-content:center">Recusar</button></form>`);
window.payoffNoGo = (e, id) => { e.preventDefault(); run(async () => { await POST(`/payoff-requests/${id}/refuse`, { motivo: $('pn-m').value.trim() }); closeSheet(); render(); }, 'Pedido recusado'); };

// ---------- menu do empréstimo (equipe) ----------
window.loanMenu = (loanId) => run(async () => {
  const l = await GET('/loans/' + loanId), open = l.installments.some((p) => p.status !== 'paid');
  const it = (i, t, fn) => `<button class="menu-i" onclick="${fn}"><span class="c">${ico(i)}</span>${t}</button>`;
  openSheet(`${head('Empréstimo ' + brl(l.valorCents))}
   ${open && l.status === 'ativo' ? it('check', 'Quitar (com desconto)', `quitSheet('${loanId}')`) : ''}
   ${open && l.status === 'ativo' ? it('alert', 'Perdoar multa e mora das atrasadas', `waive('${loanId}')`) : ''}
   ${l.status === 'ativo' && !l.disbursedAt ? it('coin', 'Registrar entrega do valor', `disburseSheet('${loanId}')`) : ''}
   ${it('receipt', l.acceptedAt || l.status === 'proposta' ? 'Ver contrato' : 'Ver contrato (modelo)', `viewContract('${loanId}')`)}
   ${can('excluir') && ['ativo', 'proposta'].includes(l.status) ? it('trash', 'Cancelar empréstimo', `cancelLoan('${loanId}')`) : ''}`);
});
window.waive = (loanId) => run(async () => { const r = await POST(`/loans/${loanId}/waive`); closeSheet(); render(); toast(r.perdoadas ? 'Multa e mora perdoadas ✓' : 'Nenhuma parcela atrasada'); });
window.cancelLoan = (loanId) => { if (!confirm('Cancelar este empréstimo? As parcelas em aberto saem da agenda.')) return; run(async () => { await POST(`/loans/${loanId}/cancel`); closeSheet(); render(); }, 'Empréstimo cancelado'); };
window.disburseSheet = (loanId) => openSheet(`${head('Entrega do valor')}<span class="small muted">Como o valor foi entregue ao cliente? Em dinheiro, a saída entra no seu caixa.</span>
   <div class="row gap-8"><button class="btn btn-primary" onclick="disburse('${loanId}','dinheiro')">Dinheiro</button><button class="btn btn-light" onclick="disburse('${loanId}','pix')">Pix</button></div>`);
window.disburse = (loanId, m) => run(async () => { await POST(`/loans/${loanId}/disburse`, { method: m }); closeSheet(); render(); }, 'Entrega registrada ✓');

// ---------- caixa diário ----------
let cxUser = null, cxDate = null;
async function caixa() {
  cxUser = isAdmin() ? cxUser || me.id : me.id; cxDate = cxDate || hoje;
  const [d, closings] = await Promise.all([GET('/cash' + qs({ staffId: cxUser, date: cxDate })), isAdmin() ? GET('/cash/closings') : []]);
  const mine = cxUser === me.id, f = d.fechamento;
  const TS = { emprestimo: 'Empréstimo entregue', despesa: 'Despesa', sangria: 'Retirada do dono' };
  return `<div class="row between" style="align-items:center"><h1 class="hello display">Caixa</h1>${mine ? `<button class="btn btn-primary btn-sm" onclick="saidaSheet()">${ico('plus')} Saída</button>` : ''}</div>
  <div class="row gap-8 wrap" style="margin:8px 0 12px">${isAdmin() ? `<select class="select" style="max-width:220px" onchange="cxUser=this.value;render()">${staffList.map((u) => `<option value="${u.id}" ${u.id === cxUser ? 'selected' : ''}>${esc(u.nome)}</option>`).join('')}</select>` : ''}<input class="input" type="date" style="max-width:170px" value="${cxDate}" max="${hoje}" onchange="cxDate=this.value||'${hoje}';render()" /></div>
  <div class="hero"><small>Dinheiro esperado em caixa</small><div class="big">${brl(d.esperadoCents)}</div>
   <div class="pills"><div class="pill"><b>${brl(d.inicialCents)}</b><span>Saldo inicial</span></div><div class="pill"><b>${brl(d.dinheiroCents)}</b><span>Entrou (dinheiro)</span></div><div class="pill"><b>${brl(d.saidasCents)}</b><span>Saiu</span></div></div></div>
  <div class="tile small" style="margin-bottom:12px">Pix recebido no dia: <b>${brl(d.pixCents)}</b> (vai direto para a conta, não entra no caixa físico).</div>
  ${mine ? `<button class="btn btn-dark" style="margin-bottom:12px" onclick="fecharSheet()">${ico('check')} ${f ? 'Refazer fechamento' : 'Fechar caixa'}</button>` : ''}
  ${f ? `<div class="notice ${f.diffCents === 0 ? 'notice-teal' : 'notice-warn'}">${ico('check')}<span class="small">Fechado às ${new Date(f.closedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}: contado ${brl(f.contadoCents)} · ${f.diffCents === 0 ? 'confere' : (f.diffCents > 0 ? 'sobra ' : 'falta ') + brl(Math.abs(f.diffCents))}</span></div>` : ''}
  <div class="sec"><h2>Movimentos</h2></div>
  ${d.movimentos.map((x) => `<div class="item"><div class="grow"><b>${esc(x.cliente)}</b><span class="small muted">${x.method === 'dinheiro' ? 'Dinheiro' : 'Pix'}${x.estorno ? ' · estorno' : ''}${x.receiptNo ? ' · ' + esc(x.receiptNo) : ''}</span></div><div class="amt" style="color:${x.valorCents < 0 ? 'var(--danger)' : 'var(--teal)'}">${x.valorCents < 0 ? '−' : '+'} ${brl(Math.abs(x.valorCents))}</div></div>`).join('')}
  ${d.saidas.map((o) => `<div class="item"><div class="grow"><b>${TS[o.tipo]}</b><span class="small muted">${esc(o.descricao || '')}</span></div><div class="amt" style="color:var(--danger)">− ${brl(o.valorCents)}</div></div>`).join('')}
  ${!d.movimentos.length && !d.saidas.length ? '<div class="empty2">Sem movimentos neste dia.</div>' : ''}
  ${isAdmin() ? `<div class="sec"><h2>Fechamentos recentes</h2></div>${closings.slice(0, 10).map((x) => `<div class="item"><div class="grow"><b>${esc(x.funcionario)} · ${fd(x.date)}</b><span class="small muted">esperado ${brl(x.esperadoCents)} · contado ${brl(x.contadoCents)}${x.obs ? ' · ' + esc(x.obs) : ''}</span></div><span class="tag ${x.diffCents === 0 ? 't-ok' : 't-late'}">${x.diffCents === 0 ? 'Confere' : (x.diffCents > 0 ? '+' : '−') + brl(Math.abs(x.diffCents))}</span></div>`).join('') || '<div class="empty2">Nenhum fechamento ainda.</div>'}` : ''}`;
}
window.saidaSheet = () => openSheet(`<form onsubmit="saveSaida(event)" style="${FORM}">${head('Saída de dinheiro')}
   <div class="field"><label>Tipo</label><select class="select" id="so-t"><option value="emprestimo">Empréstimo entregue em dinheiro</option><option value="despesa">Despesa</option><option value="sangria">Retirada do dono (sangria)</option></select></div>
   <div class="field"><label>Valor</label><input class="input" id="so-v" inputmode="decimal" required placeholder="R$ 0,00" /></div>
   <div class="field"><label>Descrição</label><input class="input" id="so-d" maxlength="120" /></div>
   <button class="btn btn-primary btn-lg" style="justify-content:center">Lançar saída</button></form>`);
window.saveSaida = (e) => { e.preventDefault(); run(async () => {
  const v = cents($('so-v').value); if (!(v > 0)) throw new Error('Informe um valor válido');
  await POST('/cash/ops', { tipo: $('so-t').value, valorCents: v, descricao: $('so-d').value.trim(), date: cxDate || hoje }); closeSheet(); render();
}, 'Saída lançada ✓'); };
window.fecharSheet = () => run(async () => {
  const d = await GET('/cash' + qs({ staffId: me.id, date: cxDate || hoje }));
  openSheet(`<form onsubmit="saveFecha(event)" style="${FORM}">${head('Fechar caixa')}
   <div class="sum">Esperado em dinheiro: <b>${brl(d.esperadoCents)}</b><br><span class="small">${brl(d.inicialCents)} inicial + ${brl(d.dinheiroCents)} recebido − ${brl(d.saidasCents)} saídas</span></div>
   <div class="field"><label>Quanto dinheiro há no caixa (contado)?</label><input class="input" id="fc-v" inputmode="decimal" required /></div>
   <div class="field"><label>Observação (se houver diferença)</label><input class="input" id="fc-o" maxlength="140" /></div>
   <button class="btn btn-primary btn-lg" style="justify-content:center">Fechar caixa</button></form>`);
});
window.saveFecha = (e) => { e.preventDefault(); run(async () => { await POST('/cash/close', { contadoCents: cents($('fc-v').value), obs: $('fc-o').value.trim(), date: cxDate || hoje }); closeSheet(); render(); }, 'Caixa fechado ✓'); };

// ---------- lembretes de cobrança (equipe) ----------
window.lembretesSheet = () => run(async () => {
  const r = await GET('/reminders/today');
  openSheet(`${head('Lembretes de hoje')}<span class="small muted">${r.itens.length} parcela(s) vencidas ou vencendo hoje. Toque em enviar: o WhatsApp abre com a mensagem pronta.</span>
   ${r.itens.map((p) => `<div class="item"><div class="grow"><b>${esc(p.clientNome)}</b><span class="small muted">Parcela ${p.numero}/${p.nTotal} · ${fd(p.dueDate)} · ${brl(p.balanceCents)}</span></div>${p.whatsappLink ? `<a class="btn ${p.enviado ? 'btn-light' : 'btn-primary'} btn-sm" target="_blank" rel="noopener" href="${p.whatsappLink}" onclick="reminderSent('${p.installmentId}',this)">${p.enviado ? 'Enviado ✓' : 'Enviar'}</a>` : '<span class="tag t-off">sem WhatsApp</span>'}</div>`).join('') || '<div class="empty2">Nada para cobrar hoje 🎉</div>'}`);
});
window.reminderSent = (id, el) => { el.className = 'btn btn-light btn-sm'; el.textContent = 'Enviado ✓'; POST(`/installments/${id}/reminder-sent`).catch(() => {}); };

// ---------- LGPD (admin) ----------
window.anonSheet = (cid) => run(async () => {
  const c = await GET('/clients/' + cid);
  openSheet(`${head('Dados do titular (LGPD)')}<span class="small muted">${esc(c.nome)}. Você pode baixar uma cópia dos dados ou anonimizar o cadastro.</span>
   <button class="btn btn-light" onclick="exportClient('${cid}')">Baixar cópia dos dados (JSON)</button>
   <div class="notice notice-warn" style="display:block"><span class="small"><b>Anonimizar</b> apaga nome, CPF, contatos, documentos e o acesso ao portal. Valores e datas dos empréstimos são mantidos por obrigação legal/contábil. <b>Não dá para desfazer.</b> Só é possível quando não há empréstimo em andamento.</span></div>
   <button class="btn btn-danger" onclick="anonymize('${cid}')">Anonimizar este cliente</button>`);
});
window.exportClient = (cid) => run(() => download(`/clients/${cid}/privacy/export`, 'dados-titular.json'));
window.anonymize = (cid) => { if (!confirm('Anonimizar definitivamente este cliente?')) return; run(async () => { await POST(`/clients/${cid}/anonymize`); closeSheet(); clientId = null; render(); }, 'Cliente anonimizado'); };

// ---------- esqueci minha senha (código de 6 dígitos por e-mail) ----------
window.forgotSheet = () => openSheet(`<form onsubmit="forgotStep(event)" style="${FORM}">${head('Recuperar senha')}
   <div class="field"><label>Seu e-mail de login</label><input class="input" id="fg-e" type="email" required /></div>
   <button class="btn btn-primary btn-lg" style="justify-content:center">Enviar código</button></form>`);
let resetEmail = '';
window.forgotStep = (e) => { e.preventDefault(); run(async () => {
  resetEmail = $('fg-e').value.trim().toLowerCase(); await POST('/auth/forgot', { email: resetEmail });
  openSheet(`<form onsubmit="forgotDone(event)" style="${FORM}">${head('Nova senha')}
   <div class="notice notice-teal" style="display:block"><span class="small">Se o e-mail existir, enviamos um código de 6 dígitos (vale por 15 minutos).</span></div>
   <div class="field"><label>Código recebido</label><input class="input" id="fg-c" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required /></div>
   <div class="field"><label>Nova senha (mín. 8)</label><input class="input" id="fg-s" type="password" minlength="8" autocomplete="new-password" required /></div>
   <button class="btn btn-primary btn-lg" style="justify-content:center">Salvar nova senha</button></form>`);
}); };
window.forgotDone = (e) => { e.preventDefault(); run(async () => { await POST('/auth/reset', { email: resetEmail, code: $('fg-c').value.trim(), password: $('fg-s').value }); closeSheet(); }, 'Senha alterada ✓ Faça login.'); };

// ---------- 2FA (TOTP, compatível com Google Authenticator / Authy) ----------
window.twoFaSheet = () => run(async () => {
  if (me.totpEnabled) {
    return openSheet(`<form onsubmit="twoFaOff(event)" style="${FORM}">${head('Verificação em duas etapas')}<div class="notice notice-teal">${ico('team')}<span class="small">Ativa para a sua conta. No login, além da senha, pedimos o código do aplicativo.</span></div>
     <div class="field"><label>Sua senha</label><input class="input" id="tf-p" type="password" autocomplete="current-password" required /></div>
     <div class="field"><label>Código atual do aplicativo</label><input class="input" id="tf-c" inputmode="numeric" maxlength="6" required /></div>
     <button class="btn btn-light">Desativar</button></form>`);
  }
  const s = await POST('/me/2fa/setup'); twoFaSetupView(s);
});
function twoFaSetupView(s, full) {
  const html = `${full ? '' : head('Ativar 2FA')}<span class="small muted">1. No Google Authenticator ou Authy, adicione uma conta com "inserir chave de configuração" e digite:</span>
   <input class="input" readonly id="tf-s" value="${esc(s.secret)}" style="font-family:monospace;letter-spacing:.08em" onclick="this.select()" />
   <a class="small bold" href="${esc(s.uri)}">Abrir no aplicativo autenticador</a>
   <div class="field"><label>2. Digite o código de 6 dígitos que apareceu</label><input class="input" id="tf-c" inputmode="numeric" maxlength="6" autocomplete="one-time-code" /></div>
   <button class="btn btn-primary btn-lg" style="justify-content:center" onclick="twoFaOn()">Ativar</button>`;
  if (full) $('root').innerHTML = `<div class="login"><div class="logo">${ico('team')}</div><h1 class="display h-lg" style="font-size:30px">Proteja sua conta</h1><span class="muted">Administradores precisam ativar a verificação em duas etapas para continuar.</span>${html}<button class="btn btn-ghost btn-sm" style="align-self:center" onclick="logout()">Sair</button></div>`;
  else openSheet(html);
}
window.twoFaOn = () => run(async () => { await POST('/me/2fa/enable', { code: $('tf-c').value.trim() }); closeSheet(); await refreshMe(); $('root').innerHTML = ''; await render(); }, '2FA ativado ✓');
window.twoFaOff = (e) => { e.preventDefault(); run(async () => { await POST('/me/2fa/disable', { password: $('tf-p').value, code: $('tf-c').value.trim() }); closeSheet(); await refreshMe(); render(); }, '2FA desativado'); };

// ---------- login, cadastro e convite ----------
function loginView() {
  $('root').innerHTML = `<form class="login" onsubmit="doLogin(event)">
   <div class="logo">${ico('coin')}</div><h1 class="display h-lg" style="font-size:36px">Caixa</h1><span class="muted">Controle de empréstimos para você e sua equipe.</span>
   <div class="field"><label for="l-e">E-mail</label><input class="input" id="l-e" type="email" autocomplete="username" required /></div>
   <div class="field"><label for="l-s">Senha</label><input class="input" id="l-s" type="password" autocomplete="current-password" required /></div>
   <span class="error" id="l-err"></span>
   <button class="btn btn-primary btn-lg" style="justify-content:center">Entrar</button>
   <button type="button" class="btn btn-ghost btn-sm" style="align-self:center" onclick="forgotSheet()">Esqueci minha senha</button>
   <button type="button" class="btn btn-light" onclick="signupSheet()">Sou cliente · criar minha conta</button>
   <div class="notice notice-warn small" style="display:block">${LEGAL}</div></form>`;
}
function afterLogin(r) { setCsrf(r.csrf); me = r.me; tab = 'home'; $('root').innerHTML = ''; return start(); }
window.doLogin = (e) => { e.preventDefault(); const email = $('l-e').value.trim(); (async () => {
  if (busy) return; busy = true;
  try {
    const r = await POST('/auth/login', { email, password: $('l-s').value }, { keep: true });
    if (r.mfa) return mfaView();
    await afterLogin(r);
  } catch (err) { const el = $('l-err'); if (el) el.textContent = err.message; } finally { busy = false; }
})(); };
function mfaView() {
  $('root').innerHTML = `<form class="login" onsubmit="login2fa(event)"><div class="logo">${ico('team')}</div><h1 class="display h-lg" style="font-size:30px">Verificação em duas etapas</h1><span class="muted">Digite o código de 6 dígitos do seu aplicativo autenticador.</span>
   <div class="field"><label for="l-t">Código</label><input class="input" id="l-t" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required /></div><span class="error" id="l-err"></span>
   <button class="btn btn-primary btn-lg" style="justify-content:center">Confirmar</button><button type="button" class="btn btn-ghost btn-sm" style="align-self:center" onclick="loginView()">Voltar</button></form>`;
  $('l-t').focus();
}
window.login2fa = (e) => { e.preventDefault(); (async () => {
  if (busy) return; busy = true;
  try { await afterLogin(await POST('/auth/2fa', { code: $('l-t').value.trim() }, { keep: true })); }
  catch (err) { const el = $('l-err'); if (el) el.textContent = err.message; if (err.status === 401 && /novamente|Muitas/.test(err.message)) setTimeout(loginView, 1500); } finally { busy = false; }
})(); };
window.loginView = loginView;
window.logout = () => { closeSheet(); POST('/auth/logout', {}, { keep: true }).catch(() => {}).finally(() => { me = null; setCsrf(''); $('root').innerHTML = ''; loginView(); }); };

window.signupSheet = () => openSheet(`<form onsubmit="doSignup(event)" style="${FORM}">${head('Criar minha conta')}
   <div class="field"><label>Nome completo</label><input class="input" id="s-n" required /></div>
   <div class="row2"><div class="field"><label>WhatsApp</label><input class="input" id="s-f" inputmode="tel" required /></div><div class="field"><label>CPF</label><input class="input" id="s-d" inputmode="numeric" required /></div></div>
   <div class="field"><label>E-mail (será seu login)</label><input class="input" id="s-e" type="email" required /></div>
   <div class="field"><label>Senha (mín. 8)</label><input class="input" id="s-s" type="password" minlength="8" autocomplete="new-password" required /></div>
   <label class="row gap-8 small"><input type="checkbox" id="s-ok" required /> <span>Concordo com o uso dos meus dados para análise de crédito e cobrança (LGPD). <a href="privacidade.html" target="_blank" rel="noopener">Política de privacidade</a></span></label>
   <button class="btn btn-primary btn-lg" style="justify-content:center">Criar conta</button></form>`);
window.doSignup = (e) => { e.preventDefault(); run(async () => {
  if (!cpfOk($('s-d').value)) throw new Error('CPF inválido');
  const r = await POST('/auth/signup', { nome: $('s-n').value.trim(), whatsapp: $('s-f').value.trim(), cpf: $('s-d').value.trim(), email: $('s-e').value.trim(), password: $('s-s').value, consent: $('s-ok').checked });
  closeSheet(); ptab = 'home'; await afterLogin(r);
}, 'Conta criada ✓'); };

// convite (#/convite/<token>): a pessoa define a própria senha; o link vale 7 dias e uma vez só
function inviteView(token) {
  $('root').innerHTML = `<form class="login" onsubmit="doInvite(event,'${esc(token)}')"><div class="logo">${ico('coin')}</div><h1 class="display h-lg" style="font-size:32px">Crie sua senha</h1><span class="muted">Escolha uma senha para acessar o Caixa (mínimo 8 caracteres).</span>
   <div class="field"><label for="iv-s">Nova senha</label><input class="input" id="iv-s" type="password" minlength="8" autocomplete="new-password" required /></div>
   <div class="field"><label for="iv-s2">Repita a senha</label><input class="input" id="iv-s2" type="password" minlength="8" autocomplete="new-password" required /></div>
   <span class="error" id="l-err"></span>
   <button class="btn btn-primary btn-lg" style="justify-content:center">Salvar e entrar</button></form>`;
}
window.doInvite = (e, token) => { e.preventDefault(); (async () => {
  if (busy) return; busy = true;
  try {
    if ($('iv-s').value !== $('iv-s2').value) throw new Error('As senhas não conferem');
    const r = await POST('/auth/invite/accept', { token, password: $('iv-s').value }, { keep: true });
    history.replaceState(null, '', location.pathname);
    const lg = await POST('/auth/login', { email: r.email, password: $('iv-s').value }, { keep: true });
    if (lg.mfa) return mfaView(); await afterLogin(lg);
  } catch (err) { const el = $('l-err'); if (el) el.textContent = err.message; } finally { busy = false; }
})(); };
window.inviteView = inviteView;

// ---------- avisos no aparelho (Web Push real: funciona com o app fechado) ----------
const b64 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4), r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, (c) => c.charCodeAt(0)); };
window.avisosOn = () => run(async () => {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Seu navegador não suporta avisos');
  const { publicKey } = await GET('/push/key'); if (!publicKey) throw new Error('A empresa ainda não ativou os avisos no servidor');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Permissão negada');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(publicKey) }));
  await POST('/push/subscribe', sub.toJSON());
}, 'Avisos ativados ✓');
