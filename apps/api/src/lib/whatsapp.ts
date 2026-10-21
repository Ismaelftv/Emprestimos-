import { normalizeWhatsApp } from '@caixa/core';

export const waLink = (phone: string, text: string) => { const n = normalizeWhatsApp(phone); return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : null; };

/** Troca simples entre o link wa.me (padrão, o usuário toca em enviar) e a API oficial (envio automático). */
export interface WhatsAppSender { readonly automatic: boolean; send(toPhone: string, text: string): Promise<void> }
export class WaLinkSender implements WhatsAppSender { readonly automatic = false; async send(): Promise<void> { throw new Error('Envio automático não configurado: use o link wa.me'); } }
/** Ponto de integração com a WhatsApp Business Cloud API (não ativado: exige conta, número e templates aprovados na Meta). */
export class CloudApiSender implements WhatsAppSender {
  readonly automatic = true;
  constructor(private cfg: { phoneNumberId: string; token: string }) {}
  async send(toPhone: string, text: string) {
    const r = await fetch(`https://graph.facebook.com/v20.0/${this.cfg.phoneNumberId}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${this.cfg.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to: normalizeWhatsApp(toPhone), type: 'text', text: { body: text } }) });
    if (!r.ok) throw new Error('WhatsApp API ' + r.status);
  }
}
