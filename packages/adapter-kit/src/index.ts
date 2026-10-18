// @corridor/adapter-kit — the seam between the engine and any anchor.
//
// The engine knows ONLY this interface. It never knows whether the thing on the
// other side is Anclap, Bitso, a testnet reference server, or a bespoke OTC desk.
// Standards-compliant anchors are served by one generic adapter (@corridor/sep31);
// bespoke integrations implement this same interface and (in the real product)
// could be implemented separately; no private implementation is included here.

import type { Corridor } from "@corridor/manifest";
import {
  applyPrice,
  compareAmounts,
  fail,
  isValidAmount,
  ok,
  subAmounts,
  type Money,
  type Outcome,
  type PaymentIntent,
} from "@corridor/types";

/** A SEP-38 quote. `firm` quotes carry an id + expiry and bind the deliverer to a rate. */
export interface Quote {
  readonly id: string;
  /** Dest units per 1 source unit. */
  readonly price: string;
  /** Epoch ms after which a firm quote is no longer honoured. */
  readonly expiresAt: number;
  readonly sourceAmount: Money;
  readonly destAmount: Money;
  readonly fee?: Money;
  readonly firm: boolean;
}

export interface KycResult {
  readonly status: "accepted" | "pending" | "rejected";
  readonly customerId?: string;
}

/**
 * Deposit instructions returned by an anchor describing where or how to settle funds.
 * Discriminated union supporting on-chain Stellar payments, claimable balance funding,
 * and off-chain / adapter-settled transactions (#183).
 */
export type DepositInstructions =
  | {
      readonly kind: "stellar_payment";
      readonly to: string;
      readonly memo?: string;
      readonly memoType?: "text" | "hash" | "id";
      readonly asset?: string;
    }
  | {
      readonly kind: "claimable_balance";
      readonly claimant: string;
      readonly asset?: string;
      readonly predicateSeconds?: number;
    }
  | {
      readonly kind: "adapter_settled";
      readonly reference?: string;
    };

/**
 * Extract legacy flat address and memo fields from an OpenTransaction.
 * Retained for backward compatibility during transition to instructions union.
 */
export function toLegacy(tx: OpenTransaction): {
  readonly depositAddress?: string;
  readonly memo?: string;
  readonly memoType?: "text" | "hash" | "id";
} {
  if (tx.instructions && tx.instructions.kind === "stellar_payment") {
    return {
      depositAddress: tx.instructions.to,
      memo: tx.instructions.memo,
      memoType: tx.instructions.memoType,
    };
  }
  return {
    depositAddress: tx.depositAddress,
    memo: tx.memo,
    memoType: tx.memoType,
  };
}

/** Returned by the receiving anchor's SEP-31 POST /transactions — where to send the bridge asset. */
export interface OpenTransaction {
  readonly transactionId: string;
  readonly instructions: DepositInstructions;
  readonly amountIn?: Money;
  /**
   * @deprecated Read from `instructions` instead. Retained for single-release compatibility.
   */
  readonly depositAddress?: string;
  /**
   * @deprecated Read from `instructions` instead. Retained for single-release compatibility.
   */
  readonly memo?: string;
  /**
   * How to encode `memo` on the settlement transaction.
   * @deprecated Read from `instructions` instead. Retained for single-release compatibility.
   */
  readonly memoType?: "text" | "hash" | "id";
}

/**
 * One entry of SEP-31's `refunds.payments[]` — a single movement of money back,
 * which may be one of several making up a refund.
 */
export interface RefundPayment {
  /** Stellar transaction hash, or the anchor's own external payment id. */
  readonly id: string;
  /** `stellar` for an on-chain refund, `external` for an off-chain one. */
  readonly idType?: string;
  readonly amount: Money;
  /** What the anchor kept out of this payment. */
  readonly fee: Money;
}

