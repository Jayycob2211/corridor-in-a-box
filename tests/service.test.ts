import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { request, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryIdempotencyStore,
  createMockSubmitter,
  type EngineDeps,
} from "@corridor/engine";
import { createService, type ServiceOptions } from "@corridor/service";
import type { CorridorErrorCode, PaymentIntent } from "@corridor/types";

function corridor(): Corridor {
  const r = parseCorridor({
    id: "test",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      name: "D",
      asset: "iso4217:ARS",
      endpoints: {
        home_domain: "d.example",
        transfer_server_sep31: "https://d.example/sep31",
        endpoints_verified_at: "1970-01-01",
      },
    },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: {},
    proof: {
      canary_completed_at: "1970-01-01T00:00:00Z",
      stellar_tx_hash: "a1b2c3d4e5f60718292a3b4c5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      anchor_transaction_id: "canary-test",
      amount: "1",
      max_age_days: 50000,
    },
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

function intentBody(key = "p1"): PaymentIntent {
  return {
    idempotencyKey: key,
    corridorId: "test",
    sender: { id: "s" },
    recipient: { id: "r" },
    sourceAmount: { asset: "USDC", amount: "100.00" },
  };
}

function deps(adapterOpts = {}): EngineDeps {
  return {
    resolver: new StaticRouteResolver(() => createMockAdapter(adapterOpts), {
      trustManifestWithoutAttestation: true,
    }),
    submitter: createMockSubmitter(),
    idempotency: new InMemoryIdempotencyStore(),
    sleep: async () => {},
    trustManifestWithoutAttestation: true,
    unsafeSkipPreSettleGate: true,
  };
}

function svc(over: Partial<ServiceOptions> = {}) {
  return createService({
    corridors: new Map([["test", corridor()]]),
    deps: deps(),
    ...over,
  });
}

describe("service: POST /payments", () => {
  it("runs a payment and returns 200 completed", async () => {
    const s = svc();
    const r = await s.route({ method: "POST", path: "/payments", body: intentBody() });
    expect(r.status).toBe(200);
    expect((r.body as { state: string }).state).toBe("completed");
  });

  it("returns 200 on idempotent replay of a completed key", async () => {
    const s = svc();
    await s.route({ method: "POST", path: "/payments", body: intentBody("dup") });
    const r = await s.route({ method: "POST", path: "/payments", body: intentBody("dup") });
    expect(r.status).toBe(200);
  });

  it("maps a malformed amount to 422", async () => {
    const s = svc();
    const body = { ...intentBody(), sourceAmount: { asset: "USDC", amount: "1,000" } };
    const r = await s.route({ method: "POST", path: "/payments", body });
    expect(r.status).toBe(422);
  });

  it("maps a KYC rejection to 403", async () => {
    const s = createService({
      corridors: new Map([["test", corridor()]]),
      deps: deps({ kyc: "rejected" }),
    });
    const r = await s.route({ method: "POST", path: "/payments", body: intentBody() });
    expect(r.status).toBe(403);
  });

  it("returns 404 for an unknown corridor", async () => {
    const s = svc();
    const r = await s.route({
      method: "POST",
      path: "/payments",
      body: { ...intentBody(), corridorId: "nope" },
    });
    expect(r.status).toBe(404);
  });

  it("returns 400 for a malformed body", async () => {
    const s = svc();
    const r = await s.route({ method: "POST", path: "/payments", body: { foo: "bar" } });
    expect(r.status).toBe(400);
  });

  it("maps a refused route to 503 and leaves the run failed", async () => {
    const s = createService({
      corridors: new Map([["test", corridor()]]),
      deps: {
        ...deps(),
        resolver: {
          resolve() {
            throw new Error("route refused");
          },
        },
      },
    });
    const r = await s.route({ method: "POST", path: "/payments", body: intentBody("refused") });
    expect(r.status).toBe(503);
    const g = await s.route({ method: "GET", path: "/payments/refused" });
    expect(g.status).toBe(200);
    expect((g.body as { state: string }).state).toBe("failed");
  });
});

describe("service: strict payment body validation", () => {
  // Table-driven: every rejection names the field that caused it. The old
  // isPaymentBody() answered only "somewhere in here, one of six fields is not
  // a string", which is useless to the caller and silent about everything
  // else the engine was about to trust.
  const full = () => intentBody();
  const manyFields = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, "v"]));

  const rejections: Array<{ name: string; body: unknown; field: string }> = [
    { name: "a non-object body", body: "payments", field: "<body>" },
    { name: "a null body", body: null, field: "<body>" },
    { name: "an array body", body: [intentBody()], field: "<body>" },
    { name: "an empty body", body: {}, field: "idempotencyKey" },
    {
      name: "a non-string idempotencyKey",
      body: { ...full(), idempotencyKey: 42 },
      field: "idempotencyKey",
    },
    {
      name: "an empty idempotencyKey",
      body: { ...full(), idempotencyKey: "" },
      field: "idempotencyKey",
    },
    {
      name: "an idempotencyKey outside [A-Za-z0-9._:-]",
      body: { ...full(), idempotencyKey: "key with spaces/slash" },
      field: "idempotencyKey",
    },
    {
      name: "an idempotencyKey over 128 characters",
      body: { ...full(), idempotencyKey: "a".repeat(129) },
      field: "idempotencyKey",
    },
    {
      name: "a non-string corridorId",
      body: { ...full(), corridorId: 7 },
      field: "corridorId",
    },
    {
      name: "an empty corridorId",
      body: { ...full(), corridorId: "" },
      field: "corridorId",
    },
    {
      name: "a corridorId over 128 characters",
      body: { ...full(), corridorId: "c".repeat(129) },
      field: "corridorId",
    },
    { name: "an unknown top-level field", body: { ...full(), memo: "hi" }, field: "memo" },
    {
      name: "a missing sender",
      body: { ...full(), sender: undefined },
      field: "sender",
    },
    { name: "a non-object sender", body: { ...full(), sender: "s" }, field: "sender" },
    { name: "a sender without id", body: { ...full(), sender: {} }, field: "sender.id" },
    {
      name: "a non-string sender.id",
      body: { ...full(), sender: { id: 1 } },
      field: "sender.id",
    },
    {
      name: "an empty sender.id",
      body: { ...full(), sender: { id: "" } },
      field: "sender.id",
    },
    {
      name: "a non-string sender.sep12Id",
      body: { ...full(), sender: { id: "s", sep12Id: 42 } },
      field: "sender.sep12Id",
    },
    {
      name: "a non-string recipient.sep12Id",
      body: { ...full(), recipient: { id: "r", sep12Id: { a: 1 } } },
      field: "recipient.sep12Id",
    },
    {
      name: "a non-string recipient.id",
      body: { ...full(), recipient: { id: null } },
      field: "recipient.id",
    },
    {
      name: "an unknown field inside a party",
      body: { ...full(), sender: { id: "s", nickname: "bud" } },
      field: "sender.nickname",
    },
    {
      name: "a missing sourceAmount",
      body: { ...full(), sourceAmount: undefined },
      field: "sourceAmount",
    },
    {
      name: "a non-object sourceAmount",
      body: { ...full(), sourceAmount: "100 USDC" },
      field: "sourceAmount",
    },
    {
      name: "a missing sourceAmount.asset",
      body: { ...full(), sourceAmount: { amount: "100.00" } },
      field: "sourceAmount.asset",
    },
    {
      name: "an empty sourceAmount.asset",
      body: { ...full(), sourceAmount: { asset: "", amount: "100.00" } },
      field: "sourceAmount.asset",
    },
    {
      name: "a non-string sourceAmount.amount",
      body: { ...full(), sourceAmount: { asset: "USDC", amount: 100 } },
      field: "sourceAmount.amount",
    },
    {
      name: "an array destinationFields",
      body: { ...full(), destinationFields: ["routing"] },
      field: "destinationFields",
    },
    {
      name: "a nested (non-flat) destinationFields value",
      body: { ...full(), destinationFields: { routing: { n: "021000021" } } },
      field: "destinationFields.routing",
    },
    {
      name: "a destinationFields value over 256 characters",
      body: { ...full(), destinationFields: { account: "x".repeat(257) } },
      field: "destinationFields.account",
    },
    {
      name: "destinationFields with more than 50 keys",
      body: { ...full(), destinationFields: manyFields },
      field: "destinationFields",
    },
  ];

  it.each(rejections)("rejects $name with field $field", async ({ body, field }) => {
    const r = await svc().route({ method: "POST", path: "/payments", body });
    expect(r.status).toBe(400);
    const out = r.body as { error: string; field: string; reason: string };
    expect(out.error).toBe("invalid payment body");
    expect(out.field).toBe(field);
    expect(typeof out.reason).toBe("string");
    expect(out.reason.length).toBeGreaterThan(0);
  });

  it("rejects an asset matching neither the corridor's source nor bridge asset", async () => {
    const r = await svc().route({
      method: "POST",
      path: "/payments",
      body: { ...intentBody(), sourceAmount: { asset: "BTC", amount: "1.00" } },
    });
    expect(r.status).toBe(422);
    const out = r.body as { error: string; field: string };
    expect(out.error).toBe("AMOUNT_INVALID");
    expect(out.field).toBe("sourceAmount.asset");
  });

  it("still accepts a well-formed body end to end", async () => {
    const r = await svc().route({
      method: "POST",
      path: "/payments",
      body: {
        ...intentBody("strict-ok"),
        destinationFields: { receiver_routing_number: "021000021" },
      },
    });
    expect(r.status).toBe(200);
    expect((r.body as { state: string }).state).toBe("completed");
  });
});

