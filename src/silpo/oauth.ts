import type { Env } from "../types";
import { deleteSetting, getSetting, setSetting } from "../db";

/**
 * OAuth 2.1 для офіційного MCP Сільпо — за стандартом MCP Authorization:
 *  1) знаходимо сервер авторизації (RFC 9728 → RFC 8414),
 *  2) реєструємо застосунок як клієнта (RFC 7591, dynamic client registration),
 *  3) вхід дружини через сайт Сільпо з PKCE (S256),
 *  4) зберігаємо токени в D1 і оновлюємо їх через refresh_token.
 * Токени ніколи не віддаються у браузер і не потрапляють у код.
 */

interface ClientInfo {
  client_id: string;
  client_secret?: string;
  auth_method: string; // none | client_secret_post | client_secret_basic
  authorization_endpoint: string;
  token_endpoint: string;
  redirect_uri: string;
  resource: string;
  scope?: string;
}

interface Pending {
  state: string;
  verifier: string;
  at: number;
}

const CLIENT_KEY = "silpo_oauth_client";
const PENDING_KEY = "silpo_oauth_pending";
const ERROR_KEY = "silpo_oauth_error";

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(n = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

async function s256(verifier: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(d));
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Знаходить метадані сервера авторизації для MCP-ресурсу. */
export async function discover(mcpUrl: string): Promise<{ as: Record<string, unknown>; resource: string; scopes?: string[] }> {
  const u = new URL(mcpUrl);
  const origin = u.origin;
  const path = u.pathname.replace(/\/$/, "");

  // 1) Метадані захищеного ресурсу: з заголовка 401 або з well-known адрес.
  let prm: Record<string, unknown> | null = null;
  try {
    const r = await fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "silpopo", version: "0.2.0" } } }),
    });
    const wa = r.headers.get("www-authenticate") ?? "";
    const m = wa.match(/resource_metadata="([^"]+)"/);
    if (m?.[1]) prm = await getJson(m[1]);
  } catch {
    /* ігноруємо — спробуємо well-known */
  }
  if (!prm) prm = (await getJson(`${origin}/.well-known/oauth-protected-resource${path}`)) ?? (await getJson(`${origin}/.well-known/oauth-protected-resource`));

  const resource = (typeof prm?.resource === "string" && prm.resource) || mcpUrl;
  const servers = Array.isArray(prm?.authorization_servers) ? (prm!.authorization_servers as string[]) : [origin];
  const scopes = Array.isArray(prm?.scopes_supported) ? (prm!.scopes_supported as string[]) : undefined;

  // 2) Метадані сервера авторизації (з урахуванням шляху в issuer).
  for (const issuer of servers) {
    const iu = new URL(issuer);
    const ipath = iu.pathname.replace(/\/$/, "");
    const candidates = ipath
      ? [`${iu.origin}/.well-known/oauth-authorization-server${ipath}`, `${iu.origin}/.well-known/openid-configuration${ipath}`, `${iu.origin}${ipath}/.well-known/openid-configuration`]
      : [`${iu.origin}/.well-known/oauth-authorization-server`, `${iu.origin}/.well-known/openid-configuration`];
    for (const c of candidates) {
      const as = await getJson(c);
      if (as?.authorization_endpoint && as?.token_endpoint) return { as, resource, scopes };
    }
  }
  throw new Error("Не вдалося знайти сервер авторизації Сільпо");
}

/** Готує вхід: реєструє клієнта (один раз) і повертає адресу сторінки входу Сільпо. */
export async function startAuth(env: Env, appOrigin: string): Promise<string> {
  const redirect_uri = `${appOrigin}/oauth/callback`;
  let client = await loadClient(env);

  if (!client || client.redirect_uri !== redirect_uri) {
    const { as, resource, scopes } = await discover(env.SILPO_MCP_URL);
    const reg = as.registration_endpoint as string | undefined;
    if (!reg) throw new Error("Сільпо не дозволяє реєстрацію застосунків (немає registration_endpoint)");
    const methods = (as.token_endpoint_auth_methods_supported as string[] | undefined) ?? ["none"];
    const wanted = methods.includes("none") ? "none" : methods.includes("client_secret_post") ? "client_secret_post" : "client_secret_basic";
    const r = await fetch(reg, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "Silpopo",
        redirect_uris: [redirect_uri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: wanted,
        ...(scopes?.length ? { scope: scopes.join(" ") } : {}),
      }),
    });
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok || typeof body.client_id !== "string") throw new Error(`Реєстрація в Сільпо не вдалася (HTTP ${r.status}): ${JSON.stringify(body).slice(0, 200)}`);
    client = {
      client_id: body.client_id,
      client_secret: typeof body.client_secret === "string" ? body.client_secret : undefined,
      auth_method: typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : wanted,
      authorization_endpoint: as.authorization_endpoint as string,
      token_endpoint: as.token_endpoint as string,
      redirect_uri,
      resource,
      scope: scopes?.join(" "),
    };
    await setSetting(env.DB, CLIENT_KEY, JSON.stringify(client));
  }

  const pending: Pending = { state: randomString(24), verifier: randomString(48), at: Date.now() };
  await setSetting(env.DB, PENDING_KEY, JSON.stringify(pending));
  await deleteSetting(env.DB, ERROR_KEY);

  const q = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri,
    state: pending.state,
    code_challenge: await s256(pending.verifier),
    code_challenge_method: "S256",
    resource: client.resource,
  });
  if (client.scope) q.set("scope", client.scope);
  return `${client.authorization_endpoint}?${q}`;
}

