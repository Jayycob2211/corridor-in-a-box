#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::storage::{Instance as _, Persistent as _},
    testutils::{Address as _, Events as _, Ledger as _},
    Address, BytesN, Env, Event as _, String,
};

/// Bit indices, mirroring SEP_NUMBERS / PROBE_NAMES. Spelled out here rather
/// than imported so a silent reordering in lib.rs fails these tests loudly.
const SEP1: u32 = 1 << 0;
const SEP6: u32 = 1 << 1;
const SEP10: u32 = 1 << 2;
const SEP12: u32 = 1 << 3;
const SEP31: u32 = 1 << 5;
const SEP38: u32 = 1 << 6;
const PROBE_TOML: u32 = 1 << 0;
const PROBE_SEP31_INFO: u32 = 1 << 4;
const PROBE_SEP6_INFO: u32 = 1 << 5;
const PROBE_SEP6_AUTH: u32 = 1 << 6;

struct Fixture {
    env: Env,
    client: RegistryClient<'static>,
    admin: Address,
    attester: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let attester = Address::generate(&env);
    let id = env.register(Registry, (admin.clone(), attester.clone()));
    let client = RegistryClient::new(&env, &id);
    Fixture {
        env,
        client,
        admin,
        attester,
    }
}

fn hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn domain(env: &Env) -> String {
    String::from_str(env, "testanchor.stellar.org")
}

#[test]
fn stores_and_reads_back_an_attestation() {
    let f = setup();
    let d = domain(&f.env);
    f.client.put_anchor(
        &d,
        &(SEP1 | SEP10 | SEP12 | SEP31 | SEP38),
        &hash(&f.env, 0xab),
        &(PROBE_TOML | PROBE_SEP31_INFO),
        &(PROBE_TOML | PROBE_SEP31_INFO),
        &f.attester,
    );

    let r = f.client.get_anchor(&d);
    assert_eq!(r.domain, d);
    assert_eq!(r.toml_hash, hash(&f.env, 0xab));
    assert_eq!(r.attester, f.attester);
    assert_eq!(f.client.domains().len(), 1);
}

#[test]
fn decodes_the_sep_bitmap_so_callers_never_see_it() {
    let f = setup();
    let d = domain(&f.env);
    f.client.put_anchor(
        &d,
        &(SEP10 | SEP31 | SEP38),
        &hash(&f.env, 1),
        &0,
        &0,
        &f.attester,
    );

    let seps = f.client.seps_for(&d);
    assert_eq!(seps.len(), 3);
    assert_eq!(seps.get(0).unwrap(), 10);
    assert_eq!(seps.get(1).unwrap(), 31);
    assert_eq!(seps.get(2).unwrap(), 38);
}

#[test]
fn re_attesting_updates_in_place_without_duplicating_the_domain() {
    let f = setup();
    let d = domain(&f.env);
    f.client
        .put_anchor(&d, &SEP31, &hash(&f.env, 1), &0, &0, &f.attester);
    f.client
        .put_anchor(&d, &(SEP31 | SEP38), &hash(&f.env, 2), &0, &0, &f.attester);

    assert_eq!(f.client.domains().len(), 1);
    assert_eq!(f.client.get_anchor(&d).toml_hash, hash(&f.env, 2));
}

// --- the staleness contract ---------------------------------------------
// An attestation is never "wrong", only old. These two tests are the reason
// attested_ledger exists at all.

#[test]
fn records_the_ledger_it_was_attested_at() {
    let f = setup();
    f.env.ledger().set_sequence_number(1_000);
    let d = domain(&f.env);
    f.client
        .put_anchor(&d, &SEP31, &hash(&f.env, 1), &0, &0, &f.attester);
    assert_eq!(f.client.attested_at(&d), 1_000);
}

#[test]
fn staleness_grows_with_the_ledger() {
    let f = setup();
    f.env.ledger().set_sequence_number(1_000);
    let d = domain(&f.env);
    f.client
        .put_anchor(&d, &SEP31, &hash(&f.env, 1), &0, &0, &f.attester);
    assert_eq!(f.client.staleness(&d), 0);

    f.env.ledger().set_sequence_number(401_000);
    assert_eq!(f.client.staleness(&d), 400_000);
}

// --- validation: the registry does not store whatever it is handed ---------

#[test]
fn rejects_a_probe_claimed_passed_without_being_run() {
    let f = setup();
    let d = domain(&f.env);
    let res = f.client.try_put_anchor(
        &d,
        &SEP31,
        &hash(&f.env, 1),
        &PROBE_TOML,                      // ran only the toml probe
        &(PROBE_TOML | PROBE_SEP31_INFO), // but claims two passed
        &f.attester,
    );
    assert_eq!(res, Err(Ok(Error::PassedExceedsRun)));
}

