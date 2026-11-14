import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { credentialFromCookie, qqPlaybackCookie, type QqCredential, type QqLoginClient } from "./qq-login.js";
import { createQqSessionStore, QQManagedSession, type QqSessionLogger } from "./qq-session.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const now = new Date("2026-11-14T00:00:00.000Z");
const first: QqCredential = {
  musicid: 12345,
  musickey: "first-key",
  openid: "openid",
  access_token: "access-token",
  refresh_token: "refresh-token",
  refresh_key: "refresh-key",
  expired_at: 1234,
  musickeyCreateTime: Math.floor(now.valueOf() / 1000),
  keyExpiresIn: 3 * DAY / 1000,
  loginType: 2,
};
const second = { ...first, musickey: "second-key", refresh_token: "second-token" };

const logger: QqSessionLogger = {
  info: vi.fn(),
  warn: vi.fn(),
};

describe("QQ managed session", () => {
  let directory: string;
  let sessionFile: string;
  let cookieFile: string;
  let client: QqLoginClient;
  let session: QQManagedSession;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "kez-qq-"));
    sessionFile = path.join(directory, "tencent_session.json");
    cookieFile = path.join(directory, "tencent_cookie.txt");
    const store = createQqSessionStore(sessionFile, cookieFile);
    store.save({ cookie: qqPlaybackCookie(first), credential: first, authorizedAt: now.valueOf() });
    client = {
      refresh: vi.fn().mockResolvedValue({ status: "refreshed", credential: second }),
    };
    session = new QQManagedSession(client, store, logger);
  });

  afterEach(() => {
    session.stop();
    vi.useRealTimers();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("schedules a daily refresh and restores it after restart", async () => {
    expect(session.getStatus()).toMatchObject({
      renewalStatus: "scheduled",
      nextRefreshAt: new Date(now.valueOf() + DAY).toISOString(),
    });
    await vi.advanceTimersByTimeAsync(DAY);
    expect(client.refresh).toHaveBeenCalledWith(first);
    expect(session.getCookie()).toContain("qm_keyst=second-key");
    expect(JSON.parse(fs.readFileSync(sessionFile, "utf8")).lastRefreshAt).toBe(now.valueOf() + DAY);
  });

  it("uses the earlier expiry deadline for short lived credentials", async () => {
    const short = { ...first, keyExpiresIn: 3600 };
    const store = createQqSessionStore(sessionFile, cookieFile);
    store.save({ cookie: qqPlaybackCookie(short), credential: short, authorizedAt: now.valueOf() });
    session.stop();
    session = new QQManagedSession(client, store, logger);
    await vi.advanceTimersByTimeAsync(54 * MINUTE - 1);
    expect(client.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.refresh).toHaveBeenCalledWith(short);
  });

  it("backs off after rate limiting and keeps the old cookie", async () => {
    vi.mocked(client.refresh).mockResolvedValueOnce({ status: "rate_limited" });
    expect(await session.refresh()).toBe("rate_limited");
    expect(session.getCookie()).toContain("first-key");
    expect(await session.refresh()).toBe("cooldown");
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    expect(client.refresh).toHaveBeenCalledTimes(2);
  });

  it("ignores a late refresh after a manual account replacement", async () => {
    let resolve!: (value: { status: "refreshed"; credential: QqCredential }) => void;
    vi.mocked(client.refresh).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const refresh = session.refresh();
    session.setCookie("uin=999; qm_keyst=manual");
    resolve({ status: "refreshed", credential: second });
    expect(await refresh).toBe("superseded");
    expect(session.getCookie()).toBe("uin=999; qm_keyst=manual");
    expect(await session.refresh()).toBe("reauth_required");
  });

  it("loads the legacy cookie when the structured session is absent", () => {
    session.stop();
    fs.rmSync(sessionFile);
    fs.writeFileSync(cookieFile, [
      "uin=12345",
      "qm_keyst=legacy-key",
      "psrf_qqopenid=openid",
      "psrf_qqaccess_token=access-token",
      "psrf_qqrefresh_token=refresh-token",
      "tmeLoginType=2",
    ].join("; "));
    const store = createQqSessionStore(sessionFile, cookieFile);
    session = new QQManagedSession(client, store, logger);
    expect(session.getCookie()).toContain("legacy-key");
    expect(session.getStatus().renewalStatus).toBe("scheduled");
    expect(credentialFromCookie(session.getCookie())?.musicid).toBe(12345);
  });
});