async function loadClient(env: Env): Promise<ClientInfo | null> {
  const raw = await getSetting(env.DB, CLIENT_KEY);
  return raw ? (JSON.parse(raw) as ClientInfo) : null;
}

async function tokenRequest(client: ClientInfo, params: Record<string, string>): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({ ...params, resource: client.resource });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (client.auth_method === "client_secret_basic" && client.client_secret) {
    headers.authorization = `Basic ${btoa(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`)}`;
  } else {
    body.set("client_id", client.client_id);
    if (client.client_secret) body.set("client_secret", client.client_secret);
  }
  const r = await fetch(client.token_endpoint, { method: "POST", headers, body });
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok || typeof json.access_token !== "string") {
    throw new Error(`Сільпо відхилило токен (HTTP ${r.status}): ${String(json.error_description ?? json.error ?? "").slice(0, 160)}`);
  }
  return json;
}

async function saveTokens(env: Env, t: Record<string, unknown>, keepRefresh?: string | null) {
  const expiresIn = Number(t.expires_in) || 3600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, meta, updated_at)
     VALUES ('silpo', ?1, ?2, ?3, ?4, datetime('now'))
     ON CONFLICT(provider) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at, meta = excluded.meta, updated_at = datetime('now')`,
  )
    .bind(t.access_token as string, (t.refresh_token as string | undefined) ?? keepRefresh ?? null, expiresAt, JSON.stringify({ scope: t.scope ?? null }))
    .run();
}

/** Обробка повернення зі сторінки входу Сільпо. */
export async function finishAuth(env: Env, url: URL): Promise<void> {
  const err = url.searchParams.get("error");
  if (err) throw new Error(`Вхід скасовано: ${url.searchParams.get("error_description") ?? err}`);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const pendingRaw = await getSetting(env.DB, PENDING_KEY);
  const client = await loadClient(env);
  if (!code || !state || !pendingRaw || !client) throw new Error("Неповна відповідь від Сільпо — спробуйте підключити ще раз");
  const pending = JSON.parse(pendingRaw) as Pending;
  if (pending.state !== state) throw new Error("Посилання входу застаріло — спробуйте підключити ще раз");
  if (Date.now() - pending.at > 30 * 60_000) throw new Error("Минуло забагато часу — спробуйте підключити ще раз");

  const t = await tokenRequest(client, { grant_type: "authorization_code", code, redirect_uri: client.redirect_uri, code_verifier: pending.verifier });
  await saveTokens(env, t);
  await deleteSetting(env.DB, PENDING_KEY);
  await deleteSetting(env.DB, ERROR_KEY);
}

/** Дійсний access token; оновлює його, якщо до закінчення менше 2 хвилин. */
export async function accessToken(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT access_token, refresh_token, expires_at FROM oauth_tokens WHERE provider = 'silpo'").first<{
    access_token: string;
    refresh_token: string | null;
    expires_at: string | null;
  }>();
  if (!row) throw new SilpoAuthError("Сільпо ще не підключено: Налаштування → «Підключити Сільпо»");
  const exp = row.expires_at ? Date.parse(row.expires_at) : 0;
  if (exp - Date.now() > 120_000) return row.access_token;
  if (!row.refresh_token) throw new SilpoAuthError("Вхід у Сільпо закінчився — підключіть Сільпо ще раз у налаштуваннях");

  const client = await loadClient(env);
  if (!client) throw new SilpoAuthError("Підключіть Сільпо ще раз у налаштуваннях");
  try {
    const t = await tokenRequest(client, { grant_type: "refresh_token", refresh_token: row.refresh_token });
    await saveTokens(env, t, row.refresh_token);
    return t.access_token as string;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setSetting(env.DB, ERROR_KEY, msg);
    throw new SilpoAuthError("Вхід у Сільпо закінчився — підключіть Сільпо ще раз у налаштуваннях");
  }
}

export class SilpoAuthError extends Error {}

export async function authStatus(env: Env) {
  const row = await env.DB.prepare("SELECT expires_at, refresh_token IS NOT NULL AS can_refresh, updated_at FROM oauth_tokens WHERE provider = 'silpo'").first<{
    expires_at: string | null;
    can_refresh: number;
    updated_at: string;
  }>();
  return {
    connected: !!row && (!!row.can_refresh || (row.expires_at ? Date.parse(row.expires_at) > Date.now() : false)),
    updatedAt: row?.updated_at ?? null,
    error: await getSetting(env.DB, ERROR_KEY),
  };
}

export async function recordAuthError(env: Env, msg: string) {
  await setSetting(env.DB, ERROR_KEY, msg.slice(0, 300));
}

export async function disconnect(env: Env) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_tokens WHERE provider = 'silpo'"),
    env.DB.prepare("DELETE FROM settings WHERE key IN (?1, ?2, ?3)").bind(PENDING_KEY, ERROR_KEY, "silpo_cart_ctx"),
  ]);
}
