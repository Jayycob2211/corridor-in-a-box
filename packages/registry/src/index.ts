// @corridor/registry — read the on-chain anchor conformance registry.
//
// The registry answers one question honestly: for a given anchor domain, which
// SEPs does it advertise, which conformance probes actually passed, and how long
// ago did anyone check? It holds facts, not opinions — no score, no ranking, no
// recommendation. Deciding which anchor to route through is the job of a
// RouteResolver, and that judgement is deliberately not on chain.
//
// READS ONLY. Writing goes through the attester contract and requires an
// enrolled key; a consumer of this package never needs one.

import {
  Contract,
  rpc,
  scValToNative,
  TransactionBuilder,
  Account,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";

/** SEP numbers in the registry's bit order. Mirrors SEP_NUMBERS in the contract. */
export const SEP_NUMBERS = [1, 6, 10, 12, 24, 31, 38] as const;
/** Probe names in the registry's bit order. Mirrors PROBE_NAMES in the contract. */
export const PROBE_NAMES = [
  "toml_fetch",
  "sep10_auth",
  "sep38_quote",
  "sep12_status",
  "sep31_info",
  "sep6_info",
  "sep6_auth",
] as const;

export type ProbeName = (typeof PROBE_NAMES)[number];

/** Protocols the registry can answer a "does this anchor serve it" query for. */
export type Protocol = "sep31" | "sep6";

export interface AnchorAttestation {
  readonly domain: string;
  /** SEP numbers the anchor's stellar.toml advertises. */
  readonly seps: readonly number[];
  /** Probes that were attempted. */
  readonly probesRun: readonly ProbeName[];
  /** Probes that passed. Always a subset of `probesRun` — the contract enforces it. */
  readonly probesPassed: readonly ProbeName[];
  /** SHA-256 of the stellar.toml these facts were read from, hex. */
  readonly tomlHash: string;
  /** Ledger at which this was attested. */
  readonly attestedLedger: number;
  /** Address that produced the attestation. */
  readonly attester: string;
}

export interface HistoryOptions {
  /** First ledger to query from. If omitted, queries from the oldest available ledger reported by RPC. */
  readonly startLedger?: number;
  /** Maximum number of events to retrieve. */
  readonly limit?: number;
}

export interface AnchorHistory {
  readonly domain: string;
  readonly attestations: readonly AnchorAttestation[];
  readonly earliestLedgerCovered: number;
  readonly latestLedger: number;
  readonly oldestLedger: number;
}

/** Which attestations an operator asked for. Every field supplied must match. */
export interface AttestationFilter {
  /** The anchor must advertise every one of these SEP numbers. */
  readonly sep?: readonly number[];
  /** The anchor must have passed every one of these probes. */
  readonly passed?: readonly ProbeName[];
  /** The attestation must be no staler than this many ledgers. */
  readonly maxAge?: number;
}

/**
 * Narrow `records` to the anchors matching `opts`, preserving input order.
 *
 * Pure and synchronous on purpose. Staleness is passed in rather than fetched,
 * so the exact same predicate backs both the human table and `--json` without a
 * network read per filter. Filters intersect, so a record is kept only when it
 * satisfies every supplied condition and adding a filter never widens the
 * result. A domain missing from `stalenessByDomain` cannot satisfy `maxAge` and
 * is dropped rather than assumed fresh.
 */
export function filterAttestations(
  records: readonly AnchorAttestation[],
  stalenessByDomain: Readonly<Record<string, number>>,
  opts: AttestationFilter = {},
): AnchorAttestation[] {
  const { sep, passed, maxAge } = opts;
  return records.filter((record) => {
    if (sep && !sep.every((n) => record.seps.includes(n))) return false;
    if (passed && !passed.every((p) => record.probesPassed.includes(p))) return false;
    if (maxAge !== undefined) {
      const age = stalenessByDomain[record.domain];
      if (age === undefined || age > maxAge) return false;
    }
    return true;
  });
}

export interface RegistryOptions {
  /** Soroban RPC endpoint. */
  rpcUrl: string;
  /** Registry contract id (C…). */
  contractId: string;
  networkPassphrase: string;
  /**
   * Any funded account, used only to build the simulation envelope. Reads are
   * simulated and never submitted, so this account is never charged and needs no
   * signing key — but Soroban still requires a source account to simulate
   * against. Defaults to the null account, which works for pure reads.
   */
  simulationAccount?: string;
}

/** The all-zero account. Valid to simulate against; cannot sign anything. */
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function decodeBits<T>(mask: number, names: readonly T[]): T[] {
  return names.filter((_, i) => (mask & (1 << i)) !== 0);
}

/** Raw shape the contract returns, before it is turned into something readable. */
interface RawRecord {
  domain: string;
  seps: number;
  toml_hash: Uint8Array;
  probes_run: number;
  probes_passed: number;
  attested_ledger: number;
  attester: string;
}

export class AnchorRegistry {
  private readonly server: rpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;
  private readonly simulationAccount: string;

  constructor(opts: RegistryOptions) {
    this.server = new rpc.Server(opts.rpcUrl);
    this.contract = new Contract(opts.contractId);
    this.networkPassphrase = opts.networkPassphrase;
    this.simulationAccount = opts.simulationAccount ?? NULL_ACCOUNT;
  }

  /**
   * Simulate a read-only call and return the decoded result.
   *
   * Reads go through `simulateTransaction` rather than submission: nothing is
   * written, no fee is paid, and no key is needed. A simulation that comes back
   * with an error means the contract reverted — most often `NotFound` — so it is
   * surfaced rather than silently turned into a null.
   */
  private async read<T>(
    method: string,
    ...args: Parameters<Contract["call"]>[1][]
  ): Promise<T> {
    const source = new Account(this.simulationAccount, "0");
    const tx = new TransactionBuilder(source, {
      fee: "100",
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`registry.${method} failed: ${sim.error}`);
    }
    if (!sim.result?.retval) {
      throw new Error(`registry.${method} returned no value`);
    }
    return scValToNative(sim.result.retval) as T;
  }

  /** Every domain with an attestation. */
  async domains(): Promise<string[]> {
    return this.read<string[]>("domains");
  }

  /** Full attestation for a domain. Throws if the domain has never been attested. */
  async getAnchor(domain: string): Promise<AnchorAttestation> {
    const raw = await this.read<RawRecord>("get_anchor", nativeToScValString(domain));
    return {
      domain: raw.domain,
      seps: decodeBits(raw.seps, SEP_NUMBERS),
      probesRun: decodeBits(raw.probes_run, PROBE_NAMES),
      probesPassed: decodeBits(raw.probes_passed, PROBE_NAMES),
      tomlHash: Buffer.from(raw.toml_hash).toString("hex"),
      attestedLedger: raw.attested_ledger,
      attester: raw.attester,
    };
  }

  /** SHA-256 of the stellar.toml the latest attestation was made from. */
  async tomlHash(domain: string): Promise<string> {
    const anchor = await this.getAnchor(domain);
    if (!anchor || typeof anchor.tomlHash !== "string") {
      throw new Error(`registry.get_anchor returned no TOML hash for ${domain}`);
    }
    return anchor.tomlHash;
  }

  /**
   * Whether the anchor both ADVERTISES SEP-31 and PASSED the SEP-31 probe.
   *
   * These are not the same thing, and the difference is the entire point of the
   * registry. `testanchor.stellar.org` advertises SEP-31 in its stellar.toml and
   * returns an empty receive list — it claims a capability it does not have.
   * Anything that reads the toml alone would call that lane runnable.
   */
  async servesSep31(domain: string): Promise<boolean> {
    return this.read<boolean>("serves_sep31", nativeToScValString(domain));
  }

  /**
   * Whether the anchor both ADVERTISES SEP-6 and PASSED the sep6_info probe.
   * The contract keys the SEP-6 answer off sep6_info, the same way the SEP-31
   * answer keys off sep31_info.
   */
  async servesSep6(domain: string): Promise<boolean> {
    return this.read<boolean>("serves_sep6", nativeToScValString(domain));
  }

  /**
   * Protocol-agnostic form of the two queries above, for callers that only know
   * the protocol at runtime. It dispatches to the matching contract method
   * rather than computing a bit locally, so the definition of "serves" stays in
   * one place: the contract.
   */
  async serves(domain: string, protocol: Protocol): Promise<boolean> {
    switch (protocol) {
      case "sep31":
        return this.servesSep31(domain);
      case "sep6":
        return this.servesSep6(domain);
    }
  }

  /** How many ledgers old the attestation is. */
  async staleness(domain: string): Promise<number> {
    return this.read<number>("staleness", nativeToScValString(domain));
  }

  /**
   * Domains that are attested as genuinely serving `protocol` receive-side AND
   * whose attestation is fresher than `maxStalenessLedgers` (default ~1 week at
   * 5s ledgers). The query an operator looking for a rail actually has.
   *
   * Freshness is not optional here: an attestation from six months ago is not
   * evidence about today, and letting callers forget to check would rebuild the
   * problem this registry exists to solve.
   */
  async liveAnchors(
    protocol: Protocol,
    maxStalenessLedgers = WEEK_OF_LEDGERS,
  ): Promise<string[]> {
    const all = await this.domains();
    const out: string[] = [];
    for (const domain of all) {
      const [serves, age] = await Promise.all([
        this.serves(domain, protocol),
        this.staleness(domain),
      ]);
      if (serves && age <= maxStalenessLedgers) out.push(domain);
    }
    return out;
  }

  /**
   * SEP-31 convenience wrapper over `liveAnchors`. Most callers mean the
   * receive-side SEP-31 off-ramp, so the named form is kept.
   */
  async liveSep31Anchors(maxStalenessLedgers = WEEK_OF_LEDGERS): Promise<string[]> {
    return this.liveAnchors("sep31", maxStalenessLedgers);
  }

  /**
   * Attestation history for a domain read from Attested events via Soroban RPC.
   * Attestations are returned ordered by ledger ascending.
   * Reports the covered ledger range (`earliestLedgerCovered` to `latestLedger`).
   */
  async history(domain: string, opts: HistoryOptions = {}): Promise<AnchorHistory> {
    let startLedger = opts.startLedger;
    if (startLedger === undefined) {
      const latest = await this.server.getLatestLedger();
      // Soroban RPC event retention is typically ~24h (17,280 ledgers at 5s/ledger).
      startLedger = Math.max(1, latest.sequence - 17_280);
    }

    const filters: rpc.Api.EventFilter[] = [
      {
        type: "contract",
        contractIds: [this.contract.contractId()],
        // One filter, two segments: the contract event is published with topics
        // `(Symbol("attested"), domain)`. `#[contractevent]` snake_cases the struct name
        // for the prefix topic, so "Attested" would match nothing on a live registry.
        topics: [
          [
            nativeToScVal("attested", { type: "symbol" }).toXDR("base64"),
            nativeToScValString(domain).toXDR("base64"),
          ],
        ],
      },
    ];

    const response = await this.server.getEvents({
      startLedger,
      filters,
      limit: opts.limit,
    });

    const earliestLedgerCovered = Math.max(startLedger, response.oldestLedger);
    const attestations: AnchorAttestation[] = [];

    for (const event of response.events) {
      if (event.topic.length > 1) {
        try {
          const rawDomain = event.topic[1];
          const eventDomain = String(
            typeof rawDomain === "string"
              ? scValToNative(xdr.ScVal.fromXDR(rawDomain, "base64"))
              : scValToNative(rawDomain),
          );
          if (eventDomain !== domain) continue;
        } catch {
          // continue
        }
      }
      attestations.push(decodeAttestationEvent(event));
    }

    attestations.sort((a, b) => a.attestedLedger - b.attestedLedger);

    return {
      domain,
      attestations,
      earliestLedgerCovered,
      latestLedger: response.latestLedger,
      oldestLedger: response.oldestLedger,
    };
  }
}

/**
 * Decodes an on-chain Attested contract event into an AnchorAttestation record.
 * Supports both v2 expanded events and v1 legacy payloads.
 */
export function decodeAttestationEvent(event: {
  topic: readonly (xdr.ScVal | string)[];
  value: xdr.ScVal | string;
  ledger: number;
}): AnchorAttestation {
  let domain = "";
  if (event.topic && event.topic.length > 1) {
    const rawDomain = event.topic[1];
    domain = String(
      typeof rawDomain === "string"
        ? scValToNative(xdr.ScVal.fromXDR(rawDomain, "base64"))
        : scValToNative(rawDomain),
    );
  }

  const raw =
    typeof event.value === "string"
      ? scValToNative(xdr.ScVal.fromXDR(event.value, "base64"))
      : scValToNative(event.value);

  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (r.domain && typeof r.domain === "string") {
      domain = r.domain;
    }
    const sepsNum = r.seps !== undefined ? Number(r.seps) : 0;
    const probesRunNum = r.probes_run !== undefined ? Number(r.probes_run) : 0;
    const probesPassedNum = r.probes_passed !== undefined ? Number(r.probes_passed) : 0;
    const attestedLedgerNum =
      r.attested_ledger !== undefined ? Number(r.attested_ledger) : event.ledger;
    const tomlHashHex =
      r.toml_hash && (r.toml_hash instanceof Uint8Array || Buffer.isBuffer(r.toml_hash))
        ? Buffer.from(r.toml_hash).toString("hex")
        : "";
    const attesterAddr = r.attester ? String(r.attester) : "";

    return {
      domain,
      seps: decodeBits(sepsNum, SEP_NUMBERS),
      probesRun: decodeBits(probesRunNum, PROBE_NAMES),
      probesPassed: decodeBits(probesPassedNum, PROBE_NAMES),
      tomlHash: tomlHashHex,
      attestedLedger: attestedLedgerNum,
      attester: attesterAddr,
    };
  }

  const attestedLedgerNum =
    typeof raw === "number" || typeof raw === "bigint" ? Number(raw) : event.ledger;
  return {
    domain,
    seps: [],
    probesRun: [],
    probesPassed: [],
    tomlHash: "",
    attestedLedger: attestedLedgerNum,
    attester: "",
  };
}

