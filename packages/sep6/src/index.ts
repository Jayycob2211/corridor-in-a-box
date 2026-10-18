// @corridor/sep6 — the receiving-side adapter for any standards-compliant SEP-6
// anchor.
//
// SEP-6 is the most common programmatic off-ramp on Stellar: a sender moves an
// asset to an anchor, and the anchor pays out in a local currency (or another
// asset). This package scaffolds the adapter and its discovery step, GET /info.
// The transactional verbs land in their own issues and fail closed here until
// then (#196 quote, #197 withdraw, #198 status).
//
// The HTTP shape below follows SEP-6: GET {transfer_server}/info, whose
// `withdraw` and `withdraw-exchange` sections are keyed by plain asset code and
// describe the supported types and their required fields.

import type { Sep6Anchor, Corridor } from "@corridor/manifest";
import {
  fail,
  isValidAmount,
  ok,
  type Money,
  type Outcome,
  type PaymentIntent,
} from "@corridor/types";
import type {
  AdapterCapabilities,
  AnchorAdapter,
  KycResult,
  OpenTransaction,
  Quote,
  RefundRef,
  TransactionStatus,
} from "@corridor/adapter-kit";

type FetchLike = typeof fetch;

/** One field an anchor asks for on a SEP-6 withdraw type. */
export interface Sep6Field {
  readonly description?: string;
  readonly choices?: readonly string[];
  readonly optional?: boolean;
}

/** A single withdraw type (e.g. "bank_account") and the fields it requires. */
export interface Sep6Type {
  readonly fields: Readonly<Record<string, Sep6Field>>;
}

/** One asset's entry under `withdraw` / `withdraw-exchange` in GET /info. */
export interface Sep6AssetInfo {
  /** Absent means the anchor said nothing; only an explicit `false` disables. */
  readonly enabled?: boolean;
  readonly authenticationRequired?: boolean;
  readonly minAmount?: string;
  readonly maxAmount?: string;
  readonly feeFixed?: string;
  readonly feePercent?: string;
  /** Withdraw types the anchor publishes for this asset, keyed by type name. */
  readonly types: Readonly<Record<string, Sep6Type>>;
}

/** The SEP-6 GET /info sections this adapter reads. */
export interface Sep6Info {
  /** Non-exchange withdraw, keyed by asset code (e.g. "ARS"). */
  readonly withdraw: Readonly<Record<string, Sep6AssetInfo>>;
  /** Exchange-based withdraw (`withdraw-exchange`), keyed by asset code. */
  readonly withdrawExchange: Readonly<Record<string, Sep6AssetInfo>>;
}

export interface Sep6AdapterOptions {
  /** Inject a fetch implementation (defaults to global fetch). Handy for tests. */
  fetchImpl?: FetchLike;
}

/**
 * The asset code SEP-6 keys /info by, from a corridor's SEP-38 asset id.
 *
 * `/info` uses the bare code ("ARS", "USDC"), while a manifest names the asset
 * the SEP-38 way ("iso4217:ARS", "stellar:USDC:GISSUER"). A bare code is
 * returned unchanged so an anchor that already matches still lines up.
 */
function infoAssetCode(asset: string): string {
  const parts = asset.split(":");
  if ((parts[0] === "iso4217" || parts[0] === "stellar") && parts.length >= 2) {
    return parts[1] ?? asset;
  }
  return asset;
}

/**
 * A decimal amount string from a SEP-6 /info number or numeric string.
 *
 * SEP-6 publishes `min_amount` / `max_amount` / `fee_fixed` / `fee_percent` as
 * JSON numbers. JSON.parse has already put those through a float64 before this
 * adapter sees them, so the best that can be done is to stop the number here:
 * convert to a decimal string immediately and never do arithmetic on it. A
 * value that does not survive as a plain decimal is dropped, not reported.
 */
function amountString(v: unknown): string | undefined {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 0) return undefined;
    const s = String(v);
    return isValidAmount(s) ? s : undefined;
  }
  if (typeof v === "string" && isValidAmount(v.trim())) return v.trim();
  return undefined;
}

/** A plain JSON object, or an empty one for anything else (null, arrays, scalars). */
function asObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** Parse a withdraw type's `fields` map; anything malformed is dropped. */
function parseFields(raw: unknown): Readonly<Record<string, Sep6Field>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const fields: Record<string, Sep6Field> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const f = value as Record<string, unknown>;
    fields[name] = {
      ...(typeof f.description === "string" ? { description: f.description } : {}),
      ...(Array.isArray(f.choices)
        ? { choices: f.choices.filter((c): c is string => typeof c === "string") }
        : {}),
      ...(typeof f.optional === "boolean" ? { optional: f.optional } : {}),
    };
  }
  return fields;
}

/** Parse the `types` map of one asset entry. */
function parseTypes(raw: unknown): Readonly<Record<string, Sep6Type>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const types: Record<string, Sep6Type> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const t = value as Record<string, unknown>;
    types[name] = { fields: parseFields(t.fields) };
  }
  return types;
}

/** Parse one asset entry under `withdraw` / `withdraw-exchange`. */
function parseAssetInfo(raw: unknown): Sep6AssetInfo {
  const a = asObject(raw);
  const minAmount = amountString(a.min_amount);
  const maxAmount = amountString(a.max_amount);
  const feeFixed = amountString(a.fee_fixed);
  const feePercent = amountString(a.fee_percent);
  return {
    ...(typeof a.enabled === "boolean" ? { enabled: a.enabled } : {}),
    ...(typeof a.authentication_required === "boolean"
      ? { authenticationRequired: a.authentication_required }
      : {}),
    ...(minAmount !== undefined ? { minAmount } : {}),
    ...(maxAmount !== undefined ? { maxAmount } : {}),
    ...(feeFixed !== undefined ? { feeFixed } : {}),
    ...(feePercent !== undefined ? { feePercent } : {}),
    types: parseTypes(a.types),
  };
}