/**
 * What a receiving anchor reports about a refund, from the `refunds` object on
 * the SEP-31 transaction record.
 *
 * This is *news*, not a request: over SEP-31 the sending side cannot ask for a
 * refund, it can only learn one happened (see `Sep31Adapter.requestRefund`).
 * Without this, a refund was visible only as the status flipping to `refunded`
 * — correct, but it left "how much came back" unanswerable, and a partial
 * refund indistinguishable from a full one.
 *
 * Amounts are `Money`, never numbers: the amount that came back is compared
 * against the amount that went out, and doing that in float64 is exactly the
 * bug the string-based money rule exists to prevent.
 */
export interface RefundInfo {
  /** Total returned to the sender, before the anchor's refund fee. */
  readonly amountRefunded: Money;
  /** Total the anchor kept for processing the refund. */
  readonly amountFee: Money;
  /** The individual payments making up the refund; may be empty. */
  readonly payments: readonly RefundPayment[];
  /**
   * Whether the whole payment came back.
   *
   * `unknown` when the anchor did not report an amount to compare against, or
   * reported one that could not be parsed — the caller is told it does not
   * know, rather than being handed a guess. Decided with `compareAmounts`, not
   * string equality: "100" and "100.00" are the same amount of money.
   */
  readonly completeness: "full" | "partial" | "unknown";
}

export interface TransactionStatus {
  /** The raw status string reported by the anchor (e.g. a SEP-31 status). */
  readonly status: string;
  /** The subsystem currently responsible for making progress on this status. */
  readonly phase?: "anchor" | "external";
  /** The payout is confirmed complete — the engine may finish. */
  readonly settled: boolean;
  /**
   * The transaction has reached a terminal NON-success state at the anchor
   * (e.g. SEP-31 `error` / `expired` / `refunded`). When set, the engine stops
   * polling immediately and routes to its recovery policy instead of waiting out
   * the corridor timeout. Absent/false means "not settled yet, keep polling".
   */
  readonly terminalFailure?: boolean;
  /**
   * In flight, but blocked on input from outside the engine rather than on the
   * anchor doing its work (SEP-31 `incomplete`, `pending_customer_info_update`,
   * `pending_transaction_info_update`). Polling continues either way — the
   * distinction is operational: a run that times out here timed out waiting on
   * a human, not on a slow anchor. Optional and purely informational; absent
   * means "not known to be blocked".
   */
  readonly awaitingInput?: boolean;
  /**
   * Refund detail, when the anchor reported any.
   *
   * Carried on the status rather than fetched separately because it arrives on
   * the same record the poll already reads: a second call would be a second
   * chance for the two to disagree. Absent whenever the anchor omits `refunds`
   * (the happy path) or reports one that cannot be trusted — never a
   * zero-filled placeholder, which would read as "refunded nothing" rather
   * than "said nothing".
   */
  readonly refunds?: RefundInfo;
  /**
   * The anchor's own record of what it expects to receive, read back off the
   * transaction (SEP-31 `amount_in` / `amount_in_asset`, `stellar_account_id`,
   * `stellar_memo`, `stellar_memo_type`).
   *
   * These exist so a caller can cross-check the opened transaction against the
   * payment it is about to submit before any money moves. Each is independent
   * and optional: absent whenever the anchor omits it or reports something that
   * cannot be read — never a guess. An adapter that cannot see them leaves them
   * all undefined.
   */
  readonly amountIn?: Money;
  readonly depositAddress?: string;
  readonly memo?: string;
  readonly memoType?: "text" | "hash" | "id";
}

/**
 * Reference returned when a refund request is accepted for processing.
 *
 * A refund is *requested* here and *reported* on `TransactionStatus.refunds`:
 * the request is the sender's side of the conversation, the report is the
 * anchor's. They are separate types because a request can be accepted and still
 * move no money yet — `status: "pending"` is the normal outcome, and the amounts
 * only become knowable later, on the transaction record the poll already reads.
 */
export interface RefundRef {
  readonly transactionId: string;
  readonly status: "pending" | "refunded" | "rejected";
  readonly refundId?: string;
  readonly message?: string;
}