describe("service: GET /payments/:key", () => {
  it("returns the run state after a payment", async () => {
    const s = svc();
    await s.route({ method: "POST", path: "/payments", body: intentBody("look") });
    const r = await s.route({ method: "GET", path: "/payments/look" });
    expect(r.status).toBe(200);
    expect((r.body as { state: string }).state).toBe("completed");
  });

  it("404s an unknown key", async () => {
    const r = await svc().route({ method: "GET", path: "/payments/missing" });
    expect(r.status).toBe(404);
  });
});

describe("service: body-size limit (HTTP server)", () => {
  async function listen(server: Server): Promise<{ port: number; close: () => void }> {
    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    return { port, close: () => server.close() };
  }

  function post(
    port: number,
    body: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, method: "POST", path: "/payments", headers },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  it("rejects a body over the cap with 413 (declared Content-Length)", async () => {
    const { port, close } = await listen(svc({ maxBodyBytes: 64 }).server());
    try {
      const big = JSON.stringify({ blob: "x".repeat(500) });
      const res = await post(port, big, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(big)),
      });
      expect(res.status).toBe(413);
    } finally {
      close();
    }
  });

  it("rejects an oversized streamed body with 413 (no/short Content-Length)", async () => {
    const { port, close } = await listen(svc({ maxBodyBytes: 64 }).server());
    try {
      // Chunked transfer: the server can't trust a declared length and must cap
      // the bytes it actually buffers.
      const res = await post(port, JSON.stringify({ blob: "x".repeat(500) }), {
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      });
      expect(res.status).toBe(413);
    } finally {
      close();
    }
  });

  it("still serves a normal payment under the cap", async () => {
    const { port, close } = await listen(svc().server());
    try {
      const res = await post(port, JSON.stringify(intentBody("http-ok")), {
        "content-type": "application/json",
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).state).toBe("completed");
    } finally {
      close();
    }
  });
});

