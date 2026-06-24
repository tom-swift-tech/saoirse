// =============================================================================
// notifier.ts — outbound delivery seam for Saoirse proactivity.
//
// NtfyNotifier is the first implementation: posts to a self-hosted (or ntfy.sh)
// topic URL over plain HTTP. NullNotifier is the no-op fallback used when no
// NTFY_URL is configured — jobs still fire and surface to the console so the
// feature works without an ntfy server.
//
// BEST-EFFORT CONTRACT: notify() NEVER throws. Network errors, non-2xx responses,
// and timeouts are all caught and logged to console.error. A failed delivery must
// not break a scheduler tick.
// =============================================================================

import { type Notifier, type Notification } from './jobs.js';

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Posts notifications to an ntfy topic URL (self-hosted or ntfy.sh).
 * `url` is the full topic URL, e.g. https://ntfy.sh/saoirse.
 */
export class NtfyNotifier implements Notifier {
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(config: { url: string; timeoutMs?: number }) {
    this.url = config.url;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // Best-effort: catches ALL errors (network, non-2xx, timeout). Resolves void either way.
  async notify({ title, message }: Notification): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'text/plain',
      };
      if (title) {
        headers['Title'] = title;
      }

      const res = await fetch(this.url, {
        method: 'POST',
        headers,
        body: message,
        signal: controller.signal,
      });

      if (!res.ok) {
        console.error(
          `[notifier] ntfy delivery failed: HTTP ${res.status} ${res.statusText} from ${this.url}`,
        );
      }
    } catch (err) {
      // AbortError from timeout, network failure, DNS error — all swallowed.
      console.error('[notifier] ntfy delivery failed:', err);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * No-op notifier used when no NTFY_URL is configured.
 * Logs to the console so proactive jobs still surface.
 */
export class NullNotifier implements Notifier {
  // Best-effort: always resolves, never throws.
  async notify({ title, message }: Notification): Promise<void> {
    const prefix = title ? `${title}: ` : '';
    console.log(`[notifier] (no outbound configured) ${prefix}${message}`);
  }
}
