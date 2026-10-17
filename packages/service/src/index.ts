// @corridor/service — a thin HTTP layer over the engine. The engine is a
// library; this turns it into a service with the things a real endpoint needs:
// JSON in/out, sensible HTTP status mapping, optional API-key auth, and a simple
// in-memory rate limiter. Zero runtime dependencies — Node's built-in http.
//
// The core is a pure `route()` you can unit-test without binding a socket;
// `server()` is a thin node:http adapter around it.

import {
  createServer as httpCreateServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import * as crypto from "node:crypto";
import type { Corridor } from "@corridor/manifest";
import { execute, type EngineDeps } from "@corridor/engine";
import {
  constantTimeEqual,
  isSettleableAmount,
  type CorridorErrorCode,
  type PaymentIntent,
} from "@corridor/types";

export interface RateLimitOptions {
  /** Bucket size (max burst). */
  capacity: number;
  /** Tokens refilled per second. */
  refillPerSec: number;
}

/**
 * Pluggable rate limiter. The default `TokenBucket` is per-process — fine for a
 * single replica. For multiple replicas, inject a shared implementation (e.g. a
 * Redis token bucket via a Lua script) so the limit is enforced across the
 * fleet rather than per-instance. `take()` may be sync or async (Redis is
 * async). See docs/operations.md §5.
 */
export interface RateLimiter {
  /** Consume one unit for `key`. Return false to reject (429). */
  take(key: string): boolean | Promise<boolean>;
}

export interface ServiceOptions {
  /** Corridor manifests, keyed by corridor id. */
  corridors: Map<string, Corridor>;
  /** Engine dependencies (resolver, submitter, store, …). */
  deps: EngineDeps;
  /** If set, requests must carry `Authorization: Bearer <key>` with a known key. */
  apiKeys?: Set<string>;
  /** If set, requests are rate-limited per client (API key, else resolved client IR)
   *  using the default in-process TokenBucket. Ignored when `rateLimiter` is given. */
  rateLimit?: RateLimitOptions;
  /** Inject a custom (e.g. shared/Redis) limiter. Takes precedence over `rateLimit`. */
  rateLimiter?: RateLimiter;
  /**
   * If set, `GET /metrics` serves Prometheus text exposition (public + unmetered).
   * Pass `() => prometheusMetrics.render()` and hand the SAME `PrometheusMetrics`
   * to the engine as `deps.metrics` so scrapes see live counters/timings.
   */
  metricsText?: () => string;
  /** Max request body size in bytes. Larger bodies are rejected with 413. Default 64 KiB. */
  maxBodyBytes?: number;
  /**
   * Trust `X-Forwarded-For` for the client IP. Default `false`: the header is
   * client-controlled, so trusting it lets an attacker forge a fresh identity
   * per request and slip the rate limiter. Enable ONLY when a trusted reverse
   * proxy (your ingress) sets the header and strips any inbound value. When
   * false, the transport uses the socket's peer address instead.
   */
  trustProxy?: boolean;
  now?: () => number;
}

/** Default cap on a buffered request body. A payment intent is well under 1 KiB. */
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export interface RouteResponse {
  status: number;
  body: unknown;
  /** Defaults to application/json (body is JSON-encoded). Set e.g. text/plain to
   *  send a string body verbatim (used by /metrics). */
  contentType?: string;
}

export interface RouteRequest {
  method: string;
  path: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  /** Resolved client IP from the transport (see `trustProxy`). Used for rate-limit keying. */
  clientIp?: string;
}

const STATUS_BY_CODE: Record<CorridorErrorCode, number> = {
  MANIFEST_INVALID: 422,
  AMOUNT_INVALID: 422,
  QUOTE_UNAVAILABLE: 502,
  QUOTE_EXPIRED: 409,
  KYC_REQUIRED: 409,
  KYC_REJECTED: 403,
  ANCHOR_UNAVAILABLE: 502,
  ROUTE_REFUSED: 503,
  SETTLEMENT_FAILED: 500,
  SETTLEMENT_TIMEOUT: 504,
  REFUND_UNSUPPORTED: 501,
  RECONCILE_MISMATCH: 500,
  RECONCILE_STALLED: 504,
  IDEMPOTENCY_CONFLICT: 409,
  PRESETTLE_ANCHOR_DRIFT: 502,
  PRESETTLE_TX_MISMATCH: 409,
  PRESETTLE_DESTINATION_UNSAFE: 422,
  PRESETTLE_INSUFFICIENT_FUNDS: 422,
  PRESETTLE_QUOTE_WINDOW: 409,
  PRESETTLE_AMOUNT_OUT_OF_RANGE: 422,
  PRESETTLE_RECEIVER_NOT_ACCEPTED: 403,
  CORRIDOR_UNPROVEN: 422,
  // The lane halted itself after repeated failures. 503 rather than 409: the
  // request was well-formed and the same one would be accepted again once the
  // lane is reset, so this is a dependency being unavailable, not a conflict
  // the caller can resolve.
  CORRIDOR_HALTED: 503,
  ENGINE_MISCONFIGURED: 500,
};

/** Token-bucket rate limiter, keyed per client. In-memory; swap for Redis at scale. */
export class TokenBucket implements RateLimiter {
  private readonly state = new Map<string, { tokens: number; last: number }>();
  /**
   * How long an idle bucket takes to refill back to full capacity. Once a bucket
   * has been idle that long it's indistinguishable from a brand-new one, so it
   * can be dropped — this is what bounds memory. `Infinity` when refill is
   * disabled (a drained bucket never recovers, so we must never evict it).
   */
  private readonly fullRefillMs: number;
  private lastSweep = 0;

  constructor(
    private readonly opts: RateLimitOptions,
    private readonly now: () => number,
  ) {
    this.fullRefillMs =
      opts.refillPerSec > 0 ? (opts.capacity / opts.refillPerSec) * 1000 : Infinity;
  }

  take(key: string): boolean {
    const t = this.now();
    // Without eviction the map grows once per distinct client (API key, or a
    // spoofable x-forwarded-for) and never shrinks — an unbounded-memory vector.
    // Sweep at most once per refill window so the cost stays amortized O(1).
    this.evictFullyRefilled(t);
    const s = this.state.get(key) ?? { tokens: this.opts.capacity, last: t };
    s.tokens = Math.min(
      this.opts.capacity,
      s.tokens + ((t - s.last) / 1000) * this.opts.refillPerSec,
    );
    s.last = t;
    const allowed = s.tokens >= 1;
    if (allowed) s.tokens -= 1;
    this.state.set(key, s);
    return allowed;
  }

  /** Drop buckets idle long enough to have fully refilled (behaviour-neutral:
   *  a full bucket and a fresh one are identical). Throttled to one pass per
   *  refill window to keep the hot path cheap. */
  private evictFullyRefilled(t: number): void {
    if (!Number.isFinite(this.fullRefillMs)) return;
    if (t - this.lastSweep < this.fullRefillMs) return;
    this.lastSweep = t;
    for (const [k, s] of this.state) {
      if (t - s.last >= this.fullRefillMs) this.state.delete(k);
    }
  }
}

function isPaymentBody(b: unknown): b is PaymentIntent {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  const amount = o.sourceAmount as Record<string, unknown> | undefined;
  return (
    typeof o.idempotencyKey === "string" &&
    typeof o.corridorId === "string" &&
    typeof (o.sender as Record<string, unknown>)?.id === "string" &&
    typeof (o.recipient as Record<string, unknown>)?.id === "string" &&
    typeof amount?.asset === "string" &&
    typeof amount?.amount === "string"
  );
}

function bearer(headers?: Record<string, string>): string | undefined {
  if (!headers) return undefined;
  const a = headers["authorization"] ?? headers["Authorization"];
  if (!a) return undefined;
  const m = /^Bearer (.+)$/i.exec(a);
  return m ? m[1] : undefined;
}

function matchesKey(keys: Set<string> | undefined, presented: string | undefined): boolean {
  if (!keys) return true;
  if (!presented) return false;
  // Constant-time compare against every known key to avoid a timing oracle.
  let ok = false;
  for (const k of keys) {
    if (constantTimeEqual(k, presented)) ok = true;
  }
  return ok;
}

/** Verifier for SEP-31 callback signatures (HMAC-SHA256 over "t.body"). */
class CallbackVerifier {
  /** Verify a signature header of the form "t=<unix>, s=<base64>". */
  verify(sigHeader: string, rawBody: string, secret: string): boolean {
    const commaAt = sigHeader.indexOf(",");
    const tPart = commaAt < 0 ? "" : sigHeader.slice(0, commaAt).trim();
    const sPart = commaAt < 0 ? "" : sigHeader.slice(commaAt + 1).trim();
    const t = tPart.startsWith("t=") ? tPart.slice(2) : "";
    const s = sPart.startsWith("s=") ? sPart.slice(2) : "";
    if (!t || !s) return false;
    const expected = crypto
      .createHmac("sha256", secret)
      .update(`${t}.${rawBody}`)
      .digest("base64");
    return constantTimeEqual(expected, s);
  }
}

export interface Service {
  route(req: RouteRequest): Promise<RouteResponse>;
  /** A node:http server that delegates to route(). Call .listen(port). */
  server(): ReturnType<typeof httpCreateServer>;
}

export function createService(options: ServiceOptions): Service {
  const now = options.now ?? (() => Date.now());
  const limiter: RateLimiter | undefined =
    options.rateLimiter ??
    (options.rateLimit ? new TokenBucket(options.rateLimit, now) : undefined);
  const cbVerifier = new CallbackVerifier();

  // Rate-limit identity: a VALIDATED API key if present (most specific), else
  // the client IP resolved by the transport.
  //
  // The key must be one we actually recognise. Keying off the raw bearer let a
  // client mint a fresh bucket per request just by rotating the token — with
  // auth disabled (the documented dev mode) the limiter was a no-op, and each
  // forged token also left a map entry behind until the next sweep. An
  // unrecognised bearer now falls through to the IP bucket, which a client
  // cannot forge. Same reasoning as X-Forwarded-For, which server() only honours
  // under `trustProxy`.
  const clientKey = (req: RouteRequest): string => {
    const key = bearer(req.headers);
    if (key && matchesKey(options.apiKeys, key)) return `key:${key}`;
    return `ip:${req.clientIp ?? "anon"}`;
  };

  async function route(req: RouteRequest): Promise<RouteResponse> {
    const headers = req.headers ?? {};
    const path = req.path.replace(/\/+$/, "") || "/";

    // Health is public and unmetered.
    if (req.method === "GET" && path === "/healthz") {
      return { status: 200, body: { status: "ok" } };
    }

    // Metrics are public and unmetered (scrapers don't carry an API key). Only
    // exposed when a renderer is configured.
    if (req.method === "GET" && path === "/metrics" && options.metricsText) {
      return {
        status: 200,
        body: options.metricsText(),
        contentType: "text/plain; version=0.0.4",
      };
    }

    // --- rate limit ---
    // BEFORE auth, deliberately. Returning 401 first meant failed credentials
    // were never metered, so API keys could be brute-forced at line rate — a
    // wrong key cost the attacker nothing. An unrecognised bearer keys to the
    // caller's IP bucket (see clientKey), so guessing is now rate-limited per
    // client while legitimate keyed traffic keeps its own bucket.
    if (limiter && !(await limiter.take(clientKey(req)))) {
      return { status: 429, body: { error: "rate_limited" } };
    }

    // --- auth ---
    const presentedKey = bearer(headers);
    if (options.apiKeys) {
      if (!matchesKey(options.apiKeys, presentedKey)) {
        return { status: 401, body: { error: "unauthorized" } };
      }
    }

    // --- POST /payments ---
    if (req.method === "POST" && path === "/payments") {
      if (!isPaymentBody(req.body)) {
        return { status: 400, body: { error: "invalid payment body" } };
      }
      const intent = req.body;
      // isSettleableAmount, not isValidAmount: the latter is a signed syntax
      // check (subAmounts needs negatives) and let "-100.00" through to the
      // engine, which settled it.
      if (!isSettleableAmount(intent.sourceAmount.amount)) {
        return {
          status: 422,
          body: { error: "AMOUNT_INVALID", message: "amount must be a positive decimal" },
        };
      }
      const corridor = options.corridors.get(intent.corridorId);
      if (!corridor) {
        return { status: 404, body: { error: "unknown corridor" } };
      }
      const out = await execute(intent, corridor, options.deps);
      if (!out.ok) {
        const code = out.error.code as CorridorErrorCode;
        const status = STATUS_BY_CODE[code] ?? 500;
        return {
          status,
          body: { error: code, message: out.error.message },
        };
      }
      return { status: 200, body: out.value };
    }

    // --- GET /payments/:key ---
    if (req.method === "GET" && path.startsWith("/payments/")) {
      const key = path.slice("/payments/".length);
      if (!key) return { status: 404, body: { error: "not found" } };
      const store = options.deps.idempotency;
      if (!store) return { status: 404, body: { error: "not found" } };
      const run = await store.get(key);
      if (!run) return { status: 404, body: { error: "not found" } };
      return {
        status: 200,
        body: {
          idempotencyKey: run.idempotencyKey,
          state: run.state,
          trail: [...run.trail],
          ...(run.transactionId !== undefined && { transactionId: run.transactionId }),
          ...(run.stellarTxHash !== undefined && { stellarTxHash: run.stellarTxHash }),
        },
      };
    }

    return { status: 404, body: { error: "not found" } };
  }

  function server(): ReturnType<typeof httpCreateServer> {
    const maxBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    return httpCreateServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of req) {
          total += chunk.length;
          if (total > maxBytes) {
            res.statusCode = 413;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "payload too large" }));
            req.destroy();
            return;
          }
          chunks.push(chunk as Buffer);
        }
        const rawBody = Buffer.concat(chunks).toString("utf-8");
        let body: unknown = undefined;
        if (rawBody) {
          try {
            body = JSON.parse(rawBody);
          } catch {
            body = undefined;
          }
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === "string") headers[k] = v;
          else if (Array.isArray(v)) headers[k] = v.join(",");
        }
        const clientIp = options.trustProxy
          ? (headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket.remoteAddress
          : req.socket.remoteAddress;
        const out = await route({
          method: req.method ?? "GET",
          path: req.url ?? "/",
          body,
          rawBody,
          headers,
          ...(clientIp !== undefined && { clientIp }),
        });
        res.statusCode = out.status;
        res.setHeader("content-type", out.contentType ?? "application/json");
        res.end(typeof out.body === "string" ? out.body : JSON.stringify(out.body));
      } catch {}
    });
  }

  return { route, server };
}
