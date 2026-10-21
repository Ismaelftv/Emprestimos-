// Inicialização: restaura a sessão (cookie), trata o link de convite e mantém o "hoje" correto.
onSessionLost = () => { if (!me) return; me = null; setCsrf(''); closeSheet(); $('root').innerHTML = ''; loginView(); toast('Sua sessão terminou. Entre de novo.'); };

async function loadStaff() { try { staffList = await GET('/staff'); } catch { staffList = []; } }
async function refreshMe() { const m = await GET('/me'); setCsrf(m.csrf); me = m; }

async function start() {
  if (!me) return loginView();
  if (me.kind === 'client') { ptab = 'home'; return portalRender(); }
  if (me.mustSetup2fa) { const s = await POST('/me/2fa/setup'); return twoFaSetupView(s, true); }
  await loadStaff();
  shell();
}

async function boot() {
  const m = location.hash.match(/^#\/convite\/([A-Za-z0-9_-]{20,100})$/);
  if (m) { setCsrf(''); return inviteView(m[1]); }
  try { await refreshMe(); } catch { me = null; }
  await start();
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && todaySP() !== hoje) { hoje = todaySP(); me && render(); } });
setInterval(() => { if (todaySP() !== hoje) { hoje = todaySP(); me && render(); } }, 60000);
addEventListener('hashchange', () => { if (/^#\/convite\//.test(location.hash)) boot(); });
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
boot();
