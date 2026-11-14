import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { AppConfig } from "./config.js";

const secret = "test-secret-0123456789abcdef0123456789";

function config(storageDir: string): AppConfig {
  return {
    port: 0,
    publicDir: path.join(storageDir, "..", "public"),
    docsDir: path.join(storageDir, "..", "docs"),
    storageDir,
    cacheDir: path.join(storageDir, "..", "cache"),
    publicBaseUrl: "https://music.example.test/meting",
    authEnabled: true,
    authSecret: secret,
    cacheEnabled: false,
    cacheTime: 86400,
    qqRenewalEnabled: false,
  };
}

function signature(value: string): string {
  return crypto.createHmac("sha1", secret).update(value).digest("hex");
}

describe("Meting HTTP compatibility", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it("returns the existing song shape and signed resource URLs", async () => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "kez-api-"));
    directories.push(storageDir);
    const qqSession = {
      getCookie: () => "uin=12345; qm_keyst=test-key",
      stop: () => undefined,
    } as never;
    const context = createApp(config(storageDir), {
      qqSession,
      metingFactory: () => ({
        song: async () => JSON.stringify([{
          id: "song-mid",
          name: "Test Song",
          artist: ["Artist"],
          source: "tencent",
          url_id: "song-mid",
          pic_id: "album-mid",
          lyric_id: "song-mid",
        }]),
        playlist: async () => "[]",
        url: async () => JSON.stringify({ url: "https://stream.example.test/song" }),
        pic: async () => JSON.stringify({ url: "https://img.example.test/album" }),
        lyric: async () => JSON.stringify({ lyric: "[00:01.00]Hello", tlyric: "[00:01.00]你好" }),
      } as never),
    });

    const response = await request(context.app)
      .get("/")
      .query({ server: "tencent", type: "song", id: "song-mid" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual([{
      name: "Test Song",
      artist: "Artist",
      url: `https://music.example.test/meting/?server=tencent&type=url&id=song-mid&auth=${signature("tencenturlsong-mid")}`,
      pic: `https://music.example.test/meting/?server=tencent&type=pic&id=album-mid&auth=${signature("tencentpicalbum-mid")}`,
      lrc: `https://music.example.test/meting/?server=tencent&type=lrc&id=song-mid&auth=${signature("tencentlrcsong-mid")}`,
    }]);
    const lyric = await request(context.app)
      .get("/")
      .query({ server: "tencent", type: "lrc", id: "song-mid", auth: signature("tencentlrcsong-mid") });
    expect(lyric.status).toBe(200);
    expect(lyric.text).toContain("[00:01.00]Hello (你好)");
    const audio = await request(context.app)
      .get("/")
      .query({ server: "tencent", type: "url", id: "song-mid", auth: signature("tencenturlsong-mid") });
    expect(audio.status).toBe(302);
    expect(audio.headers.location).toBe("https://stream.example.test/song");
    context.stop();
  });

  it("keeps the signed QQ cookie update endpoint", async () => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "kez-api-"));
    directories.push(storageDir);
    let imported = "";
    const context = createApp(config(storageDir), {
      qqSession: {
        getCookie: () => imported,
        setCookie: (cookie: string) => { imported = cookie; },
        getStatus: () => ({
          renewalStatus: "scheduled",
          nextRefreshAt: "2026-11-15T00:00:00.000Z",
          lastRefreshAt: "2026-11-14T00:00:00.000Z",
        }),
        stop: () => undefined,
      } as never,
    });

    await request(context.app).post("/qqcookie.php").send({ auth: signature("cookie_update"), cookie: "uin=123" }).expect(200);
    expect(imported).toBe("uin=123");
    await request(context.app).post("/qqcookie.php").send({ auth: "bad", cookie: "uin=999" }).expect(403);
    await request(context.app).get("/qqcookie.php").expect(405);
    await request(context.app).post("/neteasecookie.php")
      .send({ auth: signature("cookie_update"), cookie: "MUSIC_U=updated" })
      .expect(200);
    expect(fs.readFileSync(path.join(storageDir, "netease_cookie.txt"), "utf8")).toContain("MUSIC_U=updated");
    context.stop();
  });

  it("returns safe platform login and renewal status for the home page", async () => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "kez-api-"));
    directories.push(storageDir);
    fs.writeFileSync(path.join(storageDir, "netease_cookie.txt"), "MUSIC_U=test");
    const context = createApp(config(storageDir), {
      qqSession: {
        getCookie: () => "uin=12345; qm_keyst=private-key",
        getStatus: () => ({
          renewalStatus: "scheduled",
          nextRefreshAt: "2026-11-15T00:00:00.000Z",
          lastRefreshAt: "2026-11-14T00:00:00.000Z",
        }),
        stop: () => undefined,
      } as never,
    });

    const response = await request(context.app).get("/api/status").expect(200);
    expect(response.body.platforms.netease.loginState).toBe("configured");
    expect(response.body.platforms.tencent).toMatchObject({
      loginState: "configured",
      renewal: {
        renewalStatus: "scheduled",
        nextRefreshAt: "2026-11-15T00:00:00.000Z",
        lastRefreshAt: "2026-11-14T00:00:00.000Z",
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("private-key");
    context.stop();
  });

  it("runs an authenticated immediate QQ renewal test without exposing credentials", async () => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "kez-api-"));
    directories.push(storageDir);
    const context = createApp(config(storageDir), {
      qqSession: {
        refresh: async () => "refreshed",
        getStatus: () => ({
          renewalStatus: "scheduled",
          nextRefreshAt: "2026-11-15T00:00:00.000Z",
          lastRefreshAt: "2026-11-14T00:00:00.000Z",
        }),
        stop: () => undefined,
      } as never,
    });

    await request(context.app)
      .post("/api/qq/refresh-test")
      .send({ auth: "bad" })
      .expect(403);
    const response = await request(context.app)
      .post("/api/qq/refresh-test")
      .send({ auth: signature("qq_refresh_test") })
      .expect(200);
    expect(response.body).toEqual({
      result: "refreshed",
      renewal: {
        renewalStatus: "scheduled",
        nextRefreshAt: "2026-11-15T00:00:00.000Z",
        lastRefreshAt: "2026-11-14T00:00:00.000Z",
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/cookie|token|key/i);
    context.stop();
  });
});