/** Approximate ledgers in one week at 5 seconds per ledger. (7 * 24 * 60 * 60 / 5) */
export const WEEK_OF_LEDGERS = 120_960;

/** Default maximum staleness threshold for scheduled runs: ~2 days at 5s per ledger. (2 * 24 * 60 * 60 / 5) */
export const MAX_STALENESS_LEDGERS = 34_560;

export interface StalenessRecord {
  readonly domain: string;
  readonly ledgersOld?: number | null;
  readonly staleness?: number | null;
  readonly neverAttested?: boolean;
}

export interface StaleDomain {
  readonly domain: string;
  readonly reason: "stale" | "never-attested";
  readonly ledgersOld?: number | null;
  readonly threshold: number;
}

/**
 * Filter records for any domain that is stale or was never attested.
 * Returns records where the domain was never attested or exceeds the staleness threshold.
 */
export function findStale(
  records: readonly StalenessRecord[],
  threshold: number = MAX_STALENESS_LEDGERS,
): StaleDomain[] {
  const stale: StaleDomain[] = [];
  for (const record of records) {
    const age = record.ledgersOld ?? record.staleness;
    if (record.neverAttested || age === null || age === undefined) {
      stale.push({
        domain: record.domain,
        reason: "never-attested",
        ledgersOld: null,
        threshold,
      });
    } else if (typeof age === "number" && age > threshold) {
      stale.push({
        domain: record.domain,
        reason: "stale",
        ledgersOld: age,
        threshold,
      });
    }
  }
  return stale;
}

// The SDK's nativeToScVal infers `String` for JS strings only with an explicit
// type hint; without it a domain would be encoded as a Symbol and the contract
// would reject the call.
function nativeToScValString(s: string): xdr.ScVal {
  return nativeToScVal(s, { type: "string" });
}
