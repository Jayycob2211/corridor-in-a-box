// The orchestrator. execute() runs one payment across one corridor:
//   quote → comply → open → settle → reconcile → complete
// driving the state machine, persisting after each step (so it's resumable), and
// routing failures through recover(). It is corridor-AGNOSTIC: every corridor-
// specific fact arrives via the validated manifest, every anchor-specific fact via
// the injected RouteResolver/adapters. Add a corridor = add a manifest.

import { liveness, type Corridor, type LivenessState } from "@corridor/manifest";
import {
  compareAmounts,
  fail,
  isSettleableAmount,
  ok,
  type CorridorError,
  type Money,
  type Outcome,
  type PaymentIntent,
} from "@corridor/types";
import type { RouteResolver } from "@corridor/router";
import { ExternalQuoteProvider, type ExternalQuoteFn } from "@corridor/adapter-kit";
import { canTransition, isTerminal, type CorridorState } from "./state";
import {
  InMemoryIdempotencyStore,
  hasRequestedRefund,
  type IdempotencyStore,
  type StoredRun,
} from "./idempotency";
import type {
  ChainVerifier,
  RefundRequest,
  SettlementRef,
  SettlementRequest,
  SettlementStrategy,
  SettlementSubmitter,
} from "./ports";
import {
  anchorTerminalStatus,
  backoffMs,
  buildSettlementRequest,
  comply,
  open,
  quote,
  recover,
  reconcileUntil,
  settle,
  watchRefund,
  settleQuoteProblem,
} from "./verbs";
import type { AnchorAdapter, TransactionStatus } from "@corridor/adapter-kit";
import { defaultStrategies } from "./ports";
import {
  noopMetrics,
  silentLogger,
  type AuditEntry,
  type AuditSink,
  type Alerting,
  type Logger,
  type Metrics,
} from "./observability";
import type { CheckResult, GateContext, PreSettleGate } from "./gate";
import {
  BREAKER_METRICS,
  MeteredCorridorHealthStore,
  breakerOutcomeFor,
  recoveredBreakerCause,
  type CorridorHealthStore,
} from "./breaker";

export interface EngineDeps {
  resolver: RouteResolver;
  submitter: SettlementSubmitter;
  gate?: PreSettleGate;
  /**
   * Optional independent check that the settle transaction really paid what
   * was requested. Runs once after `settled` (and again on resume from
   * `settled`), before the run may become `reconciled`. A failure is treated
   * like any post-settle failure: money moved, so it goes to the manifest's
   * `hold` / `refund_sender` path rather than `failed`.
   */
  chainVerifier?: ChainVerifier;
  /**
   * Explicit list of settlement strategies. When omitted, the engine derives
   * `[new StellarPaymentStrategy(deps.submitter)]` so all existing callers
   * keep working with no changes.
   *
   * Provide this when you need to handle settlement kinds beyond
   * `stellar_payment` (e.g. after issue #183 lands). The engine dispatches
   * to the first strategy whose `kind` matches the deposit instructions kind
   * returned by the receiving anchor.
   */
  strategies?: readonly SettlementStrategy[];
  idempotency?: IdempotencyStore;
  waker?: import("./ports").ReconcileWaker;
  now?: () => number;
  /** Injectable sleep so tests don't wait on real backoff/poll delays. */
  sleep?: (ms: number) => Promise<void>;
  /** Delay between reconcile polls (ms). Defaults to 2s. Overridden by `recovery.reconcile.poll_seconds` in the manifest. */
  reconcilePollMs?: number;
  /**
   * Consecutive polls with the same status before bailing with
   * `RECONCILE_STALLED`. Defaults to 10. Set to `0` to disable. Overridden by
   * `recovery.reconcile.stall_polls` in the manifest.
   */
  stallThreshold?: number;
  /** Structured logger. Defaults to a silent logger. */
  logger?: Logger;
  /** Append-only audit sink; receives one entry per state transition. */
  audit?: AuditSink;
  /** Best-effort operational alerts. Failures are logged and never alter a run. */
  alerting?: Alerting;
  /** Counter/timing sink. Defaults to a no-op. */
  metrics?: Metrics;
  /** Maximum payment amount while a corridor has no fresh canary proof. Defaults to "10". */
  unprovenMaxAmount?: string;
  /**
   * Per-corridor circuit breaker. Once `recovery.breaker.consecutive_failures`
   * lane-level failures land in a row, new runs on that corridor are refused
   * with `CORRIDOR_HALTED` until someone runs
   * `corridor breaker reset <id> --reason "…"`.
   *
   * Omit it and the breaker is simply absent — the engine is unchanged, so this
   * stays opt-in like every other store. In production this must be the shared
   * `PostgresCorridorHealthStore`, not the in-memory one: a per-replica count
   * lets a peer replica keep taking payments on a lane another has halted.
   */
  health?: CorridorHealthStore;
  /**
   * Explicit opt-in allowing manifest-trusted routes on a public network without
   * on-chain attestation.
   */
  trustManifestWithoutAttestation?: boolean;
  /**
   * Pricing function for corridors with `fx.quote_source: external`. Required
   * for those corridors; the engine never makes a SEP-38 call for them.
   */
  externalQuote?: ExternalQuoteFn;
  /**
   * Explicit escape hatch skipping pre-settle verification. When true, execute() bypasses gate
   * evaluation while recording `gate.skipped` in the audit log and emitting a warning.
   */
  unsafeSkipPreSettleGate?: boolean;
}