/**
 * SHIM for #187 (minimal, to be reconciled with that issue's PR).
 * What an adapter supports, discoverable up front instead of by failing.
 * `settlement` is `readonly string[]` here because `DepositInstructions` (the
 * type #187 names) does not exist in this tree yet.
 */
export interface AdapterCapabilities {
  readonly protocol: string;
  readonly quotes: readonly ("sep38_firm" | "sep38_indicative" | "native" | "none")[];
  readonly kyc: "sep12" | "sep6_fields" | "bespoke" | "none";
  readonly settlement: readonly string[];
  readonly refunds: "request" | "report_only" | "none";
  readonly callbacks: boolean;
}

/**
 * A source of quotes, independent of the receiving adapter.
 */
export interface QuoteProvider {
  readonly source: "sep38" | "native" | "external";
  quote(intent: PaymentIntent, corridor: Corridor): Promise<Outcome<Quote>>;
}

/**
 * Convert the corridor's bridge asset into the SEP-38 Asset Identification Format:
 * `stellar:native` for XLM, `stellar:CODE:ISSUER` for everything else. Anchors
 * reject issuer-less Stellar asset ids ("sell_asset not found").
 */
export function sep38SellAsset(corridor: Corridor): string {
  const code = corridor.settlement.bridge_asset;
  return code.toUpperCase() === "XLM"
    ? "stellar:native"
    : `stellar:${code}:${corridor.settlement.asset_issuer}`;
}

export const QUOTE_TOLERANCE = "0.001";

export interface Sep38QuoteProviderOptions {
  /**
   * The protocol context passed in SEP-38 POST /quote `context` field (e.g. "sep31", "sep6").
   * Defaults to "sep31".
   */
  readonly context?: string;
  /**
   * Optional custom fetch implementation (e.g. for mock testing).
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Optional name used in error messages (defaults to destination anchor name or "SEP-38").
   */
  readonly name?: string;
  /**
   * Explicit quote server URL or resolver function.
   * If omitted, falls back to `corridor.dest.endpoints.quote_server`.
   */
  readonly quoteServer?: string | ((corridor: Corridor) => string | undefined);
  /**
   * Supplier for bearer auth token (e.g. from SEP-10).
   */
  readonly authToken?: (corridor: Corridor) => Promise<Outcome<string | undefined>>;
}

/**
 * Quote provider for `fx.quote_source: sep38`. Interacts with an anchor's SEP-38
 * quote server to obtain firm conversion rates with fees and expiration.
 */
export class Sep38QuoteProvider implements QuoteProvider {
  readonly source = "sep38" as const;

  constructor(private readonly opts: Sep38QuoteProviderOptions = {}) {}

  async quote(intent: PaymentIntent, corridor: Corridor): Promise<Outcome<Quote>> {
    const name = this.opts.name ?? corridor.dest.name ?? "SEP-38";
    const endpoints = corridor.dest.endpoints as Record<string, unknown>;
    const server =
      typeof this.opts.quoteServer === "function"
        ? this.opts.quoteServer(corridor)
        : (this.opts.quoteServer ??
          (typeof endpoints.quote_server === "string" ? endpoints.quote_server : undefined));
    if (!server) {
      return fail("QUOTE_UNAVAILABLE", `${name}: anchor exposes no SEP-38 quote server`);
    }

    let authHeader: Record<string, string> = {};
    if (this.opts.authToken) {
      const auth = await this.opts.authToken(corridor);
      if (!auth.ok) return auth;
      if (auth.value) {
        authHeader = { authorization: `Bearer ${auth.value}` };
      }
    }

    try {
      const fetchImpl = this.opts.fetchImpl ?? fetch;
      const context = this.opts.context ?? "sep31";
      const sellAsset = sep38SellAsset(corridor);
      const buyAsset = corridor.dest.asset;

      const res = await fetchImpl(`${server}/quote`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeader,
        },
        body: JSON.stringify({
          context,
          sell_asset: sellAsset,
          buy_asset: buyAsset,
          sell_amount: intent.sourceAmount.amount,
        }),
      });

