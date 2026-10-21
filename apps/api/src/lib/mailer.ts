import nodemailer from 'nodemailer';

export interface Mail { to: string; subject: string; text: string; html?: string }
export interface Mailer { send(m: Mail): Promise<void> }

export class SmtpMailer implements Mailer {
  private t; constructor(url: string, private from: string) { this.t = nodemailer.createTransport(url); }
  async send(m: Mail) { await this.t.sendMail({ from: this.from, to: m.to, subject: m.subject, text: m.text, html: m.html }); }
}
/** Dev/teste: guarda em memória e escreve no log. */
export class MemoryMailer implements Mailer {
  sent: Mail[] = []; constructor(private log?: (s: string) => void) {}
  async send(m: Mail) { this.sent.push(m); this.log?.(`[email] para ${m.to}: ${m.subject}`); }
  last(to?: string) { return [...this.sent].reverse().find((m) => !to || m.to === to); }
}
const wrap = (title: string, body: string) => `<div style="font-family:Figtree,Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#121826"><h2 style="font-family:Arial;margin:0 0 12px">${title}</h2>${body}<p style="color:#888;font-size:12px;margin-top:24px">Se você não pediu isso, ignore este e-mail.</p></div>`;
export const tpl = {
  reset: (code: string) => ({ subject: 'Seu código para redefinir a senha', text: `Seu código é ${code}. Ele vale por 15 minutos e só pode ser usado uma vez.`, html: wrap('Redefinir senha', `<p>Seu código:</p><p style="font-size:32px;font-weight:800;letter-spacing:4px">${code}</p><p>Vale por 15 minutos e só pode ser usado uma vez.</p>`) }),
  invite: (nome: string, url: string, empresa: string) => ({ subject: `${empresa}: crie sua senha de acesso`, text: `Olá, ${nome}! Crie sua senha em: ${url} (o link vale por 7 dias).`, html: wrap(`Olá, ${nome}!`, `<p><a href="${url}">Criar minha senha de acesso</a></p><p>O link vale por 7 dias e só pode ser usado uma vez.</p>`) }),
  proposta: (nome: string, empresa: string, url: string) => ({ subject: `${empresa}: sua proposta está pronta`, text: `Olá, ${nome}! Sua solicitação foi aprovada. Abra o app para ler o contrato e aceitar: ${url}`, html: wrap('Proposta aprovada', `<p>Olá, ${nome}! Sua solicitação foi aprovada.</p><p><a href="${url}">Ler contrato e aceitar</a></p>`) }),
  recibo: (nome: string, empresa: string, no: string, valor: string) => ({ subject: `${empresa}: recibo ${no}`, text: `Olá, ${nome}! Recebemos ${valor}. Recibo ${no}. Veja no app.`, html: wrap(`Recibo ${no}`, `<p>Olá, ${nome}! Recebemos <b>${valor}</b>.</p>`) }),
};
