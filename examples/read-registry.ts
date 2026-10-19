// Read the on-chain anchor registry through @corridor/registry.
//
//   pnpm registry:read
//   pnpm registry:read --sep 24 --passed sep10_auth --max-age 120960 --json
//
// Hits the deployed testnet contract for real — no mocks, no fixtures. The
// addresses come from contracts/deployments.json so this and the dashboard
// always read the same registry the attester writes to.
//
// Filters intersect, so an anchor is listed only when it satisfies every flag
// you pass. It must advertise every `--sep`, pass every `--passed`, and be no
// staler than `--max-age`. Unknown SEP numbers and probe names are refused
// rather than silently matching nothing.

import { readFileSync } from "node:fs";
import {
  AnchorRegistry,
  filterAttestations,
  PROBE_NAMES,
  SEP_NUMBERS,
  type AnchorAttestation,
  type AttestationFilter,
  type ProbeName,
} from "@corridor/registry";

interface Deployments {
  [network: string]: {
    networkPassphrase: string;
    rpcUrl: string;
    registry: string | null;
    attester: string | null;
  };
}

const USAGE = [
  "usage: pnpm registry:read [--sep <n>]... [--passed <probe>]... [--max-age <ledgers>] [--json]",
  "",
  "  --sep <n>          only anchors advertising SEP-<n>; repeatable, narrows",
  `                     one of: ${SEP_NUMBERS.map((n) => `SEP-${n}`).join(", ")}`,
  "  --passed <probe>   only anchors that passed <probe>; repeatable, narrows",
  `                     one of: ${PROBE_NAMES.join(", ")}`,
  "  --max-age <n>      only attestations at most <n> ledgers old",
  "  --json             print the matching attestations as JSON",
].join("\n");

interface Options {
  readonly filter: AttestationFilter;
  readonly json: boolean;
  /** Whether any filter was passed, so the unfiltered SEP-31 summary is skipped. */
  readonly filtered: boolean;
}

/**
 * Parse the flags. Returns a message rather than throwing, so `main` prints it
 * to stderr and exits 2, the same usage-error contract the other examples use.
 * A filter that silently matches nothing is worse than one that says why.
 */
function parseArgs(
  argv: readonly string[],
): { ok: true; options: Options } | { ok: false; error: string } {
  const sep: number[] = [];
  const passed: ProbeName[] = [];
  let maxAge: number | undefined;
  let json = false;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    // `--flag=value` carries its own value; otherwise the next entry is it.
    const value = (): string | undefined => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) return undefined;
      i += 1;
      return next;
    };

    if (flag === "--json") {
      if (inline !== undefined) return { ok: false, error: "--json takes no value" };
      json = true;
    } else if (flag === "--sep") {
      const raw = value();
      if (raw === undefined) return { ok: false, error: "--sep needs a SEP number" };
      const n = Number(raw);
      if (!Number.isInteger(n) || !(SEP_NUMBERS as readonly number[]).includes(n)) {
        return { ok: false, error: `unknown SEP number: ${raw}` };
      }
      sep.push(n);
    } else if (flag === "--passed") {
      const raw = value();
      if (raw === undefined) return { ok: false, error: "--passed needs a probe name" };
      if (!(PROBE_NAMES as readonly string[]).includes(raw)) {
        return { ok: false, error: `unknown probe name: ${raw}` };
      }
      passed.push(raw as ProbeName);
    } else if (flag === "--max-age") {
      const raw = value();
      if (raw === undefined) return { ok: false, error: "--max-age needs a ledger count" };
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        return { ok: false, error: `--max-age needs a non-negative integer, got: ${raw}` };
      }
      maxAge = n;
    } else {
      return { ok: false, error: `unknown argument: ${arg}` };
    }
    i += 1;
  }

  return {
    ok: true,
    options: {
      filter: { sep, passed, maxAge },
      json,
      filtered: sep.length > 0 || passed.length > 0 || maxAge !== undefined,
    },
  };
}

/** An attestation plus how stale it is, the shape `--json` emits. */
interface StaleAttestation extends AnchorAttestation {
  readonly staleness: number;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`${parsed.error}\n\n${USAGE}`);
    process.exit(2);
  }
  const { filter, json, filtered } = parsed.options;

  const network = process.env.STELLAR_NETWORK ?? "testnet";
  const deployments = JSON.parse(
    readFileSync(new URL("../contracts/deployments.json", import.meta.url), "utf8"),
  ) as Deployments;

  const cfg = deployments[network];
  if (!cfg?.registry) {
    console.error(`✗ no registry deployed on ${network} (see contracts/deployments.json)`);
    process.exit(1);
  }

  const registry = new AnchorRegistry({
    rpcUrl: cfg.rpcUrl,
    contractId: cfg.registry,
    networkPassphrase: cfg.networkPassphrase,
  });

  if (!json) console.log(`registry ${cfg.registry} on ${network}\n`);

  const domains = await registry.domains();
  if (domains.length === 0) {
    console.log(json ? "[]" : "no attestations yet.");
    return;
  }

  const records = await Promise.all(domains.map((domain) => registry.getAnchor(domain)));
  const stalenessByDomain: Record<string, number> = {};
  for (const domain of domains) {
    stalenessByDomain[domain] = await registry.staleness(domain);
  }

  const matches = filterAttestations(records, stalenessByDomain, filter);

  if (json) {
    const out: StaleAttestation[] = matches.map((a) => ({
      ...a,
      staleness: stalenessByDomain[a.domain],
    }));
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (matches.length === 0) {
    console.log("no attestations match the given filters.");
    return;
  }

  for (const a of matches) {
    const failed = a.probesRun.filter((p) => !a.probesPassed.includes(p));
    console.log(a.domain);
    console.log(`  advertises     ${a.seps.map((n) => `SEP-${n}`).join(", ")}`);
    console.log(`  probes passed  ${a.probesPassed.join(", ") || "none"}`);
    console.log(`  probes FAILED  ${failed.join(", ") || "none"}`);
    console.log(`  toml sha256    ${a.tomlHash.slice(0, 32)}…`);
    console.log(
      `  attested at    ledger ${a.attestedLedger} (${stalenessByDomain[a.domain]} ledgers ago)`,
    );
    console.log(`  serves SEP-31  ${(await registry.servesSep31(a.domain)) ? "YES" : "NO"}`);
    console.log(`  serves SEP-6   ${(await registry.servesSep6(a.domain)) ? "YES" : "NO"}`);
    console.log();
  }

  if (!filtered) {
    const live31 = await registry.liveSep31Anchors();
    console.log(
      `usable SEP-31 off-ramps (attested + fresh): ${live31.length ? live31.join(", ") : "none"}`,
    );

    const live6 = await registry.liveAnchors("sep6");
    console.log(
      `usable SEP-6 off-ramps (attested + fresh): ${live6.length ? live6.join(", ") : "none"}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
