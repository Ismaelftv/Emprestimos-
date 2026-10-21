import webpush from 'web-push';
import type { Config } from '../config.js';

export interface PushPayload { title: string; body: string; url?: string; tag?: string }
export interface PushSub { endpoint: string; p256dh: string; auth: string }
export interface PushSender { enabled: boolean; send(sub: PushSub, p: PushPayload): Promise<'ok' | 'gone'> }

export function makePushSender(cfg: Config): PushSender {
  if (!cfg.vapid) return { enabled: false, async send() { return 'ok'; } };
  webpush.setVapidDetails(cfg.vapid.subject, cfg.vapid.publicKey, cfg.vapid.privateKey);
  return {
    enabled: true,
    async send(sub, p) {
      try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(p)); return 'ok'; }
      catch (e) { const code = (e as { statusCode?: number }).statusCode; if (code === 404 || code === 410) return 'gone'; throw e; }
    },
  };
}
export class MemoryPush implements PushSender { enabled = true; sent: { sub: PushSub; p: PushPayload }[] = []; async send(sub: PushSub, p: PushPayload): Promise<'ok' | 'gone'> { this.sent.push({ sub, p }); return 'ok'; } }