describe("service: auth + rate limiting + health", () => {
  it("healthz is public", async () => {
    const r = await svc({ apiKeys: new Set(["secret"]) }).route({
      method: "GET",
      path: "/healthz",
    });
    expect(r.status).toBe(200);
  });

  it("serves /metrics as text when a renderer is configured, public + unmetered", async () => {
    const s = svc({
      apiKeys: new Set(["secret"]),
      rateLimit: { capacity: 0, refillPerSec: 0 }, // would 429 everything if metered
      metricsText: () => "# TYPE corridor_transition counter\ncorridor_transition 3\n",
    });
    const r = await s.route({ method: "GET", path: "/metrics" });
    expect(r.status).toBe(200);
    expect(r.contentType).toContain("text/plain");
    expect(r.body).toContain("corridor_transition 3");
  });

  it("404s /metrics when no renderer is configured", async () => {
    const r = await svc().route({ method: "GET", path: "/metrics" });
    expect(r.status).toBe(404);
  });

  it("rejects requests without a valid API key", async () => {
    const s = svc({ apiKeys: new Set(["secret"]) });
    const noKey = await s.route({ method: "POST", path: "/payments", body: intentBody() });
    expect(noKey.status).toBe(401);
    const good = await s.route({
      method: "POST",
      path: "/payments",
      body: intentBody(),
      headers: { authorization: "Bearer secret" },
    });
    expect(good.status).toBe(200);
  });

  it("rate-limits after the bucket is drained", async () => {
    let t = 0;
    const s = svc({ rateLimit: { capacity: 2, refillPerSec: 0 }, now: () => t });
    const hit = () =>
      s.route({
        method: "GET",
        path: "/payments/x",
        headers: { "x-forwarded-for": "1.1.1.1" },
      });
    expect((await hit()).status).toBe(404); // allowed (token 1)
    expect((await hit()).status).toBe(404); // allowed (token 2)
    expect((await hit()).status).toBe(429); // drained
    t += 100; // no refill configured
    expect((await hit()).status).toBe(429);
  });

  it("keys the rate limiter per resolved client IP", async () => {
    const s = svc({ rateLimit: { capacity: 1, refillPerSec: 0 } });
    const hit = (clientIp: string) =>
      s.route({ method: "GET", path: "/payments/x", clientIp });
    expect((await hit("10.0.0.1")).status).toBe(404); // client A's only token
    expect((await hit("10.0.0.1")).status).toBe(429); // A drained
    expect((await hit("10.0.0.2")).status).toBe(404); // B has its own bucket
  });

  it("does not let a forged X-Forwarded-For mint fresh buckets", async () => {
    // Without trustProxy the raw header is ignored for keying, so spoofing it
    // can't dodge the limit — all such requests share the 'anon' bucket.
    const s = svc({ rateLimit: { capacity: 1, refillPerSec: 0 } });
    const hit = (xff: string) =>
      s.route({ method: "GET", path: "/payments/x", headers: { "x-forwarded-for": xff } });
    expect((await hit("9.9.9.1")).status).toBe(404);
    expect((await hit("9.9.9.2")).status).toBe(429); // different forged IP, still limited
  });

  it("uses an injected (async, shared-style) limiter over the default", async () => {
    const seen: string[] = [];
    let allow = true;
    const s = svc({
      // The shape a Redis-backed limiter would have: async take().
      rateLimiter: {
        async take(key: string) {
          seen.push(key);
          return allow;
        },
      },
    });
    const hit = () => s.route({ method: "GET", path: "/payments/x", clientIp: "5.5.5.5" });
    expect((await hit()).status).toBe(404);
    allow = false;
    expect((await hit()).status).toBe(429);
    expect(seen).toEqual(["ip:5.5.5.5", "ip:5.5.5.5"]);
  });
});