      if (!res.ok) {
        return fail("QUOTE_UNAVAILABLE", `${name}: quote HTTP ${res.status}`, {
          retryable: res.status >= 500,
        });
      }

      const j = (await res.json()) as {
        id: string;
        price: string;
        total_price?: string;
        expires_at: string;
        sell_amount: string;
        buy_amount: string;
        fee?: { total: string; asset: string };
      };

      const sellAmount = j.sell_amount ?? intent.sourceAmount.amount;
      if (!isValidAmount(sellAmount)) {
        return fail(
          "QUOTE_UNAVAILABLE",
          `${name}: quote sell_amount "${sellAmount}" is malformed`,
        );
      }

      if (j.total_price && isValidAmount(j.total_price) && isValidAmount(j.buy_amount)) {
        const impliedSell = applyPrice(j.buy_amount, j.total_price);
        if (impliedSell.ok) {
          const drift = subAmounts(impliedSell.value, sellAmount);
          const tolerance = applyPrice(sellAmount, QUOTE_TOLERANCE);
          if (drift.ok && tolerance.ok) {
            const abs = drift.value.startsWith("-") ? drift.value.slice(1) : drift.value;
            const within = compareAmounts(abs, tolerance.value);
            if (within.ok && within.value > 0) {
              return fail(
                "QUOTE_UNAVAILABLE",
                `${name}: quote ${j.id} is internally inconsistent — ` +
                  `total_price ${j.total_price} × buy_amount ${j.buy_amount} = ` +
                  `${impliedSell.value}, but sell_amount is ${sellAmount}`,
              );
            }
          }
        }
      }

      let fee: Money | undefined;
      if (j.fee) {
        if (j.fee.asset !== sellAsset) {
          return fail(
            "QUOTE_UNAVAILABLE",
            `${name}: quote fee asset "${j.fee.asset}" does not match sell asset "${sellAsset}"`,
          );
        }
        if (isValidAmount(j.fee.total)) {
          fee = { asset: intent.sourceAmount.asset, amount: j.fee.total };
        }
      }