#[test]
fn rejects_bits_outside_the_defined_range() {
    let f = setup();
    let d = domain(&f.env);
    let undefined_sep_bit = 1u32 << 20;
    let res = f.client.try_put_anchor(
        &d,
        &undefined_sep_bit,
        &hash(&f.env, 1),
        &0,
        &0,
        &f.attester,
    );
    assert_eq!(res, Err(Ok(Error::UnknownBit)));

    let undefined_probe_bit = 1u32 << 20;
    let res = f.client.try_put_anchor(
        &d,
        &SEP31,
        &hash(&f.env, 1),
        &undefined_probe_bit,
        &0,
        &f.attester,
    );
    assert_eq!(res, Err(Ok(Error::UnknownBit)));

    // Bit 7 is index 7 (the 8th bit), which is currently undefined for PROBE_NAMES.
    let bit_7 = 1u32 << 7;
    let res = f
        .client
        .try_put_anchor(&d, &SEP31, &hash(&f.env, 1), &bit_7, &0, &f.attester);
    assert_eq!(res, Err(Ok(Error::UnknownBit)));
}

#[test]
fn unknown_domain_is_not_found_rather_than_a_default() {
    let f = setup();
    let res = f
        .client
        .try_get_anchor(&String::from_str(&f.env, "nope.example"));
    assert_eq!(res, Err(Ok(Error::NotFound)));
}

// --- the question operators actually ask ----------------------------------

#[test]
fn serves_sep31_requires_both_advertised_and_probed() {
    let f = setup();
    let d = domain(&f.env);

    // Advertises SEP-31 but the probe was never run: not a yes.
    f.client
        .put_anchor(&d, &SEP31, &hash(&f.env, 1), &0, &0, &f.attester);
    assert!(!f.client.serves_sep31(&d));

    // Probe ran and failed: still not a yes.
    f.client.put_anchor(
        &d,
        &SEP31,
        &hash(&f.env, 1),
        &PROBE_SEP31_INFO,
        &0,
        &f.attester,
    );
    assert!(!f.client.serves_sep31(&d));

    // Advertised and probed green.
    f.client.put_anchor(
        &d,
        &SEP31,
        &hash(&f.env, 1),
        &PROBE_SEP31_INFO,
        &PROBE_SEP31_INFO,
        &f.attester,
    );
    assert!(f.client.serves_sep31(&d));

    // Probed green but no longer advertised: not a yes either.
    f.client.put_anchor(
        &d,
        &SEP10,
        &hash(&f.env, 1),
        &PROBE_SEP31_INFO,
        &PROBE_SEP31_INFO,
        &f.attester,
    );
    assert!(!f.client.serves_sep31(&d));

    // Generic serves helper agrees
    assert!(!f.client.serves(&d, &10));
    assert!(!f.client.serves(&d, &999));
}

#[test]
fn serves_sep6_requires_both_advertised_and_probed() {
    let f = setup();
    let d = domain(&f.env);

    // Advertises SEP-6 but the probe was never run: not a yes.
    f.client
        .put_anchor(&d, &SEP6, &hash(&f.env, 1), &0, &0, &f.attester);
    assert!(!f.client.serves_sep6(&d));
    assert!(!f.client.serves(&d, &6));

    // Probe ran and failed: still not a yes.
    f.client.put_anchor(
        &d,
        &SEP6,
        &hash(&f.env, 1),
        &PROBE_SEP6_INFO,
        &0,
        &f.attester,
    );
    assert!(!f.client.serves_sep6(&d));
    assert!(!f.client.serves(&d, &6));

    // Advertised and probed green (sep6_info).
    f.client.put_anchor(
        &d,
        &SEP6,
        &hash(&f.env, 1),
        &(PROBE_SEP6_INFO | PROBE_SEP6_AUTH),
        &PROBE_SEP6_INFO,
        &f.attester,
    );
    assert!(f.client.serves_sep6(&d));
    assert!(f.client.serves(&d, &6));

    // Probed green but no longer advertised: not a yes either.
    f.client.put_anchor(
        &d,
        &SEP1,
        &hash(&f.env, 1),
        &PROBE_SEP6_INFO,
        &PROBE_SEP6_INFO,
        &f.attester,
    );
    assert!(!f.client.serves_sep6(&d));
    assert!(!f.client.serves(&d, &6));
}

#[test]
fn old_layout_record_still_answers_serves_sep31_correctly() {
    let f = setup();
    let d = domain(&f.env);

    // Simulate an old-layout record written when PROBE_NAMES only had 5 bits (0..=4).
    // It advertises SEP-31 and passed PROBE_TOML and PROBE_SEP31_INFO, but bits 5 and 6 (sep6) are 0.
    let old_probes_run = PROBE_TOML | PROBE_SEP31_INFO;
    let old_probes_passed = PROBE_TOML | PROBE_SEP31_INFO;
    f.client.put_anchor(
        &d,
        &(SEP1 | SEP31),
        &hash(&f.env, 1),
        &old_probes_run,
        &old_probes_passed,
        &f.attester,
    );

    // serves_sep31 and serves(31) should answer true
    assert!(f.client.serves_sep31(&d));
    assert!(f.client.serves(&d, &31));

    // serves_sep6 must be false for old records until re-attested
    assert!(!f.client.serves_sep6(&d));
    assert!(!f.client.serves(&d, &6));
}