/** Parse one of the two withdraw sections, keyed by asset code. */
function parseSection(raw: unknown): Readonly<Record<string, Sep6AssetInfo>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const section: Record<string, Sep6AssetInfo> = {};
  for (const [code, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    section[code] = parseAssetInfo(value);
  }
  return section;
}

/**
 * Parse a SEP-6 GET /info document into the shape this adapter reads.
 *
 * Deliberately narrow: only `withdraw` and `withdraw-exchange` are surfaced,
 * because those are the flows a receiving-side off-ramp corridor uses. Every
 * field is optional and untrusted; anything malformed is dropped rather than
 * guessed, so a partial document still yields a usable (if smaller) result.
 */
export function parseSep6Info(raw: unknown): Sep6Info {
  const doc = asObject(raw);
  return {
    withdraw: parseSection(doc.withdraw),
    withdrawExchange: parseSection(doc["withdraw-exchange"]),
  };
}

/**
 * Receiving-side adapter for a SEP-6 anchor.
 *
 * This scaffold implements discovery only: `info()` and the `capabilities()`
 * derived from it. The verbs (`requestQuote`, `ensureCompliance`,
 * `openTransaction`, `getTransaction`, `requestRefund`) fail closed with
 * ANCHOR_UNAVAILABLE until their issues land, so a corridor wired to this
 * adapter cannot silently half-run.
 */
export class Sep6Adapter implements AnchorAdapter {
  readonly name: string;
  private readonly anchor: Sep6Anchor;
  /** Asset code `/info` keys by, derived from `dest.asset`. */
  private readonly destAssetCode: string;
  private readonly fetchImpl: FetchLike;
  private cachedInfo?: Sep6Info;

  constructor(corridor: Corridor, opts: Sep6AdapterOptions = {}) {
    if (corridor.dest.protocol !== "sep6") {
      throw new Error(
        `Sep6Adapter cannot handle protocol "${corridor.dest.protocol}"; use an adapter for that protocol`,
      );
    }
    this.anchor = corridor.dest as Sep6Anchor;
    this.name = this.anchor.name;
    this.destAssetCode = infoAssetCode(this.anchor.asset);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * GET {transfer_server}/info, parsed and cached per instance.
   *
   * Cached because SEP-6 /info is static discovery data: refetching it on every
   * `capabilities()` read would put a network round-trip in front of a call the
   * engine may make often. Pass `force` to re-read and refresh the cache.
   */
  async info(force = false): Promise<Outcome<Sep6Info>> {
    if (this.cachedInfo && !force) return ok(this.cachedInfo);
    const { transfer_server } = this.anchor.endpoints;
    try {
      const res = await this.fetchImpl(`${transfer_server}/info`, { method: "GET" });
      if (!res.ok) {
        return fail("ANCHOR_UNAVAILABLE", `${this.name}: get-info HTTP ${res.status}`, {
          retryable: res.status >= 500,
        });
      }
      const info = parseSep6Info(await res.json());
      this.cachedInfo = info;
      return ok(info);
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: get-info request failed`, {
        retryable: true,
        cause,
      });
    }
  }

  /**
   * The dest asset's `withdraw-exchange` entry, from the cached /info.
   *
   * `settlement` is reported off `withdraw-exchange` because that is the flow a
   * cross-border corridor uses: the anchor quotes an exchange rate and pays out
   * the dest asset. A non-exchange `withdraw` entry alone is not the corridor's
   * path, so it does not make the lane look settleable.
   */
  private withdrawExchangeEntry(): Sep6AssetInfo | undefined {
    return this.cachedInfo?.withdrawExchange[this.destAssetCode];
  }

  capabilities(): AdapterCapabilities {
    const e = this.anchor.endpoints;
    const entry = this.withdrawExchangeEntry();
    // Only an explicit `enabled: false` disables; absent means the anchor did
    // not say. Missing entry (asset not offered) is unsupported either way.
    const settleable = entry !== undefined && entry.enabled !== false;
    return {
      protocol: "sep6",
      quotes: e.quote_server ? ["sep38_firm"] : ["none"],
      kyc: e.kyc_server ? "sep12" : "sep6_fields",
      // The SEP-6 adapter does not assume a SEP-31 deposit address: it reports
      // on-chain vs off-chain itself (see docs/rfcs/0001). Empty until info()
      // runs, and empty when `withdraw-exchange` omits the asset or disables it.
      settlement: settleable ? ["adapter_reported"] : [],
      refunds: "none",
      callbacks: false,
    };
  }

  private notImplemented(verb: string) {
    return fail("ANCHOR_UNAVAILABLE", `${this.name}: SEP-6 ${verb} is not implemented yet`);
  }

  async requestQuote(_intent: PaymentIntent, _corridor: Corridor): Promise<Outcome<Quote>> {
    return this.notImplemented("requestQuote");
  }

  async ensureCompliance(
    _intent: PaymentIntent,
    _corridor: Corridor,
  ): Promise<Outcome<KycResult>> {
    return this.notImplemented("ensureCompliance");
  }

  async openTransaction(
    _intent: PaymentIntent,
    _quote: Quote,
    _corridor: Corridor,
  ): Promise<Outcome<OpenTransaction>> {
    return this.notImplemented("openTransaction");
  }

  async getTransaction(_transactionId: string): Promise<Outcome<TransactionStatus>> {
    return this.notImplemented("getTransaction");
  }

  async requestRefund(
    _transactionId: string,
    _amount: Money,
    _reason: string,
  ): Promise<Outcome<RefundRef>> {
    return this.notImplemented("requestRefund");
  }
}
