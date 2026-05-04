/**
 * Email queue orchestration.
 *
 * High-level entry points for the dashboard flows. Each call returns a
 * promise the caller passes to ctx.waitUntil(...) so the work continues
 * after the response is sent. NEVER throws to the caller; all errors are
 * swallowed and logged.
 *
 * From-address and display name are derived from BRAND_FROM_EMAIL and
 * BRAND_NAME in config.
 */

import type { Env } from "./index";
import { getConfig } from "./config";
import {
  sendEmail,
  isUnsubscribed,
  shouldDedup,
  computeUnsubToken,
} from "./email";
import {
  ownerExternalEmail,
  internalSharedEmail,
  deriveDisplayName,
} from "./email-template";
import type { Classification } from "./store";

function fromHeader(env: Env): string {
  const cfg = getConfig(env);
  return `${cfg.brandName} <${cfg.brandFromEmail}>`;
}

/**
 * Send the owner-external email after a share link is created or rotated.
 * Skips silently if the dashboard has no owner email recorded.
 */
export async function emailOwnerOnExternalShare(opts: {
  ownerEmail: string | undefined;
  uuid: string;
  title: string;
  shareUrl: string;
  password?: string;
  expiresAt: string;
  classification?: Classification;
  env: Env;
}): Promise<void> {
  try {
    const { ownerEmail, env } = opts;
    if (!ownerEmail) return;
    if (await isUnsubscribed(ownerEmail, env)) return;
    if (await shouldDedup(opts.uuid + ":owner_external", ownerEmail, env)) return;

    const cfg = getConfig(env);
    const { html, text } = ownerExternalEmail({
      uuid: opts.uuid,
      title: opts.title,
      shareUrl: opts.shareUrl,
      password: opts.password,
      expiresAt: opts.expiresAt,
      classification: opts.classification,
      cfg,
    });
    const subject = `Your share link for "${opts.title}"`;
    await sendEmail(
      { from: fromHeader(env), to: ownerEmail, subject, html, text, replyTo: ownerEmail },
      env
    );
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    console.error("[email-queue] owner-external failed:", m);
  }
}

/**
 * Send internal-shared emails for newly added recipients. Diffs old vs new
 * shared_with; only emails the *added* set. Skips owner if owner is in the
 * list (no point self-mailing).
 */
export async function emailNewlySharedRecipients(opts: {
  ownerEmail: string | undefined;
  uuid: string;
  title: string;
  oldSharedWith: string[];
  newSharedWith: string[];
  classification?: Classification;
  env: Env;
}): Promise<void> {
  try {
    const { env, ownerEmail } = opts;
    const cfg = getConfig(env);
    const internalUrl = `https://${cfg.serveHost}/${opts.uuid}`;
    const ownerLower = (ownerEmail || "").toLowerCase();

    const oldSet = new Set(opts.oldSharedWith.map((e) => e.toLowerCase()));
    const seen = new Set<string>();
    const added: string[] = [];
    for (const e of opts.newSharedWith) {
      const lc = e.toLowerCase();
      if (!lc || seen.has(lc)) continue;
      seen.add(lc);
      if (oldSet.has(lc)) continue;
      if (lc === ownerLower) continue;
      added.push(e);
    }
    if (added.length === 0) return;

    const publisherName = ownerEmail ? deriveDisplayName(ownerEmail) : "A colleague";

    await Promise.all(
      added.map(async (recipient) => {
        try {
          if (await isUnsubscribed(recipient, env)) return;
          if (await shouldDedup(opts.uuid + ":internal", recipient, env)) return;

          const unsubToken = await computeUnsubToken(recipient, env);
          const unsubUrl = `https://${cfg.publicHost}/unsub/${encodeURIComponent(recipient)}/${unsubToken}`;

          const { html, text } = internalSharedEmail({
            uuid: opts.uuid,
            title: opts.title,
            internalUrl,
            publisherName,
            unsubUrl,
            classification: opts.classification,
            cfg,
          });
          const subject = `${publisherName} shared "${opts.title}" with you`;
          await sendEmail(
            {
              from: fromHeader(env),
              to: recipient,
              replyTo: ownerEmail,
              subject,
              html,
              text,
            },
            env
          );
        } catch (innerErr: unknown) {
          const m = innerErr instanceof Error ? innerErr.message : String(innerErr);
          console.error(`[email-queue] internal-share failed:`, m);
        }
      })
    );
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    console.error("[email-queue] internal-shared failed:", m);
  }
}