export interface RunResult {
  readonly idempotencyKey: string;
  readonly state: CorridorState;
  readonly transactionId?: string;
  readonly stellarTxHash?: string;
  /** Ordered list of states the run passed through — useful for the example/CLI. */
  readonly trail: readonly CorridorState[];
}

export interface ExecuteOptions {
  /**
   * Opaque tenant id recorded on the run so later reads can be scoped to their
   * creator. Callers must derive this from an already-VALIDATED credential (an
   * authenticated API key), never from the request body — otherwise a client
   * simply claims someone else's tenancy.
   */
  owner?: string;
  /**
   * Explicit opt-in allowing manifest-trusted routes on a public network without
   * on-chain attestation.
   */
  trustManifestWithoutAttestation?: boolean;
}

/**
 * Fold a finished run into the lane's breaker. The run's terminal state and the
 * error that produced it are the only inputs: whether a failure says anything
 * about the LANE (rather than about this one request) is decided by
 * `breakerOutcomeFor`, not here.
 *
 * A lane failure is counted once, when the run RESOLVES `(failed`, `refunded`,
 * `hold`) -- never when it merely parks in `refund_pending`, which is still in
 * flight and may yet be resolved either way by the anchor's refund report.
 */
type RecordOutcome = (state: CorridorState, e?: CorridorError) => Promise<void>;

function makeRecordOutcome(
  deps: EngineDeps,
  corridor: Corridor,
  health: CorridorHealthStore | undefined,
  now: () => number,
): RecordOutcome {
  const breakerOpts = { threshold: corridor.recovery.breaker.consecutive_failures };
  return async (state, e) => {
    if (!health) return;
    const outcome = breakerOutcomeFor(state, e?.code);
    if (outcome === "neutral") return;
    await health.recordOutcome(corridor.id, outcome, now(), {
      ...breakerOpts,
      // Stored verbatim, so it is exactly what the run's own `lastError` shows.
      ...(e && { error: `${e.code}: ${e.message}` }),
    });
  };
}

