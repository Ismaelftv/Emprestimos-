// Camada de acesso à API (cookie de sessão httpOnly + cabeçalho X-CSRF). Nada de dados sensíveis no navegador.
const API = '/api/v1';
let csrf = '';
const setCsrf = (t) => { csrf = t || ''; };
class ApiError extends Error { constructor(msg, status, code) { super(msg); this.status = status; this.code = code; } }
let onSessionLost = () => {};

async function req(method, path, body, opts = {}) {
  const h = { Accept: 'application/json' };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  if (method !== 'GET' && csrf) h['X-CSRF'] = csrf;
  let r;
  try { r = await fetch(API + path, { method, headers: h, body: payload, credentials: 'same-origin' }); }
  catch { throw new ApiError('Sem conexão com o servidor. Tente de novo.', 0, 'offline'); }
  if (opts.raw) { if (!r.ok) throw new ApiError('Não foi possível baixar o arquivo', r.status, 'erro'); return r; }
  let j = null; try { j = await r.json(); } catch { /* sem corpo */ }
  if (!r.ok) {
    if (r.status === 401 && !opts.keep) onSessionLost();
    throw new ApiError((j && j.message) || 'Algo deu errado. Tente novamente.', r.status, j && j.error);
  }
  return j;
}
const GET = (p, o) => req('GET', p, undefined, o);
const POST = (p, b, o) => req('POST', p, b ?? {}, o);
const PATCH = (p, b, o) => req('PATCH', p, b ?? {}, o);
const DEL = (p, o) => req('DELETE', p, undefined, o);
const qs = (o) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') u.set(k, v); const s = u.toString(); return s ? '?' + s : ''; };

// baixa um arquivo autenticado (CSV, backup) respeitando o cookie de sessão
async function download(path, name) {
  const r = await req('GET', path, undefined, { raw: true });
  const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
// reduz a foto no aparelho antes de enviar (menos dados, mais rápido). Devolve um Blob JPEG.
function shrink(file, max = 1400) {
  return new Promise((res, rej) => {
    if (!/^image\//.test(file.type)) return res(file); // PDF etc. seguem como estão (o servidor valida o conteúdo)
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => { const k = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); c.toBlob((b) => (b ? res(b) : rej(new Error('img'))), 'image/jpeg', 0.8); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('img')); }; img.src = url;
  });
}
async function sendFile(path, file, max) { const blob = await shrink(file, max), fd = new FormData(); fd.append('file', blob, 'foto.jpg'); return req('POST', path, fd); }
