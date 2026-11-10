// Minimal, dependency-free HTTP layer: routing, JSON bodies, API-key auth,
// per-client rate limiting and consistent error responses.
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: () => Promise<unknown>;
  rawBody: () => Promise<Buffer>;
};

export type Handler = (ctx: Ctx) => Promise<Reply> | Reply;

export type Reply =
  | { status?: number; json: unknown }
  | { status?: number; text: string; contentType: string; headers?: Record<string, string> };

type Route = { method: string; regex: RegExp; keys: string[]; handler: Handler; public: boolean };

export type RouterOptions = {
  apiKey?: string;
  rateLimitPerMinute: number;
  maxBodyBytes: number;
  /** Use the left-most X-Forwarded-For hop as the client id. Only enable behind a trusted reverse proxy. */
  trustProxy?: boolean;
  log?: (msg: string, extra?: unknown) => void;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Refuse to expose an unauthenticated API. Without API_KEY the service may only
 * listen on a loopback address (local development).
 */
export function assertAuthConfigured(host: string, apiKey: string | undefined) {
  if (apiKey) {
    if (apiKey.length < 16) throw new Error("API_KEY must be at least 16 characters. Generate one with: node -e \"console.log(crypto.randomUUID())\"");
    return;
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `API_KEY is not set but HOST is ${host}. Set API_KEY, or set HOST=127.0.0.1 to run unauthenticated on this machine only.`,
    );
  }
}

export class Router {
  private routes: Route[] = [];
  private opts: RouterOptions;
  private limiter: RateLimiter;

  constructor(opts: RouterOptions) {
    this.opts = opts;
    this.limiter = new RateLimiter(opts.rateLimitPerMinute, 60_000);
  }

  /** Register a route. `public` routes skip API-key auth (health check, UI). */
  on(method: string, path: string, handler: Handler, options: { public?: boolean } = {}) {
    const keys: string[] = [];
    const pattern = path.replace(/:([a-zA-Z_]+)/g, (_m, k: string) => {
      keys.push(k);
      return "([^/]+)";
    });
    this.routes.push({ method, regex: new RegExp(`^${pattern}/?$`), keys, handler, public: !!options.public });
    return this;
  }

  handle = async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const match = this.match(req.method ?? "GET", url.pathname);
      if (!match) throw new HttpError(404, "not_found", `No route for ${req.method} ${url.pathname}`);
      const { route, params } = match;

      if (!route.public) {
        // Rate-limit before checking the key so failed key guesses are counted too.
        if (!this.limiter.take(clientId(req, !!this.opts.trustProxy))) {
          res.setHeader("retry-after", "60");
          throw new HttpError(429, "rate_limited", "Too many requests. Please wait a minute and try again.");
        }
        this.checkApiKey(req);
      }

      let cached: Buffer | undefined;
      const rawBody = async () => (cached ??= await readBody(req, this.opts.maxBodyBytes));
      const ctx: Ctx = {
        req,
        res,
        params,
        query: url.searchParams,
        rawBody,
        body: async () => {
          const buf = await rawBody();
          if (buf.length === 0) return {};
          const type = req.headers["content-type"] ?? "";
          if (!type.includes("application/json")) {
            throw new HttpError(415, "unsupported_media_type", "Send the request body as application/json.");
          }
          try {
            return JSON.parse(buf.toString("utf8"));
          } catch {
            throw new HttpError(400, "invalid_json", "Request body is not valid JSON.");
          }
        },
      };
      const reply = await route.handler(ctx);
      send(res, reply);
    } catch (err) {
      const { status, body } = toErrorBody(err);
      // Unexpected errors get a stack trace; expected HttpErrors just a one-liner.
      if (status >= 500) this.opts.log?.(`${req.method} ${url.pathname} failed: ${(err as Error)?.message}`, err instanceof HttpError ? undefined : err);
      send(res, { status, json: body });
    } finally {
      this.opts.log?.(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  };

  private match(method: string, pathname: string) {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params: Record<string, string> = {};
      for (const [i, k] of route.keys.entries()) {
        try {
          params[k] = decodeURIComponent(m[i + 1]);
        } catch {
          throw new HttpError(400, "invalid_path", "The URL contains an invalid percent-encoding.");
        }
      }
      return { route, params };
    }
    if (pathMatched) throw new HttpError(405, "method_not_allowed", `${method} is not allowed on ${pathname}`);
    return null;
  }

  private checkApiKey(req: IncomingMessage) {
    const expected = this.opts.apiKey;
    if (!expected) return; // auth disabled (local development) — warned at startup
    const header = req.headers["x-api-key"];
    const given = Array.isArray(header) ? header[0] : header;
    if (!given || !safeEqual(given, expected)) {
      throw new HttpError(401, "unauthorized", "Missing or invalid x-api-key header.");
    }
  }
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function clientId(req: IncomingMessage, trustProxy: boolean) {
  // X-Forwarded-For is client-controlled; only honour it behind a trusted proxy (TRUST_PROXY=true).
  if (trustProxy) {
    const fwd = req.headers["x-forwarded-for"];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || "unknown";
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "payload_too_large", `Request body exceeds ${limit} bytes.`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, reply: Reply) {
  if (res.headersSent) return;
  res.statusCode = reply.status ?? 200;
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-frame-options", "DENY");
  if ("json" in reply) res.setHeader("cache-control", "no-store");
  if ("json" in reply) {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(reply.json));
  } else {
    res.setHeader("content-type", reply.contentType);
    for (const [k, v] of Object.entries(reply.headers ?? {})) res.setHeader(k, v);
    res.end(reply.text);
  }
}

export function toErrorBody(err: unknown): { status: number; body: { error: { code: string; message: string; details?: unknown } } } {
  if (err instanceof HttpError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message, details: err.details } } };
  }
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: "validation_failed",
          message: "Request validation failed.",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      },
    };
  }
  return { status: 500, body: { error: { code: "internal_error", message: "Unexpected server error." } } };
}

/** Fixed-window rate limiter keyed by client id. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private limit: number;
  private windowMs: number;
  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  take(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.hits.size > 10_000) this.prune(now);
      return true;
    }
    if (entry.count >= this.limit) return false;
    entry.count++;
    return true;
  }
  private prune(now: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