export async function execute(
  intent: PaymentIntent,
  corridor: Corridor,
  deps: EngineDeps,
  opts: ExecuteOptions = {},
): Promise<Outcome<RunResult>> {
  const store = deps.idempotency ?? new InMemoryIdempotencyStore();
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(((r) => setTimeout(r, ms))));
  // Manifest value wins, then EngineDeps, then the engine default.
  const rc = corridor.recovery.reconcile;
  const pollMs =
    rc?.poll_seconds !== undefined ? rc.poll_seconds * 1000 : (deps.reconcilePollMs ?? 2_000);
  const stallThreshold = rc?.stall_polls ?? deps.stallThreshold ?? 10;
  const externalStallMs = externalStallBudgetMs(corridor);
  const metrics = deps.metrics ?? noopMetrics;
  const startedAt = now();

  // Wrap once, here, so every trip and reset is counted even when the embedding
  // application never met the meter. An already-metered store is left alone so
  // that an app which wired the meter itself does not double-count.
  const health = meteredHealth(deps);
  const recordOutcome = makeRecordOutcome(deps, corridor, health, now);

  // Time a verb call and emit a `corridor.verb.<name>`
  // histogram sample.
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const begin = now();
    const r = await fn();
    metrics.timing(`corridor.verb.${name}`, now() - begin, { corridor: corridor.id });
    return r;
  };

  // --- configuration guard: pre-settle gate is mandatory by default.
  // Fail closed before claiming idempotency key (no run row persisted) unless
  // an explicit opt-out is provided.
  if (!deps.gate && deps.unsafeSkipPreSettleGate !== true) {
    return fail(
      "ENGINE_MISCONFIGURED",
      "Pre-settle gate is mandatory; provide deps.gate or set unsafeSkipPreSettleGate",
    );
  }

  // --- idempotency claim
  const existing = await store.get(intent.idempotencyKey);
  if (existing) {
    if (isTerminal(existing.state)) {
      return ok(toResult(existing));
    }
    // Not terminal: try to resume from the stored state.
    return resume(existing, intent, corridor, deps, opts, {
      store,
      now,
      sleep,
      pollMs,
      stallThreshold,
      externalStallMs,
      metrics,
      startedAt,
      health,
      recordOutcome,
      timed,
    });
  }

  const run: StoredRun = {
    idempotencyKey: intent.idempotencyKey,
    state: "created",
    trail: ["created"],
    createdAt: now(),
    updatedAt: now(),
    ...(opts.owner !== undefined && { owner: opts.owner }),
  };
  const claim = await store.create(run);
  if (!claim.created) {
    // Raced with another caller; resume from whatever they persisted.
    return resume(claim.run, intent, corridor, deps, opts, {
      store,
      now,
      sleep,
      pollMs,
      stallThreshold,
      externalStallMs,
      metrics,
      startedAt,
      health,
      recordOutcome,
      timed,
    });
  }

  return drive(claim.run, intent, corridor, deps, opts, {
    store,
    now,
    sleep,
    pollMs,
    stallThreshold,
    externalStallMs,
    metrics,
    startedAt,
    health,
    recordOutcome,
    timed,
  });
}

// --- shared context for the drive/resume pair ---

