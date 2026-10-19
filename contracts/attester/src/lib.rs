#![no_std]
//! # corridor-attester
//!
//! Who may write to the [registry](../../registry), and under what conditions.
//!
//! ## Why this is a separate contract
//!
//! The registry stores facts; this contract decides whose facts count. Keeping
//! them apart means the authorisation policy can change — add attesters, require
//! more of them, rate-limit a noisy one — without touching the contract that
//! holds the data, and without every consumer having to re-point at a new
//! registry address. The registry trusts exactly one address (this contract) and
//! nothing else, so the whole policy surface lives here.
//!
//! ## The submission path
//!
//! An attester calls `attest()`. This contract checks the caller is authorised
//! and the payload is well-formed, then cross-invokes `registry.put_anchor()`.
//! Soroban authorises that sub-invocation with this contract's own address,
//! which is what the registry requires — so there is no shared secret and no
//! hand-rolled signature check anywhere in the path.
//!
//! ## Rate limiting
//!
//! An attester may re-attest a given domain only once every `min_interval`
//! ledgers. Without it, a compromised or buggy attester can rewrite a record
//! every ledger, which both burns fees and destroys the freshness signal the
//! registry exists to provide — `attested_ledger` would always be "now" and
//! would tell a consumer nothing.
//!
//! ## Storage lifetime
//!
//! Soroban persistent and instance entries expire after their TTL and are then
//! archived. Every write here extends the entry it touched (an enrolment, a
//! domain's cooldown marker) and the contract instance (`Admin`, `Registry`,
//! `MinInterval`, whose expiry takes the contract offline), by the constants
//! below. `attest` also extends the signer's own enrolment, so an attester that
//! keeps attesting never lapses. An enrolled attester that goes quiet for longer
//! than the TTL does lapse, and `is_attester` then fails for it; the admin
//! restores the entry (or simply calls `add_attester` again once it is restored)
//! to bring it back. Restoring an archived entry is a `RestoreFootprint`
//! operation, which the Stellar CLI wraps as `stellar contract restore`; see the
//! registry crate's header for the details, which apply here unchanged.

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, Address,
    BytesN, Env, String,
};

/// The slice of the registry's interface this contract calls.
///
/// Declared as a trait rather than by depending on the `corridor-registry`
/// crate: linking the registry's implementation into this wasm pulls in its
/// `__constructor` too, and two contracts exporting that symbol fails to link
/// ("symbol multiply defined"). A `#[contractclient]` trait generates the same
/// typed client from the signature alone, with no code linked and no build-order
/// coupling between the two crates.
///
/// The real registry is still used in this crate's tests, where compilation
/// targets native rather than wasm and no such collision exists — so the
/// cross-call is exercised against the actual contract, not a stand-in.
#[contractclient(name = "RegistryClient")]
pub trait RegistryInterface {
    fn put_anchor(
        env: Env,
        domain: String,
        seps: u32,
        toml_hash: BytesN<32>,
        probes_run: u32,
        probes_passed: u32,
        attester: Address,
    );
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Registry,
    /// Minimum ledgers between attestations for the same domain.
    MinInterval,
    /// Set membership for an authorised attester.
    Attester(Address),
    /// Ledger of the last accepted attestation for a domain, for rate limiting.
    LastAttest(String),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialised = 1,
    /// The caller is not in the authorised attester set.
    NotAnAttester = 2,
    /// Re-attested the same domain before `min_interval` ledgers had passed.
    TooSoon = 3,
    /// A domain must be a plausible host, not an empty or absurd string.
    InvalidDomain = 4,
}

/// Ledgers close about every 5 seconds.
pub const LEDGERS_PER_DAY: u32 = 17_280;

/// An entry is only extended once its remaining TTL has fallen below this, so a
/// burst of writes pays for one extension rather than one each. 30 days. Kept in
/// step with the registry's constant of the same name (this crate cannot depend
/// on the registry's implementation, see the note on `RegistryInterface`).
pub const TTL_THRESHOLD: u32 = 30 * LEDGERS_PER_DAY;

/// What a write extends an entry to. 90 days: inside the network's maximum entry
/// TTL, where an extension past it is an error rather than a clamp.
pub const TTL_EXTEND_TO: u32 = 90 * LEDGERS_PER_DAY;

