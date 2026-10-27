import { createHmac, timingSafeEqual } from "node:crypto";

import { getMergedEnvValue } from "@/lib/root-env";

export const APP_SESSION_COOKIE = "gymbro_pwa_session";
const SESSION_VERSION = 1;
const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;

export type AppSessionOwner = {
  identitySource: string;
  externalUserId: string;
};

type SessionPayload = AppSessionOwner & {
  v: number;
  issuedAt: number;
  expiresAt: number;
};

function sessionSecret() {
  const configured = getMergedEnvValue("GYMBRO_APP_SESSION_SECRET", "").trim();
  if (configured) return configured;
  // Local previews may reuse the existing localhost-only Mini App token. A
  // production process always requires a dedicated session secret.
  if (process.env.NODE_ENV !== "production") {
    return getMergedEnvValue("MINIAPP_API_TOKEN", "").trim();
  }
  return "";
}

function signature(encodedPayload: string, secret: string) {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

function readCookie(request: Request, name: string) {
  const cookie = request.headers.get("cookie") || "";
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      try { return decodeURIComponent(value.join("=")); } catch { return ""; }
    }
  }
  return "";
}

export function appSessionConfigured() {
  return sessionSecret().length >= 32;
}

export function issueAppSession(owner: AppSessionOwner, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const secret = sessionSecret();
  if (secret.length < 32) throw new Error("GYMBRO_APP_SESSION_SECRET must contain at least 32 characters");
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    v: SESSION_VERSION,
    identitySource: owner.identitySource,
    externalUserId: owner.externalUserId,
    issuedAt: now,
    expiresAt: now + ttlSeconds,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${signature(encoded, secret)}`;
}

export function verifyAppSession(request: Request): AppSessionOwner | null {
  const secret = sessionSecret();
  if (secret.length < 32) return null;
  const token = readCookie(request, APP_SESSION_COOKIE);
  if (token.length > 2048) return null;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;
  const encoded = token.slice(0, separator);
  const providedSignature = token.slice(separator + 1);
  if (!safeEqual(providedSignature, signature(encoded, secret))) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
    const now = Math.floor(Date.now() / 1000);
    if (
      payload.v !== SESSION_VERSION
      || !payload.identitySource
      || !payload.externalUserId
      || !Number.isFinite(payload.expiresAt)
      || payload.expiresAt <= now
    ) return null;
    return { identitySource: payload.identitySource, externalUserId: payload.externalUserId };
  } catch {
    return null;
  }
}
