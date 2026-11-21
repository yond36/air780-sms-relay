import { HttpError } from "./store.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SESSION_COOKIE = "air780_session";
const SESSION_SECONDS = 8 * 60 * 60;

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value) {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
}

function sha256(text) {
  return crypto.subtle.digest("SHA-256", encoder.encode(text));
}

export async function digest(text) {
  return base64Url(new Uint8Array(await sha256(text)));
}

export function newToken() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export const deviceBearer = (request) => request.headers.get("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1];

export function matchesDigest(hash, expectedHash) {
  if (!hash || !expectedHash) return false;
  let difference = hash.length ^ expectedHash.length;
  for (let index = 0; index < hash.length; index++) {
    difference |= hash.charCodeAt(index) ^ (expectedHash.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function matchesToken(value, expectedHash) {
  return Boolean(value && expectedHash && matchesDigest(await digest(value), expectedHash));
}

function requiredSecret(env, name) {
  const secret = env[name];
  if (typeof secret !== "string" || secret.length === 0 || (name === "APP_SECRET" && secret.length < 32)) {
    throw new HttpError(503, "请先在 Worker 配置管理员密码和应用密钥");
  }
  return secret;
}

async function sessionKey(env) {
  const secret = requiredSecret(env, "APP_SECRET");
  const password = requiredSecret(env, "ADMIN_PASSWORD");
  const key = await sha256(`session\0${secret}\0${password}`);
  return crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function authenticateAdmin(env, supplied) {
  const expected = requiredSecret(env, "ADMIN_PASSWORD");
  if (!await matchesToken(supplied, await digest(expected))) throw new HttpError(401, "管理员密码无效");
}

export async function newSession(env, now = Date.now()) {
  const payload = base64Url(encoder.encode(JSON.stringify({ exp: Math.floor(now / 1000) + SESSION_SECONDS, nonce: newToken() })));
  const signature = await crypto.subtle.sign("HMAC", await sessionKey(env), encoder.encode(payload));
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}

export function sessionCookie(request, token) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/api/v1/admin; Max-Age=${token ? SESSION_SECONDS : 0}; HttpOnly; SameSite=Strict${secure}`;
}

export async function requireAdmin(request, env, now = Date.now()) {
  const key = await sessionKey(env);
  const cookie = request.headers.get("Cookie") ?? "";
  const session = cookie.split(";").map((value) => value.trim()).find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  const match = session?.slice(SESSION_COOKIE.length + 1).match(/^([\w-]{1,256})\.([\w-]{43})$/);
  if (match) {
    const [, payload, signature] = match;
    try {
      if (await crypto.subtle.verify("HMAC", key, fromBase64Url(signature), encoder.encode(payload))) {
        const { exp } = JSON.parse(decoder.decode(fromBase64Url(payload)));
        if (Number.isInteger(exp) && exp > now / 1000) return;
      }
    } catch {
      // Ignore malformed session cookies and request a new login.
    }
  }
  throw new HttpError(401, "请登录管理页");
}

export function requireSameOrigin(request) {
  if (request.method === "GET" || request.method === "HEAD") return;
  const expected = new URL(request.url).origin;
  const origin = request.headers.get("Origin");
  if ((origin && origin !== expected) || request.headers.get("Sec-Fetch-Site") === "cross-site") {
    throw new HttpError(403, "请在管理页所在站点操作");
  }
}

async function configKey(env) {
  const key = await sha256(`channel-config\0${requiredSecret(env, "APP_SECRET")}`);
  return crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function sealConfig(env, id, type, config) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = encoder.encode(`${id}:${type}`);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, await configKey(env), encoder.encode(JSON.stringify(config)));
  return `${base64Url(iv)}.${base64Url(new Uint8Array(encrypted))}`;
}

export async function openConfig(env, id, type, sealed) {
  const key = await configKey(env);
  try {
    const [nonce, data] = sealed.split(".");
    const iv = fromBase64Url(nonce);
    const additionalData = encoder.encode(`${id}:${type}`);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData }, key, fromBase64Url(data));
    return JSON.parse(decoder.decode(plain));
  } catch {
    throw new HttpError(503, "渠道凭据无法解密，请检查应用密钥");
  }
}