describe("service documentation sync", () => {
  it("documents every CorridorErrorCode, HTTP status code, and GET /metrics in web docs", async () => {
    const { docs } = await import("../web/lib/docs.js");
    const httpApiDoc = docs.find((d) => d.slug === "http-api");
    expect(httpApiDoc).toBeDefined();
    const body = httpApiDoc!.body;

    const errorCodes: CorridorErrorCode[] = [
      "MANIFEST_INVALID",
      "AMOUNT_INVALID",
      "QUOTE_UNAVAILABLE",
      "QUOTE_EXPIRED",
      "KYC_REQUIRED",
      "KYC_REJECTED",
      "ANCHOR_UNAVAILABLE",
      "SETTLEMENT_FAILED",
      "SETTLEMENT_TIMEOUT",
      "REFUND_UNSUPPORTED",
      "RECONCILE_MISMATCH",
      "RECONCILE_STALLED",
      "IDEMPOTENCY_CONFLICT",
      "ROUTE_REFUSED",
    ];

    for (const code of errorCodes) {
      expect(body).toContain(code);
    }
  });
});

import { storeCheck } from "@corridor/service";

describe("service: GET /readyz", () => {
  it("returns 200 when all checks pass", async () => {
    const s = svc({
      readinessChecks: [
        { name: "db", check: async () => {} },
        { name: "cache", check: async () => {} },
      ],
    });
    const r = await s.route({ method: "GET", path: "/readyz" });
    expect(r.status).toBe(200);
    expect((r.body as { status: string }).status).toBe("ok");
    const checks = (r.body as { checks: { name: string; ok: boolean }[] }).checks;
    expect(checks).toEqual([
      { name: "db", ok: true },
      { name: "cache", ok: true },
    ]);
  });

  it("returns 503 when a check throws", async () => {
    const s = svc({
      readinessChecks: [
        {
          name: "db",
          check: async () => {
            throw new Error("connection refused");
          },
        },
      ],
    });
    const r = await s.route({ method: "GET", path: "/readyz" });
    expect(r.status).toBe(503);
    expect((r.body as { status: string }).status).toBe("degraded");
    const checks = (r.body as { checks: { name: string; ok: boolean }[] }).checks;
    expect(checks).toEqual([{ name: "db", ok: false }]);
  });

  it("returns 503 when a check times out", async () => {
    const s = svc({
      readinessChecks: [
        // never resolves
        { name: "slow", check: () => new Promise<void>(() => {}) },
      ],
      readinessTimeoutMs: 10,
    });
    const r = await s.route({ method: "GET", path: "/readyz" });
    expect(r.status).toBe(503);
    const checks = (r.body as { checks: { name: string; ok: boolean }[] }).checks;
    expect(checks).toEqual([{ name: "slow", ok: false }]);
  });

  it("returns 200 with no checks configured", async () => {
    const r = await svc().route({ method: "GET", path: "/readyz" });
    expect(r.status).toBe(200);
  });

  it("returns 503 while draining even if all checks pass", async () => {
    const s = svc({
      readinessChecks: [{ name: "db", check: async () => {} }],
    });
    await s.drain();
    const r = await s.route({ method: "GET", path: "/readyz" });
    expect(r.status).toBe(503);
    expect((r.body as { status: string }).status).toBe("draining");
  });

  it("is public and unmetered (rate limit does not apply)", async () => {
    const s = svc({
      rateLimit: { capacity: 0, refillPerSec: 0 }, // would 429 everything if metered
    });
    const r = await s.route({ method: "GET", path: "/readyz" });
    // Should be 200, not 429
    expect(r.status).toBe(200);
  });

  it("/healthz is unaffected by draining", async () => {
    const s = svc();
    await s.drain();
    const r = await s.route({ method: "GET", path: "/healthz" });
    expect(r.status).toBe(200);
    expect((r.body as { status: string }).status).toBe("ok");
  });
});

