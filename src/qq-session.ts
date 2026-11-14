import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  credentialFromCookie,
  hasQqRenewalMaterial,
  parseQqCredential,
  qqPlaybackCookie,
  type QqCredential,
  type QqLoginClient,
  type QqRefreshResult,
} from "./qq-login.js";

export interface QqSessionRecord {
  cookie: string;
  credential?: QqCredential;
  reauthRequired?: boolean;
  authorizedAt?: number;
  lastRefreshAt?: number;
}

export type QqRenewalStatus = "disabled" | "cookie_only" | "scheduled" | "retrying" | "reauth_required";
export type QqRenewalResult =
  | "refreshed"
  | "reauth_required"
  | "upstream_error"
  | "rate_limited"
  | "persist_failed"
  | "cooldown"
  | "superseded"
  | "disabled";

export interface QqSessionLogger {
  info(data: object, message: string): void;
  warn(data: object, message: string): void;
  warn(message: string): void;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15
    ? value
    : undefined;
}

function expiryTime(credential: QqCredential): number | undefined {
  if (!credential.musickeyCreateTime || !credential.keyExpiresIn) return undefined;
  return timestamp((credential.musickeyCreateTime + credential.keyExpiresIn) * 1000);
}

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Windows does not expose Unix permission bits.
    }
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temporary file was already renamed or did not exist.
    }
  }
}

function readCookieFile(file: string): string | undefined {
  try {
    const cookie = fs.readFileSync(file, "utf8").trim();
    return cookie || undefined;
  } catch {
    return undefined;
  }
}

function loadLegacy(cookieFile: string): QqSessionRecord | undefined {
  const cookie = readCookieFile(cookieFile);
  return cookie ? { cookie, credential: credentialFromCookie(cookie) } : undefined;
}

