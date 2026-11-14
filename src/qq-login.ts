import axios from "axios";

export interface QqCredential {
  musicid: number;
  musickey: string;
  openid: string;
  access_token: string;
  refresh_token: string;
  refresh_key: string;
  expired_at: number;
  musickeyCreateTime: number;
  keyExpiresIn: number;
  loginType: number;
}

export type QqRefreshResult =
  | { status: "refreshed"; credential: QqCredential }
  | { status: "reauth_required" | "rate_limited" | "upstream_error" };

export interface QqLoginClient {
  refresh(credential: QqCredential): Promise<QqRefreshResult>;
}

const AUTH_REJECTED = new Set([
  1000, 104400, 104401, 20261, 20271, 20272, 20274, 20277, 20278, 20279, 20450,
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function token(value: unknown): string {
  return typeof value === "string" && /^[\x21-\x3a\x3c-\x7e]+$/.test(value) ? value : "";
}

function positiveInt(value: unknown): number {
  const numberValue = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof numberValue === "number" && Number.isSafeInteger(numberValue) && numberValue > 0
    ? numberValue
    : 0;
}

export function parseQqCredential(value: unknown, previous?: QqCredential): QqCredential | undefined {
  const data = record(value);
  const loginType = data.loginType ?? data.login_type;
  if (loginType !== undefined && loginType !== 2 && loginType !== "2") return undefined;

  const musicid = positiveInt(data.musicid) || positiveInt(data.str_musicid);
  const musickey = token(data.musickey);
  if (!musicid || !musickey) return undefined;

  const sameAccount = previous?.musicid === musicid ? previous : undefined;
  const sameKey = sameAccount?.musickey === musickey ? sameAccount : undefined;
  return {
    musicid,
    musickey,
    openid: token(data.openid ?? sameAccount?.openid),
    access_token: token(data.access_token ?? sameAccount?.access_token),
    refresh_token: token(data.refresh_token ?? sameAccount?.refresh_token),
    refresh_key: token(data.refresh_key ?? sameAccount?.refresh_key),
    expired_at: positiveInt(data.expired_at ?? sameAccount?.expired_at),
    musickeyCreateTime: positiveInt(data.musickeyCreateTime ?? sameKey?.musickeyCreateTime),
    keyExpiresIn: positiveInt(data.keyExpiresIn ?? sameKey?.keyExpiresIn),
    loginType: 2,
  };
}

export function parseCookie(cookie: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && value) values.set(name, value);
  }
  return values;
}

export function credentialFromCookie(cookie: string): QqCredential | undefined {
  const values = parseCookie(cookie);
  return parseQqCredential({
    musicid: values.get("uin"),
    musickey: values.get("qm_keyst") ?? values.get("qqmusic_key"),
    openid: values.get("psrf_qqopenid"),
    access_token: values.get("psrf_qqaccess_token"),
    refresh_token: values.get("psrf_qqrefresh_token"),
    expired_at: values.get("psrf_access_token_expiresAt"),
    musickeyCreateTime: values.get("psrf_musickey_createtime"),
    loginType: values.get("tmeLoginType") ?? values.get("login_type"),
  });
}

export function hasQqRenewalMaterial(credential?: QqCredential): credential is QqCredential {
  return Boolean(credential?.refresh_key || (
    credential?.openid && credential.access_token && credential.refresh_token
  ));
}

export function qqPlaybackCookie(credential: QqCredential): string {
  return [
    `uin=${credential.musicid}`,
    `qqmusic_uin=${credential.musicid}`,
    `qm_keyst=${credential.musickey}`,
    `qqmusic_key=${credential.musickey}`,
    "login_type=2",
    "tmeLoginType=2",
  ].join("; ");
}

function hash33(value: string, seed: number): number {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33 + value.charCodeAt(index)) | 0;
  }
  return hash & 0x7fffffff;
}

export function createQqLoginClient(): QqLoginClient {
  const http = axios.create({ timeout: 10000 });

  async function musicu(credential: QqCredential) {
    const gTk = String(hash33(credential.musickey, 5381));
    const response = await http.post("https://u.y.qq.com/cgi-bin/musicu.fcg", {
      comm: {
        ct: "24",
        cv: "4747474",
        platform: "yqq.json",
        chid: "0",
        uin: String(credential.musicid),
        g_tk: gTk,
        g_tk_new_20200303: gTk,
        format: "json",
        inCharset: "utf-8",
        outCharset: "utf-8",
        notice: "0",
        need_new_code: "1",
        tmeLoginType: "2",
      },
      req_0: {
        module: "music.login.LoginServer",
        method: "Login",
        param: {
          openid: credential.openid,
          access_token: credential.access_token,
          refresh_token: credential.refresh_token,
          expired_in: credential.expired_at,
          musicid: credential.musicid,
          musickey: credential.musickey,
          refresh_key: credential.refresh_key,
          loginMode: 2,
        },
      },
    }, { headers: { Referer: "https://y.qq.com/" } });

    const body = record(response.data);
    const item = record(body.req_0);
    return {
      code: typeof body.code === "number" && body.code !== 0 ? body.code : item.code,
      data: item.data,
    };
  }

  return {
    async refresh(credential) {
      try {
        const result = await musicu(credential);
        const code = Number(result.code ?? 0);
        if (code === 104604 || code === 2001) return { status: "rate_limited" };
        if (AUTH_REJECTED.has(code)) return { status: "reauth_required" };
        const next = result.code === 0 ? parseQqCredential(result.data, credential) : undefined;
        if (next) return { status: "refreshed", credential: next };
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 429) {
          return { status: "rate_limited" };
        }
      }
      return { status: "upstream_error" };
    },
  };
}