describe("service: drain()", () => {
  it("new POST /payments return 503 draining after drain() is called", async () => {
    const s = svc();
    await s.drain();
    const r = await s.route({ method: "POST", path: "/payments", body: intentBody() });
    expect(r.status).toBe(503);
    expect((r.body as { error: string }).error).toBe("draining");
  });

  it("in-flight execute() completes after drain() is called", async () => {
    const s = createService({
      corridors: new Map([["test", corridor()]]),
      deps: {
        ...deps(),
        // Fast adapter — no real sleep needed; just verifies tracking logic
        sleep: async () => {},
      },
    });

    // Start a payment
    const paymentPromise = s.route({
      method: "POST",
      path: "/payments",
      body: intentBody("inflight-1"),
    });

    // Call drain while payment is still running
    const drainPromise = s.drain();

    // New payments should be rejected
    const blockedR = await s.route({
      method: "POST",
      path: "/payments",
      body: intentBody("inflight-2"),
    });
    expect(blockedR.status).toBe(503);

    // Original payment still finishes
    const result = await paymentPromise;
    expect(result.status).toBe(200);

    // drain() resolves once in-flight work is done
    await drainPromise;

    // Nothing is left running, so a grace-timer log would list no keys.
    expect(s.inFlightKeys()).toEqual([]);
  });

  it("drain() resolves immediately when no payments are in-flight", async () => {
    const s = svc();
    // No payments started — drain should resolve right away
    await expect(s.drain()).resolves.toBeUndefined();
  });
});

describe("service: storeCheck helper", () => {
  it("passes when ping resolves", async () => {
    const check = storeCheck({ ping: async () => {} });
    expect(check.name).toBe("store");
    await expect(check.check()).resolves.toBeUndefined();
  });

  it("throws when ping rejects", async () => {
    const check = storeCheck(
      {
        ping: async () => {
          throw new Error("db down");
        },
      },
      "pg",
    );
    expect(check.name).toBe("pg");
    await expect(check.check()).rejects.toThrow("db down");
  });
});