export function createQqSessionStore(sessionFile: string, cookieFile: string) {
  return {
    load(): QqSessionRecord | undefined {
      const cookieMtime = (() => {
        try {
          return fs.statSync(cookieFile).mtimeMs;
        } catch {
          return -Infinity;
        }
      })();

      let session: QqSessionRecord | undefined;
      let sessionMtime = -Infinity;
      try {
        sessionMtime = fs.statSync(sessionFile).mtimeMs;
        const raw = JSON.parse(fs.readFileSync(sessionFile, "utf8")) as Record<string, unknown>;
        const credential = raw.credential ? parseQqCredential(raw.credential) : undefined;
        if (raw.version !== 1 || typeof raw.cookie !== "string") throw new Error("Invalid QQ session record");
        if (raw.credential && !credential) throw new Error("Invalid QQ session credential");
        session = {
          cookie: raw.cookie,
          credential,
          reauthRequired: raw.reauthRequired === true,
          authorizedAt: timestamp(raw.authorizedAt),
          lastRefreshAt: timestamp(raw.lastRefreshAt),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") session = undefined;
      }

      if (cookieMtime > sessionMtime) return loadLegacy(cookieFile);
      return session ?? loadLegacy(cookieFile);
    },

    save(record: QqSessionRecord): void {
      writeAtomic(cookieFile, `${record.cookie}\n`);
      writeAtomic(sessionFile, `${JSON.stringify({ version: 1, ...record }, null, 2)}\n`);
    },
  };
}

export type QqSessionStore = ReturnType<typeof createQqSessionStore>;

interface PendingSave {
  record: QqSessionRecord;
  result: "refreshed" | "reauth_required";
}

export class QQManagedSession {
  private state: QqSessionRecord = { cookie: "" };
  private generation = 0;
  private inFlight?: Promise<QqRenewalResult>;
  private pending?: PendingSave;
  private timer?: ReturnType<typeof setTimeout>;
  private retryAt?: number;
  private nextAttempt?: number;
  private failures = 0;
  private stopped = false;

  constructor(
    private readonly client: QqLoginClient,
    private readonly store: QqSessionStore,
    private readonly logger: QqSessionLogger,
    private readonly enabled = true,
  ) {
    try {
      const saved = store.load();
      if (saved) this.state = saved;
    } catch (error) {
      logger.warn({ error }, "Could not read QQ managed session");
    }
    this.schedule();
  }

  getCookie(): string {
    return this.state.cookie;
  }

  getStatus(): {
    renewalStatus: QqRenewalStatus;
    nextRefreshAt: string | null;
    lastRefreshAt: string | null;
  } {
    const renewalStatus: QqRenewalStatus = !this.enabled
      ? "disabled"
      : this.retryAt
        ? "retrying"
        : this.state.reauthRequired
          ? "reauth_required"
          : !hasQqRenewalMaterial(this.state.credential)
            ? "cookie_only"
            : "scheduled";
    return {
      renewalStatus,
      nextRefreshAt: this.nextAttempt === undefined ? null : new Date(this.nextAttempt).toISOString(),
      lastRefreshAt: this.state.lastRefreshAt === undefined
        ? null
        : new Date(this.state.lastRefreshAt).toISOString(),
    };
  }

  setCookie(cookie: string): void {
    const credential = credentialFromCookie(cookie);
    const record: QqSessionRecord = {
      cookie: cookie.trim(),
      credential,
      authorizedAt: credential ? Date.now() : undefined,
    };
    this.store.save(record);
    this.state = record;
    this.generation += 1;
    this.inFlight = undefined;
    this.pending = undefined;
    this.retryAt = undefined;
    this.failures = 0;
    this.schedule();
  }

  private schedule(earliest = 0): void {
    clearTimeout(this.timer);
    this.nextAttempt = undefined;
    if (this.stopped || !this.enabled) return;

    const credential = this.state.credential;
    this.nextAttempt = this.retryAt;
    if (this.nextAttempt === undefined && !this.state.reauthRequired && hasQqRenewalMaterial(credential)) {
      const now = Date.now();
      const keyCreatedAt = credential.musickeyCreateTime
        ? timestamp(credential.musickeyCreateTime * 1000)
        : undefined;
      const anchor = this.state.lastRefreshAt ?? this.state.authorizedAt ?? keyCreatedAt;
      const dailyAt = anchor === undefined ? now : Math.min(anchor, now) + DAY;
      const expiresAt = expiryTime(credential);
      const leadTime = Math.min(30 * MINUTE, credential.keyExpiresIn * 100);
      const dueAt = expiresAt === undefined ? dailyAt : Math.min(dailyAt, expiresAt - leadTime);
      this.nextAttempt = Math.max(earliest, now, dueAt);
    }

    if (this.nextAttempt === undefined) return;
    const delay = Math.max(0, Math.min(2 ** 31 - 1, this.nextAttempt - Date.now()));
    this.timer = setTimeout(() => {
      if (this.nextAttempt !== undefined && Date.now() < this.nextAttempt) this.schedule(earliest);
      else void this.refresh();
    }, delay);
    this.timer.unref?.();
  }

  refresh(): Promise<QqRenewalResult> {
    if (!this.enabled) return Promise.resolve("disabled");
    if (this.stopped) return Promise.resolve("superseded");
    if (this.inFlight) return this.inFlight;
    if (this.retryAt && Date.now() < this.retryAt) return Promise.resolve("cooldown");
    if (this.pending) return Promise.resolve(this.commitPending());

    const credential = this.state.credential;
    if (!hasQqRenewalMaterial(credential) || this.state.reauthRequired) {
      return Promise.resolve("reauth_required");
    }

    const generation = this.generation;
    this.inFlight = this.renew(credential, generation).finally(() => {
      if (generation === this.generation) this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async renew(credential: QqCredential, generation: number): Promise<QqRenewalResult> {
    const result = await this.client.refresh(credential).catch(() => ({ status: "upstream_error" } as const));
    if (this.stopped || this.generation !== generation) return "superseded";

    if (result.status === "reauth_required") {
      this.pending = { record: { ...this.state, reauthRequired: true }, result: "reauth_required" };
      return this.commitPending();
    }

    if (result.status === "refreshed") {
      const next = result.credential;
      const renewed = next.musickey !== credential.musickey
        || (expiryTime(next) ?? 0) > (expiryTime(credential) ?? 0)
        || next.refresh_key !== credential.refresh_key
        || next.refresh_token !== credential.refresh_token;
      if (next.musicid === credential.musicid && renewed) {
        this.pending = {
          record: {
            cookie: qqPlaybackCookie(next),
            credential: next,
            reauthRequired: !hasQqRenewalMaterial(next),
          },
          result: "refreshed",
        };
        return this.commitPending();
      }
    }

    const outcome = result.status === "rate_limited" ? "rate_limited" : "upstream_error";
    this.defer(outcome);
    return outcome;
  }

  private commitPending(): QqRenewalResult {
    const pending = this.pending;
    if (!pending) return "upstream_error";
    const record = pending.result === "refreshed"
      ? { ...pending.record, lastRefreshAt: Date.now() }
      : pending.record;
    try {
      this.store.save(record);
    } catch (error) {
      this.defer("persist_failed");
      this.logger.warn({ error, outcome: "persist_failed" }, "QQ session renewal deferred");
      return "persist_failed";
    }
    this.state = record;
    this.pending = undefined;
    this.retryAt = undefined;
    this.failures = 0;
    this.schedule(Date.now() + MINUTE);
    this.logger.info({ outcome: pending.result, musicid: record.credential?.musicid }, "QQ session renewal");
    return pending.result;
  }

  private defer(outcome: "rate_limited" | "upstream_error" | "persist_failed"): void {
    const initialMinutes = outcome === "rate_limited" ? 15 : 5;
    this.retryAt = Date.now() + Math.min(60, initialMinutes * 2 ** this.failures) * MINUTE;
    this.failures += 1;
    this.schedule();
    this.logger.warn({ outcome, retryAt: new Date(this.retryAt).toISOString() }, "QQ session renewal deferred");
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.nextAttempt = undefined;
  }
}

export type RefreshClientResult = QqRefreshResult;
