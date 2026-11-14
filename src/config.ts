import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MIN_AUTH_SECRET_LENGTH = 32;

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function integerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export interface AppConfig {
  port: number;
  publicDir: string;
  docsDir: string;
  storageDir: string;
  cacheDir: string;
  publicBaseUrl: string;
  authEnabled: boolean;
  authSecret: string;
  cacheEnabled: boolean;
  cacheTime: number;
  qqRenewalEnabled: boolean;
}

export function loadConfig(): AppConfig {
  const storageDir = path.resolve(process.env.STORAGE_DIR ?? path.join(projectRoot, "storage"));
  const authEnabled = booleanEnv("AUTH", false);
  const authSecret = process.env.AUTH_SECRET?.trim() ?? "";
  if (authEnabled && authSecret.length < MIN_AUTH_SECRET_LENGTH) {
    throw new Error(`AUTH_SECRET must contain at least ${MIN_AUTH_SECRET_LENGTH} characters when AUTH is enabled`);
  }

  return {
    port: integerEnv("PORT", 11446),
    publicDir: path.join(projectRoot, "public"),
    docsDir: path.join(projectRoot, "docs"),
    storageDir,
    cacheDir: path.resolve(process.env.CACHE_DIR ?? path.join(storageDir, "..", "cache")),
    publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, ""),
    authEnabled,
    authSecret,
    cacheEnabled: booleanEnv("CACHE", false),
    cacheTime: integerEnv("CACHE_TIME", 86400),
    qqRenewalEnabled: booleanEnv("QQ_MUSIC_RENEWAL", true),
  };
}