      return ok<Quote>({
        id: j.id,
        price: j.price,
        expiresAt: Date.parse(j.expires_at),
        sourceAmount: { asset: intent.sourceAmount.asset, amount: sellAmount },
        destAmount: { asset: buyAsset, amount: j.buy_amount },
        ...(fee && { fee }),
        firm: true,
      });
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${name}: quote request failed`, {
        retryable: true,
        cause,
      });
    }
  }
}

/**
 * Wraps an adapter's native quote handling into the `QuoteProvider` interface.
 */
export class AdapterQuoteProvider implements QuoteProvider {
  readonly source = "native" as const;

  constructor(private readonly adapter: AnchorAdapter) {}

  async quote(intent: PaymentIntent, corridor: Corridor): Promise<Outcome<Quote>> {
    return this.adapter.requestQuote(intent, corridor);
  }
}

/** What the operator's pricing feed returns for an external quote. */
export interface ExternalQuote {
  /** Dest units per 1 source unit. */
  readonly price: string;
  /** Overrides the amount derived from `price` x source amount. */
  readonly destAmount?: Money;
  /** Epoch ms. Defaults to now + `fx.quote_ttl_seconds`. */
  readonly expiresAt?: number;
}

/** Operator-injected pricing function for `fx.quote_source: external`. */
export type ExternalQuoteFn = (
  intent: PaymentIntent,
  corridor: Corridor,
) => Promise<Outcome<ExternalQuote>>;

/**
 * Quote provider for `fx.quote_source: external`. The rate comes from an
 * operator-injected function; the returned Quote is always `firm: false`
 * because nobody at the receiving anchor has committed to it.
 */
export class ExternalQuoteProvider implements QuoteProvider {
  readonly source = "external" as const;
  private counter = 0;

  constructor(
    private readonly fn: ExternalQuoteFn,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async quote(intent: PaymentIntent, corridor: Corridor): Promise<Outcome<Quote>> {
    let r: Outcome<ExternalQuote>;
    try {
      r = await this.fn(intent, corridor);
    } catch (e) {
      return fail(
        "QUOTE_UNAVAILABLE",
        `external quote provider threw: ${e instanceof Error ? e.message : String(e)}`,
        { retryable: true },
      );
    }
    if (!r.ok) return r;
    const { price, destAmount, expiresAt } = r.value;
    const derived = applyPrice(intent.sourceAmount.amount, price);
    if (!derived.ok || !/^\d+(\.\d+)?$/.test(price) || Number(price) <= 0) {
      return fail(
        "QUOTE_UNAVAILABLE",
        `external quote price "${price}" is not a positive decimal`,
      );
    }
    return ok<Quote>({
      id: `ext_${this.now()}_${++this.counter}`,
      price,
      expiresAt: expiresAt ?? this.now() + corridor.fx.quote_ttl_seconds * 1000,
      sourceAmount: intent.sourceAmount,
      destAmount: destAmount ?? { asset: corridor.dest.asset, amount: derived.value },
      firm: false,
    });
  }
}

export interface AnchorAdapter {
  readonly name: string;
  /** Up-front description of what this adapter supports (see #187). */
  capabilities(): AdapterCapabilities;
  /** SEP-38: request an FX quote for this intent on this corridor. */
  requestQuote(intent: PaymentIntent, corridor: Corridor): Promise<Outcome<Quote>>;
  /** SEP-10 auth + SEP-12 KYC handoff. Verify once; pass identity through. */
  ensureCompliance(intent: PaymentIntent, corridor: Corridor): Promise<Outcome<KycResult>>;
  /** SEP-31: open the transaction on the receiving anchor; get deposit instructions. */
  openTransaction(
    intent: PaymentIntent,
    quote: Quote,
    corridor: Corridor,
  ): Promise<Outcome<OpenTransaction>>;
  /** Poll transaction status for reconciliation. */
  getTransaction(transactionId: string): Promise<Outcome<TransactionStatus>>;
  /**
   * Request a refund from the receiving anchor.
   *
   * Refunds are anchor-driven operations, NOT unilateral on-chain reversals.
   * Standard SEP-31 anchors do not expose a sender-initiated refund endpoint
   * (the adapter returns REFUND_UNSUPPORTED), but bespoke anchor integrations
   * or proprietary OTC desks may implement this method to request an anchor-side
   * refund.
   */
  requestRefund(
    transactionId: string,
    amount: Money,
    reason: string,
  ): Promise<Outcome<RefundRef>>;
}

// --- Conformance ---------------------------------------------------------
// Any adapter — generic or bespoke — should pass the same probes before you
// trust it in a corridor. This is intentionally minimal; grow it as you learn
// which anchor behaviours actually break in production.

export interface ConformanceProbe {
  readonly name: string;
  run(): Promise<boolean>;
}

export function conformanceSuite(
  adapter: AnchorAdapter,
  intent: PaymentIntent,
  corridor: Corridor,
): ConformanceProbe[] {
  return [
    {
      name: "quote returns a future expiry",
      run: async () => {
        const q = await adapter.requestQuote(intent, corridor);
        return q.ok && q.value.expiresAt > Date.now();
      },
    },
    {
      name: "compliance resolves to a known status",
      run: async () => {
        const c = await adapter.ensureCompliance(intent, corridor);
        return c.ok && ["accepted", "pending", "rejected"].includes(c.value.status);
      },
    },
  ];
}

// --- Mock adapter --------------------------------------------------------
// A configurable in-memory anchor for tests and the runnable example. Lets you
// simulate the unhappy paths (expired quote, rejected KYC) without a network.

export interface MockAdapterOptions {
  name?: string;
  kyc?: KycResult["status"];
  /** Make the quote already-expired to exercise the QUOTE_EXPIRED path. */
  expireQuoteImmediately?: boolean;
  price?: string;
  settled?: boolean;
  /** Make getTransaction report a terminal anchor failure (error/expired/refunded). */
  terminalFailure?: boolean;
  /**
   * Which branch `requestRefund` takes, so a test can pick a refund outcome
   * without assembling a `RefundRef`:
   * - `"complete"` — the anchor accepted the refund and it is already done
   * - `"pending"`  — accepted, but the money has not moved yet (the default,
   *   and the honest common case: a refund is asynchronous at the anchor)
   * - `"rejected"` — the anchor declined it
   *
   * Omitted, `requestRefund` reports `"pending"`, so existing tests are
   * unaffected. `refundResult` overrides this when a test needs an exact
   * payload or a failure `Outcome`.
   */
  refund?: "complete" | "pending" | "rejected";
  /** Custom refund handler or result for mock testing. Overrides `refund`. */
  refundResult?: Outcome<RefundRef>;
  /** Refund detail for getTransaction to report, on the `refunds` field. */
  refundStatus?: RefundInfo;
  /** Override individual fields of the reported `capabilities()`. */
  capabilities?: Partial<AdapterCapabilities>;
}

export function createMockAdapter(opts: MockAdapterOptions = {}): AnchorAdapter {
  const name = opts.name ?? "mock-anchor";
  const price = opts.price ?? "1.00";
  let counter = 0;
  // What each opened transaction was told to expect, so getTransaction can
  // report it back the way a real anchor's record would.
  const opened = new Map<
    string,
    Pick<TransactionStatus, "amountIn" | "depositAddress" | "memo" | "memoType">
  >();
  return {
    name,
    capabilities() {
      return {
        protocol: "mock",
        quotes: ["sep38_firm"],
        kyc: "sep12",
        settlement: ["stellar_payment"],
        refunds: "request",
        callbacks: false,
        ...opts.capabilities,
      };
    },
    async requestQuote(intent) {
      const now = Date.now();
      return ok<Quote>({
        id: `q_${++counter}`,
        price,
        expiresAt: opts.expireQuoteImmediately ? now - 1 : now + 60_000,
        sourceAmount: intent.sourceAmount,
        destAmount: { asset: "iso4217:MOCK", amount: intent.sourceAmount.amount },
        firm: true,
      });
    },
    async ensureCompliance() {
      return ok<KycResult>({ status: opts.kyc ?? "accepted", customerId: "cust_mock" });
    },
    async openTransaction(_intent, quote) {
      const instructions: DepositInstructions = {
        kind: "stellar_payment",
        to: "GMOCK000000000000000000000000000000000000000000000000",
        memo: "mock-memo",
      };
      const tx: OpenTransaction = {
        transactionId: `tx_${++counter}`,
        instructions,
        amountIn: quote.sourceAmount,
        depositAddress: instructions.to,
        memo: instructions.memo,
      };
      opened.set(tx.transactionId, {
        amountIn: quote.sourceAmount,
        depositAddress: tx.depositAddress,
        memo: tx.memo,
        memoType: tx.memoType,
      });
      return ok(tx);
    },
    async getTransaction(transactionId) {
      const expected = opened.get(transactionId);
      if (opts.terminalFailure) {
        return ok<TransactionStatus>({
          status: "error",
          settled: false,
          terminalFailure: true,
          refunds: opts.refundStatus,
          ...expected,
        });
      }
      return ok<TransactionStatus>({
        status: opts.settled === false ? "pending_receiver" : "completed",
        settled: opts.settled !== false,
        refunds: opts.refundStatus,
        ...expected,
      });
    },
    async requestRefund(transactionId, amount, reason) {
      if (opts.refundResult) return opts.refundResult;
      // "complete" maps to the port's `refunded`: the mock chooses a branch, it
      // does not model an anchor — the wire vocabulary stays on RefundRef.
      const status = opts.refund === "complete" ? "refunded" : (opts.refund ?? "pending");
      return ok<RefundRef>({
        transactionId,
        status,
        message: `Refund requested for ${amount.amount} ${amount.asset}: ${reason}`,
      });
    },
  };
}
