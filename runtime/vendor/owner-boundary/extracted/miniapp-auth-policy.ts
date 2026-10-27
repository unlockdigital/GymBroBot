export type MiniappAuthPolicyAuth = {
  userId: number | null;
  authMethod: "hmac" | "bearer-dev" | "pwa";
  owner?: MiniappOwner;
};

export type MiniappOwner = {
  identitySource: string;
  externalUserId: string;
};

type EnvReader = (name: string, fallback?: string) => string;
type KnownUserLookup = (owner: MiniappOwner) => boolean;

function envValue(env: EnvReader, name: string) {
  return String(env(name, "") || "").trim();
}

export function resolveDevBearerOwner(env: EnvReader): MiniappOwner | null {
  const externalUserId =
    envValue(env, "MINIAPP_DEV_TELEGRAM_USER_ID") ||
    envValue(env, "MINIAPP_ALLOWED_TELEGRAM_USER_ID") ||
    envValue(env, "GYMBRO_DASHBOARD_EXTERNAL_USER_ID");
  if (!externalUserId) return null;
  return {
    identitySource:
      envValue(env, "MINIAPP_DEV_IDENTITY_SOURCE") ||
      envValue(env, "GYMBRO_DASHBOARD_IDENTITY_SOURCE") ||
      "telegram",
    externalUserId,
  };
}

export function resolveMiniappOwner(
  auth: MiniappAuthPolicyAuth,
  { env, isKnownUser }: { env: EnvReader; isKnownUser: KnownUserLookup },
): MiniappOwner | null {
  const owner = auth.authMethod === "pwa" && auth.owner
    ? auth.owner
    : auth.userId != null
    ? { identitySource: "telegram", externalUserId: String(auth.userId) }
    : auth.authMethod === "bearer-dev"
      ? resolveDevBearerOwner(env)
      : null;

  if (!owner) return null;
  return isKnownUser(owner) ? owner : null;
}