// --- admin ---------------------------------------------------------------

#[test]
fn admin_can_rotate_the_attester() {
    let f = setup();
    let next = Address::generate(&f.env);
    f.client.set_attester(&next);
    assert_eq!(f.client.attester(), next);
    assert_eq!(f.client.admin(), f.admin);
}

/// Property-ish: every subset of the defined SEP bits round-trips through the
/// bitmap and back out of seps_for() with no loss and in ascending order.
#[test]
fn every_sep_combination_round_trips() {
    let f = setup();
    let d = domain(&f.env);
    let n = SEP_NUMBERS.len();

    for mask in 0u32..(1u32 << n) {
        f.client
            .put_anchor(&d, &mask, &hash(&f.env, 1), &0, &0, &f.attester);
        let got = f.client.seps_for(&d);

        let mut expected_len = 0u32;
        let mut previous = 0u32;
        for (i, sep) in SEP_NUMBERS.iter().enumerate() {
            if mask & (1u32 << i) != 0 {
                let actual = got.get(expected_len).unwrap();
                assert_eq!(
                    actual, *sep,
                    "mask {mask}: wrong sep at index {expected_len}"
                );
                assert!(actual > previous, "mask {mask}: not ascending");
                previous = actual;
                expected_len += 1;
            }
        }
        assert_eq!(got.len(), expected_len, "mask {mask}: wrong count");
    }
}

// ─── Storage lifetime ────────────────────────────────────────────────────────
//
// Soroban entries expire and are archived after their TTL. The unit-test
// environment does NOT archive: an entry past its `live_until` is still readable
// there, so reading a record back after advancing the ledger proves nothing.
// These tests assert the lifetime itself (`get_ttl`, ledgers left until expiry),
// advancing the ledger the way a quiet network would, and read the record back
// only as a sanity check on top.

/// The test environment's default minimum persistent TTL: what an entry that
/// nobody extended is given. Spelled out so a lifetime measured against it
/// cannot pass merely because the default changed.
const DEFAULT_TTL: u32 = 4_096;

fn advance(f: &Fixture, ledgers: u32) {
    f.env.ledger().with_mut(|l| l.sequence_number += ledgers);
}

fn put(f: &Fixture, d: &String) {
    f.client.put_anchor(
        d,
        &SEP31,
        &hash(&f.env, 1),
        &PROBE_SEP31_INFO,
        &PROBE_SEP31_INFO,
        &f.attester,
    );
}

fn record_ttl(f: &Fixture, d: &String) -> u32 {
    f.env.as_contract(&f.client.address, || {
        f.env
            .storage()
            .persistent()
            .get_ttl(&DataKey::Anchor(d.clone()))
    })
}

fn instance_ttl(f: &Fixture) -> u32 {
    f.env
        .as_contract(&f.client.address, || f.env.storage().instance().get_ttl())
}

#[test]
fn a_write_extends_the_record_and_the_instance() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    assert_eq!(record_ttl(&f, &d), TTL_EXTEND_TO);
    assert_eq!(instance_ttl(&f), TTL_EXTEND_TO);
}

#[test]
fn a_record_outlives_the_default_ttl_by_a_wide_margin() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    advance(&f, DEFAULT_TTL + 1);

    // Past the point a bare `set` would have expired, the record and the
    // instance still have the rest of their extension to run.
    assert_eq!(record_ttl(&f, &d), TTL_EXTEND_TO - DEFAULT_TTL - 1);
    assert_eq!(instance_ttl(&f), TTL_EXTEND_TO - DEFAULT_TTL - 1);
    // The list, the admin and the attester are all instance storage, and losing
    // it takes every read offline.
    assert_eq!(f.client.get_anchor(&d).domain, d);
    assert_eq!(f.client.domains().len(), 1);
    assert_eq!(f.client.admin(), f.admin);
    assert_eq!(f.client.attester(), f.attester);
}

