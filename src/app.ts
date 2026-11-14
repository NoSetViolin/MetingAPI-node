import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Express, type Request, type Response } from "express";
import Meting from "@meting/core";
import type { AppConfig } from "./config.js";
import { createQqLoginClient } from "./qq-login.js";
import { createQqSessionStore, QQManagedSession, type QqSessionLogger } from "./qq-session.js";

type MetingApi = Meting;
type MetingFactory = (server: "netease" | "tencent", cookie: string) => MetingApi;

const logger: QqSessionLogger = {
  info(data, message) {
    console.info(JSON.stringify({ level: "info", ...data, message }));
  },
  warn(dataOrMessage: object | string, message?: string) {
    if (typeof dataOrMessage === "string") {
      console.warn(JSON.stringify({ level: "warn", message: dataOrMessage }));
      return;
    }
    console.warn(JSON.stringify({ level: "warn", ...dataOrMessage, message }));
  },
};

export interface AppDependencies {
  metingFactory?: MetingFactory;
  qqSession?: QQManagedSession;
}

export interface AppContext {
  app: Express;
  qqSession: QQManagedSession;
  stop(): void;
}

function fileUpdatedAt(file: string): string | null {
  try {
    return new Date(fs.statSync(file).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

function createMeting(server: "netease" | "tencent", cookie: string): MetingApi {
  const api = new Meting(server);
  api.format(true);
  if (cookie) api.cookie(cookie);
  return api;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function formatDate(date = new Date()): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function hmac(value: string, secret: string): string {
  return crypto.createHmac("sha1", secret).update(value).digest("hex");
}

function sameSecret(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function hasAuthSecret(config: AppConfig): boolean {
  return config.authSecret.length >= 32;
}

function queryString(req: Request): string {
  return req.originalUrl.split("?", 1)[0];
}

function joinUrlPath(left: string, right: string): string {
  const leftPart = left.replace(/\/+$/, "");
  const rightPart = right.replace(/^\/+/, "");
  return rightPart ? `${leftPart}/${rightPart}` : `${leftPart}/`;
}

function apiUri(req: Request, config: AppConfig): string {
  if (config.publicBaseUrl) return joinUrlPath(config.publicBaseUrl, queryString(req));

  const forwardedBase = req.header("x-forwarded-base");
  if (forwardedBase) return joinUrlPath(forwardedBase, queryString(req));

  const protocol = req.header("x-forwarded-proto")?.split(",", 1)[0].trim()
    || (req.protocol === "https" ? "https" : "http");
  const forwardedHost = req.header("x-forwarded-host")?.split(",", 1)[0].trim() || req.get("host") || "localhost";
  const forwardedPath = req.header("x-forwarded-path")?.split(",", 1)[0].trim() || "/meting/";
  const forwardedPort = Number(req.header("x-forwarded-port"));
  let host = forwardedHost;
  if (Number.isInteger(forwardedPort) && forwardedPort > 0 && !host.includes(":")) {
    const standardPort = protocol === "https" ? 443 : 80;
    if (forwardedPort !== standardPort) host += `:${forwardedPort}`;
  }
  return `${protocol}://${host}${joinUrlPath(forwardedPath, queryString(req))}`;
}

function resourceUrl(base: string, server: string, type: string, id: string, config: AppConfig): string {
  const url = new URL(base);
  url.search = new URLSearchParams({ server, type, id }).toString();
  if (config.authEnabled) url.searchParams.set("auth", hmac(`${server}${type}${id}`, config.authSecret));
  return url.toString();
}

function readCookie(file: string): string {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function writeCookie(file: string, cookie: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${cookie.trim()}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
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

function lyricText(data: { lyric?: string; tlyric?: string }): string {
  const lyric = data.lyric ?? "";
  if (!lyric) return "[00:00.00]这似乎是一首纯音乐呢，请尽情欣赏它吧！";
  const translated = data.tlyric ?? "";
  if (!translated) return lyric;

  const translatedLines = new Map<string, string>();
  for (const line of translated.split("\n")) {
    if (!line) continue;
    const separator = line.indexOf("]");
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).replace(/\s{2,}/g, " ").trim();
    translatedLines.set(key, value);
  }

  return lyric.split("\n").map((line) => {
    if (!line) return line;
    const separator = line.indexOf("]");
    const key = separator >= 0 ? line.slice(0, separator) : "";
    const translation = translatedLines.get(key);
    if (!translation || translation === "//") return line;
    translatedLines.delete(key);
    return `${line} (${translation})`;
  }).join("\n");
}

function songLinks(song: Record<string, unknown>, base: string, config: AppConfig) {
  const source = String(song.source ?? "netease");
  return {
    name: String(song.name ?? ""),
    artist: Array.isArray(song.artist) ? song.artist.join("/") : String(song.artist ?? ""),
    url: resourceUrl(base, source, "url", String(song.url_id ?? song.id ?? ""), config),
    pic: resourceUrl(base, source, "pic", String(song.pic_id ?? song.id ?? ""), config),
    lrc: resourceUrl(base, source, "lrc", String(song.lyric_id ?? song.id ?? ""), config),
  };
}

async function handleQuery(
  req: Request,
  res: Response,
  config: AppConfig,
  qqSession: QQManagedSession,
  metingFactory: MetingFactory,
): Promise<void> {
  const type = typeof req.query.type === "string" ? req.query.type : "";
  const id = typeof req.query.id === "string" ? req.query.id : "";
  if (!type || !id) {
    const indexFile = path.join(config.publicDir, "index.html");
    if (fs.existsSync(indexFile)) {
      res.sendFile(indexFile);
      return;
    }
    const base = apiUri(req, config);
    res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Meting API</title><h1>Meting API</h1><p>API: <a href="${base}?type=song&amp;id=591321">${base}?type=song&amp;id=591321</a></p>`);
    return;
  }

  const server = req.query.server === "tencent" ? "tencent" : "netease";
  if (config.authEnabled && ["url", "pic", "lrc"].includes(type)) {
    const supplied = typeof req.query.auth === "string" ? req.query.auth : "";
    const expected = hmac(`${server}${type}${id}`, config.authSecret);
    if (!sameSecret(supplied, expected)) {
      res.status(403).end();
      return;
    }
  }

  if (["song", "playlist"].includes(type)) res.type("application/json");
  if (["name", "lrc", "artist"].includes(type)) res.type("text/plain");

  const cookie = server === "tencent"
    ? qqSession.getCookie()
    : readCookie(path.join(config.storageDir, "netease_cookie.txt"));
  const api = metingFactory(server, cookie);
  const base = apiUri(req, config);

  try {
    if (type === "playlist") {
      const cacheFile = path.join(config.cacheDir, "playlist", `${server}_${id}.json`);
      if (config.cacheEnabled) {
        try {
          const stats = fs.statSync(cacheFile);
          if (Date.now() - stats.ctimeMs < config.cacheTime * 1000) {
            res.type("application/json").send(fs.readFileSync(cacheFile, "utf8"));
            return;
          }
        } catch {
          // Cache miss.
        }
      }

      const songs = parseJson<unknown>(await api.playlist(id));
      if (!Array.isArray(songs) || songs.length === 0) {
        res.type("application/json").send('{"error":"unknown playlist id"}');
        return;
      }
      const playlist = songs.map((song) => songLinks(song as Record<string, unknown>, base, config));
      const payload = JSON.stringify(playlist);
      if (config.cacheEnabled) {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        writeCookie(cacheFile, payload);
      }
      res.type("application/json").send(payload);
      return;
    }

    if (!["name", "artist", "song", "url", "pic", "lrc"].includes(type)) {
      res.type("application/json").send('{"error":"unknown type"}');
      return;
    }

    if (type === "url") {
      const data = parseJson<{ url?: string }>(await api.url(id, 320));
      const target = data.url ?? "";
      if (!target) {
        res.end();
        return;
      }
      res.redirect(target.startsWith("http:") && server === "netease" ? target.replace(/^http:/, "https:") : target);
      return;
    }

    if (type === "pic") {
      const data = parseJson<{ url?: string }>(await api.pic(id, 90));
      if (!data.url) {
        res.end();
        return;
      }
      res.redirect(data.url);
      return;
    }

    const song = parseJson<unknown>(await api.song(id));
    if (!Array.isArray(song) || song.length === 0) {
      res.type("application/json").send('{"error":"unknown song"}');
      return;
    }
    const songData = song[0] as Record<string, unknown>;
    if (type === "name") {
      res.type("text/plain").send(String(songData.name ?? ""));
      return;
    }
    if (type === "artist") {
      res.type("text/plain").send(Array.isArray(songData.artist) ? songData.artist.join("/") : String(songData.artist ?? ""));
      return;
    }
    if (type === "song") {
      res.type("application/json").send(JSON.stringify([songLinks(songData, base, config)]));
      return;
    }

    const lyric = parseJson<{ lyric?: string; tlyric?: string }>(await api.lyric(id));
    res.type("text/plain").send(lyricText(lyric));
  } catch (error) {
    console.error(JSON.stringify({ level: "error", type, server, error: String(error) }));
    res.status(502).json({ error: "upstream request failed" });
  }
}

export function createApp(config: AppConfig, dependencies: AppDependencies = {}): AppContext {
  fs.mkdirSync(config.storageDir, { recursive: true });
  const cookieFile = path.join(config.storageDir, "tencent_cookie.txt");
  const sessionFile = path.join(config.storageDir, "tencent_session.json");
  const qqSession = dependencies.qqSession ?? new QQManagedSession(
    createQqLoginClient(),
    createQqSessionStore(sessionFile, cookieFile),
    logger,
    config.qqRenewalEnabled,
  );
  const metingFactory = dependencies.metingFactory ?? createMeting;
  const app = express();

  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST");
    next();
  });

  app.use(express.json({ limit: "128kb" }));

  app.get("/api/status", (_req, res) => {
    const neteaseCookieFile = path.join(config.storageDir, "netease_cookie.txt");
    const tencentCookieFile = path.join(config.storageDir, "tencent_cookie.txt");
    const neteaseCookie = readCookie(neteaseCookieFile);
    const tencentCookie = qqSession.getCookie();
    const renewal = qqSession.getStatus();
    const qqLoginState = !tencentCookie
      ? "missing"
      : renewal.renewalStatus === "reauth_required"
        ? "reauth_required"
        : "configured";

    res.setHeader("Cache-Control", "no-store");
    res.json({
      generatedAt: new Date().toISOString(),
      platforms: {
        netease: {
          loginState: neteaseCookie ? "configured" : "missing",
          cookieUpdatedAt: fileUpdatedAt(neteaseCookieFile),
        },
        tencent: {
          loginState: qqLoginState,
          cookieUpdatedAt: fileUpdatedAt(tencentCookieFile),
          renewal,
        },
      },
    });
  });

  app.post("/api/qq/refresh-test", async (req, res) => {
    if (!hasAuthSecret(config)) {
      res.status(503).json({ error: "AUTH_SECRET is not configured" });
      return;
    }

    const body = req.body as { auth?: unknown };
    if (typeof body.auth !== "string" || !sameSecret(body.auth, hmac("qq_refresh_test", config.authSecret))) {
      res.status(403).json({ error: "Invalid auth" });
      return;
    }

    const result = await qqSession.refresh();
    res.json({ result, renewal: qqSession.getStatus() });
  });

  app.use("/docs", express.static(config.docsDir));
  app.use(express.static(config.publicDir, { index: false }));

  app.all(["/qqcookie.php", "/neteasecookie.php"], (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }
    if (!hasAuthSecret(config)) {
      res.status(503).send("AUTH_SECRET is not configured");
      return;
    }

    const body = req.body as { auth?: unknown; cookie?: unknown };
    if (typeof body.auth !== "string" || !sameSecret(body.auth, hmac("cookie_update", config.authSecret))) {
      res.status(403).send("Invalid auth");
      return;
    }
    if (typeof body.cookie !== "string" || !body.cookie.trim()) {
      res.status(400).send("Cookie is required");
      return;
    }

    try {
      if (req.path === "/qqcookie.php") {
        qqSession.setCookie(body.cookie);
      } else {
        writeCookie(path.join(config.storageDir, "netease_cookie.txt"), body.cookie);
      }
      res.send(`Cookie updated: ${formatDate()}`);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", endpoint: req.path, error: String(error) }));
      res.status(500).send("Save failed");
    }
  });

  app.get(/.*/, (req, res) => {
    void handleQuery(req, res, config, qqSession, metingFactory);
  });

  return {
    app,
    qqSession,
    stop() {
      qqSession.stop();
    },
  };
}
