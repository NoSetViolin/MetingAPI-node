import { beforeEach, describe, expect, it, vi } from "vitest";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("axios", () => ({
  default: {
    create: () => ({ post }),
    isAxiosError: () => false,
  },
}));

import {
  createQqLoginClient,
  credentialFromCookie,
  parseQqCredential,
  qqPlaybackCookie,
} from "./qq-login.js";

const credential = {
  musicid: 12345,
  musickey: "old-key",
  openid: "openid",
  access_token: "access-token",
  refresh_token: "refresh-token",
  refresh_key: "refresh-key",
  expired_at: 1234,
  musickeyCreateTime: 5678,
  keyExpiresIn: 3600,
  loginType: 2,
};

describe("QQ credential handling", () => {
  beforeEach(() => vi.resetAllMocks());

  it("parses renewal fields from the existing Tencent cookie", () => {
    const parsed = credentialFromCookie([
      "uin=12345",
      "qm_keyst=old-key",
      "psrf_qqopenid=openid",
      "psrf_qqaccess_token=access-token",
      "psrf_qqrefresh_token=refresh-token",
      "psrf_access_token_expiresAt=1234",
      "psrf_musickey_createtime=5678",
      "tmeLoginType=2",
    ].join("; "));
    expect(parsed).toMatchObject({
      musicid: 12345,
      musickey: "old-key",
      openid: "openid",
      access_token: "access-token",
      refresh_token: "refresh-token",
      expired_at: 1234,
      musickeyCreateTime: 5678,
    });
  });

  it("keeps valid fields when QQ returns only rotated values", () => {
    expect(parseQqCredential({ musicid: 12345, musickey: "new-key", refresh_token: "new-token" }, credential)).toMatchObject({
      musicid: 12345,
      musickey: "new-key",
      refresh_token: "new-token",
      openid: "openid",
      access_token: "access-token",
    });
    expect(parseQqCredential({ musicid: 999, musickey: "other-key" }, credential)?.openid).toBe("");
  });

  it("sends the PR refresh payload and accepts a rotated credential", async () => {
    post.mockResolvedValueOnce({
      data: {
        code: 0,
        req_0: { code: 0, data: { musicid: 12345, musickey: "new-key", refresh_token: "new-token" } },
      },
    });
    const result = await createQqLoginClient().refresh(credential);
    expect(result).toMatchObject({ status: "refreshed", credential: { musickey: "new-key" } });
    expect(post).toHaveBeenCalledWith(
      "https://u.y.qq.com/cgi-bin/musicu.fcg",
      expect.objectContaining({
        req_0: {
          module: "music.login.LoginServer",
          method: "Login",
          param: expect.objectContaining({
            openid: "openid",
            access_token: "access-token",
            refresh_token: "refresh-token",
            expired_in: 1234,
            musicid: 12345,
            musickey: "old-key",
            refresh_key: "refresh-key",
            loginMode: 2,
          }),
        },
      }),
      expect.anything(),
    );
  });

  it("classifies rate limiting and reauthentication errors", async () => {
    post.mockResolvedValueOnce({ data: { code: 0, req_0: { code: 104604, data: {} } } });
    expect(await createQqLoginClient().refresh(credential)).toEqual({ status: "rate_limited" });
    post.mockResolvedValueOnce({ data: { code: 0, req_0: { code: 104401, data: {} } } });
    expect(await createQqLoginClient().refresh(credential)).toEqual({ status: "reauth_required" });
  });

  it("creates the minimal playback cookie used by Meting", () => {
    expect(qqPlaybackCookie(credential)).toBe(
      "uin=12345; qqmusic_uin=12345; qm_keyst=old-key; qqmusic_key=old-key; login_type=2; tmeLoginType=2",
    );
  });
});
