// filterAttestations answers the question an operator actually has, "which
// anchors advertise SEP-24 and passed SEP-10, attested this week?", so what is
// tested here is that filters NARROW. Every supplied condition is required, and
// adding one never widens the result.

import { describe, expect, it } from "vitest";
import { filterAttestations, type AnchorAttestation } from "@corridor/registry";

function att(
  domain: string,
  over: Omit<Partial<AnchorAttestation>, "domain"> = {},
): AnchorAttestation {
  return {
    domain,
    seps: over.seps ?? [],
    probesRun: over.probesRun ?? [],
    probesPassed: over.probesPassed ?? [],
    tomlHash: over.tomlHash ?? "0".repeat(64),
    attestedLedger: over.attestedLedger ?? 100,
    attester: over.attester ?? "GATTESTER",
  };
}

const RECORDS: readonly AnchorAttestation[] = [
  att("a.example", {
    seps: [10, 24, 31],
    probesRun: ["sep10_auth", "sep31_info"],
    probesPassed: ["sep10_auth", "sep31_info"],
  }),
  att("b.example", {
    seps: [10, 24],
    probesRun: ["sep10_auth", "sep12_status"],
    probesPassed: ["sep10_auth"],
  }),
  att("c.example", {
    seps: [6, 10],
    probesRun: ["sep10_auth"],
    probesPassed: ["sep10_auth"],
  }),
];

const STALENESS: Record<string, number> = {
  "a.example": 100,
  "b.example": 5_000,
  "c.example": 200_000,
};

const domains = (records: readonly AnchorAttestation[]): string[] =>
  records.map((r) => r.domain);

describe("filterAttestations", () => {
  it("returns every record, in order, when no filter is given", () => {
    expect(domains(filterAttestations(RECORDS, STALENESS))).toEqual([
      "a.example",
      "b.example",
      "c.example",
    ]);
  });

  it("keeps only anchors advertising the SEP", () => {
    const filtered = filterAttestations(RECORDS, STALENESS, { sep: [24] });
    expect(domains(filtered)).toEqual(["a.example", "b.example"]);
  });

  it("requires every SEP when several are given", () => {
    const filtered = filterAttestations(RECORDS, STALENESS, { sep: [10, 24, 31] });
    expect(domains(filtered)).toEqual(["a.example"]);
  });

  it("keeps only anchors that passed the probe", () => {
    const filtered = filterAttestations(RECORDS, STALENESS, { passed: ["sep31_info"] });
    expect(domains(filtered)).toEqual(["a.example"]);
  });

  it("does not count a probe that was only RUN, not passed", () => {
    // b.example ran sep12_status but did not pass it, so it is not a match.
    const filtered = filterAttestations(RECORDS, STALENESS, { passed: ["sep12_status"] });
    expect(domains(filtered)).toEqual([]);
  });

  it("drops attestations staler than maxAge, keeping the one exactly on it", () => {
    // a=100 and b=5000 are within 5000; c=200000 is not.
    const filtered = filterAttestations(RECORDS, STALENESS, { maxAge: 5_000 });
    expect(domains(filtered)).toEqual(["a.example", "b.example"]);
  });

  it("fails closed when a record has no staleness on file", () => {
    const filtered = filterAttestations(RECORDS, { "a.example": 1 }, { maxAge: 100 });
    expect(domains(filtered)).toEqual(["a.example"]);
  });

  it("intersects sep, passed and maxAge", () => {
    // Advertises SEP-24 AND passed sep10_auth AND is fresh: a and b clear the
    // first two; only a is within 1000 ledgers.
    const filtered = filterAttestations(RECORDS, STALENESS, {
      sep: [24],
      passed: ["sep10_auth"],
      maxAge: 1_000,
    });
    expect(domains(filtered)).toEqual(["a.example"]);
  });

  it("returns nothing when no record can satisfy the filters", () => {
    expect(filterAttestations(RECORDS, STALENESS, { sep: [38] })).toEqual([]);
  });
});
