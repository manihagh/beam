/**
 * Configuration module.
 *
 * Every piece of company-specific or deployment-specific value lives in env
 * vars, read here and surfaced via this typed Config object. The rest of the
 * codebase imports Config and never reads env directly. This is the seam that
 * lets Beam be deployed by any company without touching source.
 */

import type { Env } from "./index";

export interface Config {
  // Hostnames
  serveHost: string;
  mcpHost: string;
  publicHost: string;

  // Identity
  brandName: string;
  brandPrimaryColor: string;
  brandFromEmail: string;

  // Access control
  allowedSsoDomains: string[];
  adminEmails: string[];

  // Share link policy
  defaultShareHours: number;
  minShareHours: number;
  maxShareHours: number;

  // Versioning
  versionsKept: number;
}

const DEFAULTS = {
  brandName: "Beam",
  brandPrimaryColor: "#B5482A",
  defaultShareHours: 72,
  minShareHours: 1,
  maxShareHours: 168,
  versionsKept: 10,
};

/**
 * Validate a hex color string. Returns the color if valid, otherwise the
 * default. Accepts `#RRGGBB` or `#RGB`.
 */
function safeColor(input: string | undefined, fallback: string): string {
  if (!input) return fallback;
  const t = input.trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(t)) return t;
  if (/^#[0-9A-Fa-f]{3}$/.test(t)) return t;
  return fallback;
}

function safeInt(input: string | undefined, fallback: number, min: number, max: number): number {
  if (!input) return fallback;
  const n = parseInt(input, 10);
  if (Number.isNaN(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function csv(input: string | undefined): string[] {
  if (!input) return [];
  return input
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function getConfig(env: Env): Config {
  return {
    serveHost: env.SERVE_HOST,
    mcpHost: env.MCP_HOST,
    publicHost: env.PUBLIC_HOST,

    brandName: env.BRAND_NAME?.trim() || DEFAULTS.brandName,
    brandPrimaryColor: safeColor(env.BRAND_PRIMARY_COLOR, DEFAULTS.brandPrimaryColor),
    brandFromEmail: env.BRAND_FROM_EMAIL?.trim() || `noreply@${env.SERVE_HOST}`,

    allowedSsoDomains: csv(env.ALLOWED_SSO_DOMAINS),
    adminEmails: csv(env.ADMIN_EMAILS),

    defaultShareHours: safeInt(env.DEFAULT_SHARE_HOURS, DEFAULTS.defaultShareHours, 1, 168),
    minShareHours: safeInt(env.MIN_SHARE_HOURS, DEFAULTS.minShareHours, 1, 168),
    maxShareHours: safeInt(env.MAX_SHARE_HOURS, DEFAULTS.maxShareHours, 1, 168),
    versionsKept: safeInt(env.DASHBOARD_VERSIONS_KEPT, DEFAULTS.versionsKept, 0, 50),
  };
}

/**
 * Is this email allowed to authenticate to the internal control plane?
 *
 * Cloudflare Access is the primary gate; this is defense-in-depth. If the
 * Access policy is misconfigured to allow a wider set than ALLOWED_SSO_DOMAINS,
 * this check will still reject.
 */
export function isAllowedSsoEmail(email: string | null | undefined, cfg: Config): boolean {
  if (!email) return false;
  const lower = email.toLowerCase();
  if (cfg.allowedSsoDomains.length === 0) return true; // unset means no extra gate
  return cfg.allowedSsoDomains.some((d) => lower.endsWith(`@${d}`));
}

export function isAdmin(email: string | null | undefined, cfg: Config): boolean {
  if (!email) return false;
  return cfg.adminEmails.includes(email.toLowerCase());
}

/**
 * Tone down a primary color for use as a tinted background. Returns rgba()
 * with the configured alpha. Used by landing and share viewer to derive
 * accent surfaces from a single brand color.
 */
export function tint(hex: string, alpha: number): string {
  const m = hex.match(/^#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/);
  if (!m) return `rgba(79, 70, 229, ${alpha})`;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