#[test]
fn a_bare_set_gets_only_the_default_ttl() {
    // What the contract used to do, measured: an entry written with a plain `set`
    // lives for the default TTL and no longer, which is the lifetime every
    // assertion above is an improvement on.
    let f = setup();
    let d = domain(&f.env);
    let record = AnchorRecord {
        domain: d.clone(),
        seps: SEP31,
        toml_hash: hash(&f.env, 1),
        probes_run: PROBE_SEP31_INFO,
        probes_passed: PROBE_SEP31_INFO,
        attested_ledger: f.env.ledger().sequence(),
        attester: f.attester.clone(),
    };
    f.env.as_contract(&f.client.address, || {
        f.env
            .storage()
            .persistent()
            .set(&DataKey::Anchor(d.clone()), &record);
    });

    // The default counts the ledger the entry was created in, hence the one fewer.
    assert_eq!(record_ttl(&f, &d), DEFAULT_TTL - 1);
}

#[test]
fn bump_keeps_a_record_alive_without_re_attesting_it() {
    let f = setup();
    f.env.ledger().set_sequence_number(1_000);
    let d = domain(&f.env);
    put(&f, &d);
    let attested = f.client.attested_at(&d);

    // Nearly at the end of the lifetime a write bought, with nobody re-attesting.
    advance(&f, TTL_EXTEND_TO - 100);
    assert_eq!(record_ttl(&f, &d), 100);

    f.client.bump(&d);

    assert_eq!(record_ttl(&f, &d), TTL_EXTEND_TO);
    // A thousand ledgers on, past the point the original extension would have
    // run out, it still has nearly the full lifetime left, and it is still exactly
    // as old as it was: a bump is not an attestation.
    advance(&f, 1_000);
    assert_eq!(record_ttl(&f, &d), TTL_EXTEND_TO - 1_000);
    assert_eq!(f.client.get_anchor(&d).domain, d);
    assert_eq!(f.client.attested_at(&d), attested);
    assert_eq!(f.client.staleness(&d), TTL_EXTEND_TO - 100 + 1_000);
}

#[test]
fn without_a_bump_the_lifetime_just_runs_down() {
    // What a bump saves a record from: nothing refreshes the lifetime by itself,
    // and reads do not extend it.
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    advance(&f, TTL_EXTEND_TO - 1);
    let _ = f.client.get_anchor(&d);
    let _ = f.client.staleness(&d);

    assert_eq!(record_ttl(&f, &d), 1);
}

#[test]
fn bump_extends_the_instance_too() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);
    advance(&f, TTL_EXTEND_TO - 100);
    assert_eq!(instance_ttl(&f), 100);

    f.client.bump(&d);

    assert_eq!(instance_ttl(&f), TTL_EXTEND_TO);
    advance(&f, 1_000);
    assert_eq!(instance_ttl(&f), TTL_EXTEND_TO - 1_000);
    assert_eq!(f.client.domains().len(), 1);
    assert_eq!(f.client.admin(), f.admin);
}

#[test]
fn bump_needs_no_authorisation() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    f.client.bump(&d);

    // `mock_all_auths` records every authorisation a call asked for; a
    // permissionless call asks for none.
    assert!(f.env.auths().is_empty());
}

#[test]
fn bumping_an_unknown_domain_is_not_found() {
    let f = setup();
    let d = String::from_str(&f.env, "never-attested.example");

    assert_eq!(f.client.try_bump(&d), Err(Ok(Error::NotFound)));
}

#[test]
fn a_write_inside_the_threshold_does_not_pay_for_another_extension() {
    let f = setup();
    let d = domain(&f.env);
    put(&f, &d);

    // A day later the record still has far more than the threshold left, so a
    // re-attestation leaves its lifetime alone rather than re-buying it.
    advance(&f, LEDGERS_PER_DAY);
    put(&f, &d);

    assert_eq!(record_ttl(&f, &d), TTL_EXTEND_TO - LEDGERS_PER_DAY);
}

#[test]
fn rotating_the_attester_extends_the_instance() {
    let f = setup();
    advance(&f, TTL_EXTEND_TO - 100);
    assert_eq!(instance_ttl(&f), 100);

    f.client.set_attester(&Address::generate(&f.env));

    assert_eq!(instance_ttl(&f), TTL_EXTEND_TO);
}

#[test]
fn emits_full_attested_event_payload() {
    let f = setup();
    f.env.ledger().set_sequence_number(4_242);
    let d = domain(&f.env);
    let seps = SEP1 | SEP10 | SEP12 | SEP31 | SEP38;
    let probes_run = PROBE_TOML | PROBE_SEP31_INFO;
    let probes_passed = PROBE_TOML;
    let toml_hash = hash(&f.env, 0xcd);

    f.client.put_anchor(
        &d,
        &seps,
        &toml_hash,
        &probes_run,
        &probes_passed,
        &f.attester,
    );

    let all_events = f.env.events().all();
    let events = all_events.events();
    assert_eq!(events.len(), 1);
    let expected = Attested {
        domain: d,
        seps,
        toml_hash,
        probes_run,
        probes_passed,
        attested_ledger: 4_242,
        attester: f.attester.clone(),
    }
    .to_xdr(&f.env, &f.client.address);
    assert_eq!(events[0], expected);
}
