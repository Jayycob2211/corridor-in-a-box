import { describe, expect, it } from "vitest";
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
      stellar_tx_hash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
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

describe("service: refused route status", () => {
  it("returns a non-500 status for a route refused by the resolver", async () => {
    const s = createService({
      corridors: new Map([["test", corridor()]]),
      deps: {
        ...deps(),
        resolver: {
          resolve: () => {
            throw new Error("UnattestedAnchorError: refused");
          },
        } as unknown as EngineDeps["resolver"],
      },
    });
    const r = await s.route({ method: "POST", path: "/payments", body: intentBody("refused") });
    expect(r.status).not.toBe(500);
    expect(r.status).toBe(503);
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
      const r = await post(port, "x".repeat(200), { "content-type": "application/json" });
      expect(r.status).toBe(413);
    } finally {
      close();
    }
  });
});