interface Ctx {
  store: IdempotencyStore;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  stallThreshold: number;
  externalStallMs: number | undefined;
  metrics: Metrics;
  startedAt: number;
  health: CorridorHealthStore | undefined;
  recordOutcome: RecordOutcome;
  timed: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

function toResult(run: StoredRun): RunResult {
  return {
    idempotencyKey: run.idempotencyKey,
    state: run.state,
    trail: [...run.trail],
    ...(run.transactionId !== undefined && { transactionId: run.transactionId }),
    ...(run.stellarTxHash !== undefined && { stellarTxHash: run.stellarTxHash }),
  };
}

// --- resume: drive an existing run forward from its stored state ---

async function resume(
  run: StoredRun,
  intent: PaymentIntent,
  corridor: Corridor,
  deps: EngineDeps,
  opts: ExecuteOptions,
  ctx: Ctx,
): Promise<Outcome<RunResult>> {
  // A `settled` run is already post-money. If the resolver throws here we must
  // not move it to `failed` -- leave it resumable and return the error.
  if (run.state === "settled") {
    try {
      await deps.resolver.resolve(corridor, intent);
    } catch (e) {
      return fail(toCorridorError(e));
    }
  }
  return drive(run, intent, corridor, deps, opts, ctx);
}

// --- drive: the main state machine ---

async function drive(
  run: StoredRun,
  intent: PaymentIntent,
  corridor: Corridor,
  deps: EngineDeps,
  opts: ExecuteOptions,
  ctx: Ctx,
): Promise<Outcome<RunResult>> {
  const { store, now, sleep, pollMs, stallThreshold, externalStallMs, metrics, startedAt, health, recordOutcome, timed } = ctx;
  const logger = deps.logger ?? silentLogger;
  const audit = deps.audit;
  const alerting = deps.alerting;
  const nowIso = () => new Date(now()).toISOString();

  // Persist a state transition and append an audit entry. The run is always
  // written before the audit entry so a crash never leaves an audit record
  // for a state that was not durable.
  const transition = async (
    to: CorridorState,
    extra: Partial<StoredRun> = {},
    auditExtra: Partial<AuditEntry> = {},
  ): Promise<StoredRun> => {
    if (!canTransition(run.state, to)) {
      throw new Error(`Illegal transition ${run.state} -> ${to}`);
    }
    const from = run.state;
    const updated: StoredRun = {
      ...run,
      ...extra,
      state: to,
      trail: [...run.trail, to],
      updatedAt: now(),
    };
    await store.update(updated);
    Object.assign(run, updated);
    if (audit) {
      await audit.append({
        idempotencyKey: run.idempotencyKey,
        corridorId: corridor.id,
        from,
        to,
        at: nowIso(),
        ...auditExtra,
      });
    }
    return run;
  };

  // Route a terminal failure through recover() and persist the result.
  // This is the single die() path that moves a run out of in-flight states.
  const die = async (e: CorridorError): Promise<Outcome<RunResult>> => {
    const decision = recover(corridor, run.state, e);
    await transition(decision.state, { lastError: e }, { error: e });
    await recordOutcome(decision.state, e);
    if (alerting && decision.state !== "failed") {
      await alerting.alert({
        corridorId: corridor.id,
        idempotencyKey: run.idempotencyKey,
        severity: "warn",
        code: e.code,
        message: e.message,
      });
    }
    return fail(e.code, e.message);
  };

  // Resolve the route once. Any throw -- including UnnattestedAnchorError --
  // is routed through die() so the run moves created -> failed with an
  // audit entry instead of stranding at created.
  let route: Awaited<ReturnType<RouteResolver["resolve"]>>;
  try {
    route = await timed("resolve", () => deps.resolver.resolve(corridor, intent));
  } catch (e) {
    return die(toCorridorError(e));
  }

  // --- quote
  if (run.state === "created") {
    const quoteResult = await timed("quote", () =>
      quote(corridor, intent, route, {
        externalQuote: deps.externalQuote,
        now,
      }),
    );
    if (!quoteResult.ok) return die(quoteResult.error);
    const quoteProblem = settleQuoteProblem(corridor, quoteResult.value);
    if (quoteProblem) return die(quoteProblem);
    await transition("quoted", { quote: quoteResult.value });
  }

  // --- comply
  if (run.state === "quoted") {
    const complyResult = await timed("comply", () =>
      comply(corridor, intent, route, {
        now,
        unprovenMaxAmount: deps.unprovenMaxAmount,
      }),
    );
    if (!complyResult.ok) return die(complyResult.error);
    await transition("complied", { compliance: complyResult.value });
  }

  // --- open
  if (run.state === "complied") {
    const openResult = await timed("open", () =>
      open(corridor, intent, route, { now }),
    );
    if (!openResult.ok) return die(openResult.error);
    await transition("opened", { deposit: openResult.value });
  }

  // --- pre-settle gate
  if (run.state === "opened") {
    if (deps.unsafeSkipPreSettleGate === true) {
      logger.warn("pre-settle gate skipped via unsafeSkipPreSettleGate", {
        corridor: corridor.id,
        idempotencyKey: run.idempotencyKey,
      });
      await transition("gated_skipped");
    } else {
      const gate = deps.gate;
      if (!gate) {
        return die({
          code: "ENGINE_MISCONFIGURED",
          message: "Pre-settle gate is mandatory",
        });
      }
      const gateCtx: GateContext = {
        corridor,
        intent,
        route,
        now,
      };
      const gateResult = await timed("gate", () => gate.evaluate(gateCtx));
      if (!gateResult.ok) return die(gateResult.error);
      const checks: readonly CheckResult[] = gateResult.value;
      const refused = checks.find((c) => !c.ok);
      if (refused) {
        return die({
          code: "GATE_REFUSED",
          message: refused.reason ?? "Pre-settle gate refused",
        });
      }
      await transition("gated_ok", { gateChecks: checks });
    }
  }

  // --- settle
  if (run.state === "gated_ok" || run.state === "gated_skipped") {
    const strategies = deps.strategies ?? defaultStrategies(deps.submitter);
    const req = buildSettlementRequest(corridor, intent, route, run.deposit!);
    const strategy = strategies.find((s) => s.kind === req.kind);
    if (!strategy) {
      return die({
        code: "UNSUPPORTED_SETTLEMENT_KIND",
        message: `No strategy for settlement kind ${req.kind}`,
      });
    }
    const settleResult = await timed("settle", () => settle(strategy, req));
    if (!settleResult.ok) return die(settleResult.error);
    await transition("settled", {
      transactionId: settleResult.value.transactionId,
      ...(settleResult.value.stellarTxHash !== undefined && {
        stellarTxHash: settleResult.value.stellarTxHash,
      }),
    });
  }

  // --- chain verification (after settled, before reconcile)
  if (run.state === "settled" && deps.chainVerifier) {
    const verified = await timed("verify", () =>
      deps.chainVerifier!.verify({
        corridor,
        intent,
        transactionId: run.transactionId,
        stellarTxHash: run.stellarTxHash,
        expected: route.quote.sendAmount,
      }),
    );
    if (!verified.ok) return die(verified.error);
  }

  // --- reconcile
  if (run.state === "settled") {
    const reconcileResult = await timed("reconcile", () =>
      reconcileUntil(corridor, run, {
        submitter: deps.submitter,
        now,
        sleep,
        pollMs,
        stallThreshold,
        externalStallMs,
      }),
    );
    if (!reconcileResult.ok) return die(reconcileResult.error);
    await transition("reconciled", { reconcile: reconcileResult.value });
  }

  // --- complete
  if (run.state === "reconciled") {
    await transition("completed");
    await recordOutcome("completed");
  }

  // --- refund watch (refund_pending -> refunded)
  if (run.state === "refund_pending") {
    const refundResult = await timed("watchRefund", () =>
      watchRefund(corridor, run, {
        submitter: deps.submitter,
        now,
        sleep,
        pollMs,
        stallThreshold,
      }),
    );
    if (!refundResult.ok) return die(refundResult.error);
    await transition("refunded", { refund: refundResult.value });
    await recordOutcome("refunded");
  }

  return ok(toResult(run));
}

// --- helpers ---

function toCorridorError(e: unknown): CorridorError {
  if (isCorridorError(e)) return e;
  const message = e instanceof Error ? e.message : String(e);
  // UnnattestedAnchorError and other route refusals are not retryable.
  const name = e instanceof Error ? e.name : "";
  if (name === "UnattestedAnchorError") {
    return { code: "ROUTE_REFUSED", message, retryable: false };
  }
  return { code: "ROUTE_REFUSED", message, retryable: false };
}

function isCorridorError(e: unknown): e is CorridorError {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as CorridorError).code === "string" &&
    typeof (e as CorridorError).message === "string"
);
}

function meteredHealth(deps: EngineDeps): CorridorHealthStore | undefined {
  const h = deps.health;
  if (!h) return undefined;
  if (h instanceof MeteredCorridorHealthStore) return h;
  return new MeteredCorridorHealthStore(h, deps.metrics ?? noopMetrics);
}

function externalStallBudgetMs(corridor: Corridor): number | undefined {
  const ext = (corridor as { external?: { stall_ms?: number } }).external;
  return ext?.stall_ms;
}