/// Guards against a caller writing an empty key or an unbounded blob into the
/// registry's domain list, where it would be permanent and readable by everyone.
const MAX_DOMAIN_LEN: u32 = 253; // RFC 1035 maximum hostname length.

/// Emitted when an attestation is accepted and relayed to the registry.
#[contractevent]
pub struct Attested {
    #[topic]
    pub domain: String,
    pub attester: Address,
}

/// Keeps the contract instance (and its code) alive.
fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

/// Keeps one persistent entry (an enrolment or a cooldown marker) alive.
fn extend_entry(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

#[contract]
pub struct Attester;

#[contractimpl]
impl Attester {
    /// `admin` manages the attester set and upgrades. `registry` is the contract
    /// this one writes to. `min_interval` is the per-domain cooldown in ledgers
    /// (~5s each, so 720 ≈ an hour).
    pub fn __constructor(env: Env, admin: Address, registry: Address, min_interval: u32) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Registry, &registry);
        env.storage()
            .instance()
            .set(&DataKey::MinInterval, &min_interval);
        extend_instance(&env);
    }

    /// Submit an attestation for `domain`. Requires `attester`'s authorisation
    /// AND membership in the authorised set — signing is necessary but not
    /// sufficient, so a leaked key that was never enrolled achieves nothing.
    pub fn attest(
        env: Env,
        attester: Address,
        domain: String,
        seps: u32,
        toml_hash: BytesN<32>,
        probes_run: u32,
        probes_passed: u32,
    ) -> Result<(), Error> {
        attester.require_auth();
        if !Self::is_attester(env.clone(), attester.clone()) {
            return Err(Error::NotAnAttester);
        }
        if domain.is_empty() || domain.len() > MAX_DOMAIN_LEN {
            return Err(Error::InvalidDomain);
        }

        let now = env.ledger().sequence();
        let min_interval: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MinInterval)
            .ok_or(Error::NotInitialised)?;
        let last_key = DataKey::LastAttest(domain.clone());
        if let Some(last) = env.storage().persistent().get::<_, u32>(&last_key) {
            if now.saturating_sub(last) < min_interval {
                return Err(Error::TooSoon);
            }
        }

        let registry: Address = env
            .storage()
            .instance()
            .get(&DataKey::Registry)
            .ok_or(Error::NotInitialised)?;

        // Cross-contract call. The registry checks that ITS configured attester
        // authorised this invocation; Soroban supplies that authorisation from
        // this contract's own address automatically.
        RegistryClient::new(&env, &registry).put_anchor(
            &domain,
            &seps,
            &toml_hash,
            &probes_run,
            &probes_passed,
            &attester,
        );

        env.storage().persistent().set(&last_key, &now);
        extend_entry(&env, &last_key);
        // Signing in keeps the signer's own enrolment alive too.
        extend_entry(&env, &DataKey::Attester(attester.clone()));
        extend_instance(&env);
        Attested { domain, attester }.publish(&env);
        Ok(())
    }

    pub fn is_attester(env: Env, who: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Attester(who))
            .unwrap_or(false)
    }

    pub fn add_attester(env: Env, who: Address) -> Result<(), Error> {
        Self::admin(env.clone())?.require_auth();
        let key = DataKey::Attester(who);
        env.storage().persistent().set(&key, &true);
        extend_entry(&env, &key);
        extend_instance(&env);
        Ok(())
    }

    pub fn remove_attester(env: Env, who: Address) -> Result<(), Error> {
        Self::admin(env.clone())?.require_auth();
        let key = DataKey::Attester(who);
        env.storage().persistent().set(&key, &false);
        extend_entry(&env, &key);
        extend_instance(&env);
        Ok(())
    }

    pub fn set_min_interval(env: Env, ledgers: u32) -> Result<(), Error> {
        Self::admin(env.clone())?.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::MinInterval, &ledgers);
        extend_instance(&env);
        Ok(())
    }

    pub fn min_interval(env: Env) -> Result<u32, Error> {
        env.storage()
            .instance()
            .get(&DataKey::MinInterval)
            .ok_or(Error::NotInitialised)
    }

    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialised)
    }

    pub fn registry(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Registry)
            .ok_or(Error::NotInitialised)
    }

    /// Replace this contract's code. Admin only. Present from the first
    /// deployment because it cannot be retrofitted afterwards.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
        Self::admin(env.clone())?.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }
}

mod test;
