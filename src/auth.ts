import type { Env } from "./types";

/**
 * Перевірка входу через Cloudflare Access.
 * Access стоїть перед застосунком і пускає лише дозволені email (код на пошту).
 * Worker додатково перевіряє підписаний JWT із заголовка Cf-Access-Jwt-Assertion,
 * щоб заголовок не можна було підробити, навіть якщо Access випадково вимкнуть.
 */

interface Jwk extends JsonWebKey {
  kid: string;
}
let keyCache: { team: string; at: number; keys: Map<string, CryptoKey> } | null = null;

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function accessKeys(team: string): Promise<Map<string, CryptoKey>> {
  if (keyCache && keyCache.team === team && Date.now() - keyCache.at < 3_600_000) return keyCache.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  const map = new Map<string, CryptoKey>();
  for (const k of keys) {
    map.set(k.kid, await crypto.subtle.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  keyCache = { team, at: Date.now(), keys: map };
  return map;
}

export async function verifyAccessJwt(token: string, team: string, aud: string): Promise<string | null> {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h))) as { kid?: string; alg?: string };
  if (header.alg !== "RS256" || !header.kid) return null;
  const key = (await accessKeys(team)).get(header.kid);
  if (!key) return null;
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return null;
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p))) as { aud?: string | string[]; exp?: number; email?: string };
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) return null;
  if (!claims.exp || claims.exp * 1000 < Date.now()) return null;
  return claims.email?.toLowerCase() ?? null;
}

export type AuthResult = { ok: true; email: string } | { ok: false; status: number; message: string };

export async function authenticate(env: Env, req: Request): Promise<AuthResult> {
  if (env.DEV_NO_AUTH === "1") return { ok: true, email: "dev@local" };

  const allowed = env.ALLOWED_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !allowed.length) {
    return { ok: false, status: 503, message: "Вхід ще не налаштований (Cloudflare Access). Див. README." };
  }
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token) return { ok: false, status: 401, message: "Потрібен вхід" };
  const email = await verifyAccessJwt(token, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD).catch(() => null);
  if (!email) return { ok: false, status: 401, message: "Недійсний вхід" };
  if (!allowed.includes(email)) return { ok: false, status: 403, message: "Немає доступу" };
  return { ok: true, email };
}
