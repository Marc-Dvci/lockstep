//! Lockstep 2: DAOs pledge to a shared plan; money moves only when the whole plan is funded.
//!
//! A pledge is a transfer proposal the DAO files on itself by a council vote: it names the token, the amount (the
//! pledge's cap), Lockstep as receiver and the plan in `msg`. Lockstep's role on the DAO may only approve transfer
//! proposals, and Lockstep approves the one registered as the DAO's pledge once the plan is fully covered. Lockstep
//! never files a proposal on a DAO and never attaches NEAR to one.
//!
//! Lifecycle of a plan:
//!   Open        pledges (no money moves) and escrowed top-ups are recorded
//!   Collecting  an allocation that covers every cost line exactly was accepted; Lockstep approves each
//!               pledging DAO's own transfer proposal, keeps the allocated share and returns the rest
//!   Settled     every share arrived; payout claims to the payees are assigned
//!   RolledBack  a share failed; every token that arrived is owed back to its source
//!   Expired     the plan was never activated; top-ups are owed back
//!
//! Claims are paid by `disburse` (anyone may call it); a failed transfer leaves the claim pending so it can be
//! retried, never paid twice.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json};
use near_sdk::store::Vector;
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

pub const MAX_LINES: usize = 8;
pub const MAX_PLEDGES: usize = 8;
pub const MAX_TOPUPS: usize = 16;
pub const MAX_ASSIGNMENTS: usize = 64;
pub const PLAN_DEPOSIT: NearToken = NearToken::from_millinear(100); // storage for a full-size plan
pub const MIN_OPEN_SEC: u64 = 60;
pub const MAX_OPEN_SEC: u64 = 90 * 24 * 3600;

const GAS_VIEW: Gas = Gas::from_tgas(10);
const GAS_ON_PLEDGE_READ: Gas = Gas::from_tgas(20);
/// The DAO executes the approved transfer in a detached promise funded from the unused part of this gas, so it must
/// cover ft_transfer_call, ft_on_transfer and the DAO's callback.
const GAS_ACT_PROPOSAL: Gas = Gas::from_tgas(140);
const GAS_ON_VOTED: Gas = Gas::from_tgas(10);
const GAS_ON_PROPOSAL_READ: Gas = Gas::from_tgas(170);
const GAS_ON_STATUS: Gas = Gas::from_tgas(30);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_ON_CLAIM: Gas = Gas::from_tgas(8);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum PlanStatus {
    Open,
    Collecting,
    Settled,
    RolledBack,
    Expired,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct CostLine {
    pub key: String,
    pub label: String,
    pub payee: AccountId,
    pub amount: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Pledge {
    /// The DAO that filed the transfer proposal by a council vote.
    pub funder: AccountId,
    /// The amount the DAO's transfer proposal moves: the most this pledge can pay.
    pub cap: U128,
    pub lines: Vec<String>,
    /// The proposal's own expiry on the DAO: submission time plus the DAO's proposal period.
    pub expires_at: U64,
    pub pledged_at: U64,
    /// The DAO's transfer proposal that is this pledge.
    pub proposal_id: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct TopUp {
    pub id: u32,
    pub contributor: AccountId,
    pub amount: U128,
    pub lines: Vec<String>,
    pub at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum ShareState {
    /// Allocated, not yet requested.
    Waiting,
    /// Lockstep read the DAO's proposal and approved it (or is doing so).
    Requested,
    /// The tokens are in escrow.
    Arrived,
    /// The share could not be collected; the plan rolls back.
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Share {
    pub funder: AccountId,
    /// What the allocation takes from this DAO.
    pub amount: U128,
    /// What the DAO's transfer proposal moves (the pledge's cap); the difference goes straight back.
    pub pledged: U128,
    pub state: ShareState,
    pub proposal_id: Option<u64>,
    pub note: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Assignment {
    /// "pledge:<account>" or "topup:<id>"
    pub source: String,
    pub line: String,
    pub amount: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum ClaimKind {
    Payout,
    Refund,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum ClaimState {
    Pending,
    InFlight,
    Paid,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Claim {
    pub to: AccountId,
    pub amount: U128,
    pub kind: ClaimKind,
    pub state: ClaimState,
    pub attempts: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Plan {
    pub id: u64,
    pub title: String,
    pub coordinator: AccountId,
    pub token: AccountId,
    pub lines: Vec<CostLine>,
    pub created_at: U64,
    pub deadline: U64,
    pub status: PlanStatus,
    pub pledges: Vec<Pledge>,
    pub topups: Vec<TopUp>,
    pub allocation: Vec<Assignment>,
    pub shares: Vec<Share>,
    pub collect_deadline: Option<U64>,
    pub activated_by: Option<AccountId>,
    pub resolved_at: Option<U64>,
    pub claims: Vec<Claim>,
    /// Tokens this contract currently holds for the plan.
    pub escrow: U128,
}

#[near(serializers = [json])]
pub struct LineInput {
    pub key: String,
    pub label: String,
    pub payee: AccountId,
    pub amount: U128,
}

/// The `msg` of a transfer to Lockstep.
#[derive(Deserialize, Serialize)]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
pub enum TransferMsg {
    /// Anyone's top-up, escrowed for the named lines.
    Topup { plan_id: u64, lines: Vec<String> },
    /// A DAO's pledge: the `msg` of the transfer proposal the DAO filed on itself.
    Pledge { plan_id: u64, lines: Vec<String> },
}

#[near(serializers = [json])]
pub struct Config {
    pub tokens: Vec<AccountId>,
    pub dao_factories: Vec<AccountId>,
    pub collect_window_sec: u64,
    pub plans: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Lockstep {
    plans: Vector<Plan>,
    tokens: Vec<AccountId>,
    dao_factories: Vec<AccountId>,
    collect_window_ns: u64,
}

fn now() -> u64 {
    env::block_timestamp()
}

fn event(name: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "lockstep", "version": "2.0.0", "event": name, "data": [data]})
    ));
}

fn valid_key(k: &str) -> bool {
    !k.is_empty() && k.len() <= 24 && k.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn u128_of(v: &serde_json::Value) -> Option<u128> {
    v.as_str().and_then(|s| s.parse().ok())
}

fn u64_of(v: &serde_json::Value) -> Option<u64> {
    v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_u64())
}

/// A pledge read from a DAO's proposal, before it is checked against a plan.
pub struct ProposedPledge {
    pub cap: u128,
    pub plan_id: u64,
    pub lines: Vec<String>,
    pub submitted_at: u64,
}

/// Reads `proposal` as a pledge filed by `dao` itself, paying `me` in `token`, still waiting for its votes.
pub fn read_pledge(proposal: &serde_json::Value, dao: &AccountId, me: &AccountId, token: &AccountId) -> Result<ProposedPledge, String> {
    if proposal["proposer"].as_str() != Some(dao.as_str()) {
        return Err("the pledge must be a proposal the DAO filed on itself by a council vote".into());
    }
    if proposal["status"].as_str() != Some("InProgress") {
        return Err("the pledge proposal is no longer in progress".into());
    }
    let t = &proposal["kind"]["Transfer"];
    if !t.is_object() {
        return Err("the pledge proposal is not a transfer".into());
    }
    if t["token_id"].as_str() != Some(token.as_str()) {
        return Err("the pledge transfers another token".into());
    }
    if t["receiver_id"].as_str() != Some(me.as_str()) {
        return Err("the pledge does not pay Lockstep".into());
    }
    let cap = u128_of(&t["amount"]).filter(|a| *a > 0).ok_or("the pledge amount must be positive")?;
    let msg: TransferMsg =
        t["msg"].as_str().and_then(|m| serde_json::from_str(m).ok()).ok_or("the pledge has no Lockstep msg")?;
    let TransferMsg::Pledge { plan_id, lines } = msg else {
        return Err("the pledge msg is not a pledge".into());
    };
    let submitted_at = u64_of(&proposal["submission_time"]).ok_or("the proposal has no submission time")?;
    Ok(ProposedPledge { cap, plan_id, lines, submitted_at })
}

#[near]
impl Lockstep {
    #[init]
    pub fn new(tokens: Vec<AccountId>, dao_factories: Vec<AccountId>, collect_window_sec: u64) -> Self {
        require!(!tokens.is_empty(), "at least one token");
        require!((30..=86_400).contains(&collect_window_sec), "collect window 30 s .. 1 day");
        Self { plans: Vector::new(b"p"), tokens, dao_factories, collect_window_ns: collect_window_sec * 1_000_000_000 }
    }

    // ---------------------------------------------------------------- plans

    /// Anyone may propose a plan. The attached deposit pays for its storage.
    #[payable]
    pub fn create_plan(&mut self, title: String, token: AccountId, lines: Vec<LineInput>, open_for_sec: u64) -> u64 {
        require!(env::attached_deposit() >= PLAN_DEPOSIT, "attach 0.1 NEAR for plan storage");
        require!(!title.is_empty() && title.len() <= 120, "title 1..120 chars");
        require!(self.tokens.contains(&token), "token not accepted");
        require!(!lines.is_empty() && lines.len() <= MAX_LINES, "1..8 cost lines");
        require!((MIN_OPEN_SEC..=MAX_OPEN_SEC).contains(&open_for_sec), "open 60 s .. 90 days");
        let mut keys: Vec<&str> = Vec::new();
        for l in &lines {
            require!(valid_key(&l.key), "line key: 1..24 of a-z 0-9 -");
            require!(!keys.contains(&l.key.as_str()), "duplicate line key");
            require!(l.amount.0 > 0, "line amount must be positive");
            require!(l.label.len() <= 60, "label too long");
            keys.push(&l.key);
        }
        let id = self.plans.len() as u64;
        let plan = Plan {
            id,
            title,
            coordinator: env::predecessor_account_id(),
            token,
            lines: lines
                .into_iter()
                .map(|l| CostLine { key: l.key, label: l.label, payee: l.payee, amount: l.amount })
                .collect(),
            created_at: U64(now()),
            deadline: U64(now() + open_for_sec * 1_000_000_000),
            status: PlanStatus::Open,
            pledges: vec![],
            topups: vec![],
            allocation: vec![],
            shares: vec![],
            collect_deadline: None,
            activated_by: None,
            resolved_at: None,
            claims: vec![],
            escrow: U128(0),
        };
        event("plan_created", json!({"plan_id": id, "coordinator": plan.coordinator, "required": U128(plan.lines.iter().map(|l| l.amount.0).sum())}));
        self.plans.push(plan);
        id
    }

    /// Anyone may register a DAO's pledge: the transfer proposal `proposal_id` that the DAO filed on itself by a
    /// council vote, paying Lockstep in the plan's token with `{"pledge":{"plan_id","lines"}}` as `msg`. Lockstep
    /// reads the proposal and the DAO's proposal period, then records the pledge. A second registration from the same
    /// DAO replaces its pledge. No money moves.
    pub fn register_pledge(&mut self, plan_id: u64, dao: AccountId, proposal_id: u64) -> Promise {
        require!(self.is_dao(&dao), "pledges come from a DAO created by an accepted factory");
        self.open_plan_mut(plan_id);
        let me = env::current_account_id();
        Promise::new(dao.clone())
            .function_call("get_proposal".to_string(), serde_json::to_vec(&json!({"id": proposal_id})).unwrap(), NO_DEPOSIT, GAS_VIEW)
            .and(Promise::new(dao.clone()).function_call("get_policy".to_string(), b"{}".to_vec(), NO_DEPOSIT, GAS_VIEW))
            .then(Self::ext(me).with_static_gas(GAS_ON_PLEDGE_READ).on_pledge_read(plan_id, dao, proposal_id))
    }

    #[private]
    pub fn on_pledge_read(
        &mut self,
        plan_id: u64,
        dao: AccountId,
        proposal_id: u64,
        #[callback_result] proposal: Result<serde_json::Value, PromiseError>,
        #[callback_result] policy: Result<serde_json::Value, PromiseError>,
    ) {
        let me = env::current_account_id();
        let plan = self.open_plan_mut(plan_id);
        let proposal = proposal.unwrap_or_else(|_| env::panic_str("could not read the DAO's proposal"));
        let policy = policy.unwrap_or_else(|_| env::panic_str("could not read the DAO's policy"));
        let p = read_pledge(&proposal, &dao, &me, &plan.token).unwrap_or_else(|e| env::panic_str(&e));
        require!(p.plan_id == plan_id, "the pledge names another plan");
        Self::check_lines(plan, &p.lines);
        let period = u64_of(&policy["proposal_period"]).unwrap_or_else(|| env::panic_str("the DAO policy has no proposal period"));
        let expires_at = p.submitted_at.saturating_add(period);
        require!(expires_at > now(), "the pledge proposal has expired");
        let pledge = Pledge { funder: dao.clone(), cap: U128(p.cap), lines: p.lines, expires_at: U64(expires_at), pledged_at: U64(now()), proposal_id };
        if let Some(existing) = plan.pledges.iter_mut().find(|x| x.funder == dao) {
            *existing = pledge;
        } else {
            require!(plan.pledges.len() < MAX_PLEDGES, "too many pledges");
            plan.pledges.push(pledge);
        }
        event("pledged", json!({"plan_id": plan_id, "funder": dao, "cap": U128(p.cap), "proposal_id": proposal_id}));
    }

    /// A DAO may withdraw its pledge while the plan is open (a FunctionCall proposal of its own). Rejecting or
    /// removing its transfer proposal on the DAO has the same effect at collection.
    pub fn withdraw_pledge(&mut self, plan_id: u64) {
        let funder = env::predecessor_account_id();
        let plan = self.open_plan_mut(plan_id);
        let before = plan.pledges.len();
        plan.pledges.retain(|p| p.funder != funder);
        require!(plan.pledges.len() < before, "no pledge from caller");
        event("pledge_withdrawn", json!({"plan_id": plan_id, "funder": funder}));
    }

    /// Anyone may activate with an allocation that pays every cost line exactly from pledges and top-ups within
    /// their caps and permitted lines. Every pledge used must outlive the collection window.
    pub fn activate(&mut self, plan_id: u64, allocation: Vec<Assignment>) {
        let window = self.collect_window_ns;
        let plan = self.open_plan_mut(plan_id);
        require!(!allocation.is_empty() && allocation.len() <= MAX_ASSIGNMENTS, "1..64 assignments");
        let mut per_line: Vec<u128> = vec![0; plan.lines.len()];
        let mut per_pledge: Vec<u128> = vec![0; plan.pledges.len()];
        let mut per_topup: Vec<u128> = vec![0; plan.topups.len()];
        for a in &allocation {
            require!(a.amount.0 > 0, "assignment amounts must be positive");
            let li = plan.lines.iter().position(|l| l.key == a.line).unwrap_or_else(|| env::panic_str("unknown line"));
            per_line[li] += a.amount.0;
            if let Some(acc) = a.source.strip_prefix("pledge:") {
                let pi = plan.pledges.iter().position(|p| p.funder.as_str() == acc).unwrap_or_else(|| env::panic_str("unknown pledge"));
                let p = &plan.pledges[pi];
                require!(p.expires_at.0 > now() + window, "a pledge expires before the collection window closes");
                require!(p.lines.contains(&a.line), "pledge may not pay for that line");
                per_pledge[pi] += a.amount.0;
                require!(per_pledge[pi] <= p.cap.0, "pledge over its cap");
            } else if let Some(id) = a.source.strip_prefix("topup:") {
                let id: u32 = id.parse().unwrap_or_else(|_| env::panic_str("bad top-up id"));
                let ti = plan.topups.iter().position(|t| t.id == id).unwrap_or_else(|| env::panic_str("unknown top-up"));
                let t = &plan.topups[ti];
                require!(t.lines.contains(&a.line), "top-up may not pay for that line");
                per_topup[ti] += a.amount.0;
                require!(per_topup[ti] <= t.amount.0, "top-up over its amount");
            } else {
                env::panic_str("source must be pledge:<account> or topup:<id>");
            }
        }
        for (i, l) in plan.lines.iter().enumerate() {
            require!(per_line[i] == l.amount.0, format!("line {} must be covered exactly", l.key));
        }
        plan.shares = plan
            .pledges
            .iter()
            .zip(per_pledge.iter())
            .filter(|(_, amt)| **amt > 0)
            .map(|(p, amt)| Share {
                funder: p.funder.clone(),
                amount: U128(*amt),
                pledged: p.cap,
                state: ShareState::Waiting,
                proposal_id: Some(p.proposal_id),
                note: None,
            })
            .collect();
        plan.allocation = allocation;
        plan.status = PlanStatus::Collecting;
        plan.collect_deadline = Some(U64(now() + window));
        plan.activated_by = Some(env::predecessor_account_id());
        event("activated", json!({"plan_id": plan_id, "shares": plan.shares.len()}));
        if plan.shares.is_empty() {
            Self::resolve(plan);
        }
    }

    /// Anyone may collect one DAO's share: Lockstep reads the DAO's pledge proposal and, if it is still waiting for
    /// votes and unchanged, approves it with its role. The DAO then transfers the pledged amount with `ft_transfer_call`;
    /// `ft_on_transfer` keeps the share and returns the rest. Lockstep attaches no NEAR at any step.
    pub fn collect(&mut self, plan_id: u64, funder: AccountId) -> Promise {
        let me = env::current_account_id();
        let plan = self.plan_mut(plan_id);
        require!(plan.status == PlanStatus::Collecting, "plan is not collecting");
        require!(now() < plan.collect_deadline.unwrap().0, "collection window closed");
        let share = plan.shares.iter_mut().find(|s| s.funder == funder).unwrap_or_else(|| env::panic_str("no share for that DAO"));
        require!(share.state == ShareState::Waiting, "share already requested");
        share.state = ShareState::Requested;
        let id = share.proposal_id.unwrap();
        event("collect_requested", json!({"plan_id": plan_id, "funder": funder, "amount": share.amount, "proposal_id": id}));
        Promise::new(funder.clone())
            .function_call("get_proposal".to_string(), serde_json::to_vec(&json!({"id": id})).unwrap(), NO_DEPOSIT, GAS_VIEW)
            .then(Self::ext(me).with_static_gas(GAS_ON_PROPOSAL_READ).on_proposal_read(plan_id, funder))
    }

    #[private]
    pub fn on_proposal_read(&mut self, plan_id: u64, funder: AccountId, #[callback_result] proposal: Result<serde_json::Value, PromiseError>) -> PromiseOrValue<()> {
        let me = env::current_account_id();
        let plan = self.plan_mut(plan_id);
        if plan.status != PlanStatus::Collecting {
            return PromiseOrValue::Value(());
        }
        let token = plan.token.clone();
        let share = plan.shares.iter().find(|s| s.funder == funder).unwrap().clone();
        if share.state != ShareState::Requested {
            return PromiseOrValue::Value(());
        }
        let id = share.proposal_id.unwrap();
        let p = match proposal {
            Ok(p) => p,
            Err(_) => {
                Self::fail_share(plan, &funder, "the DAO's pledge proposal is gone");
                return PromiseOrValue::Value(());
            }
        };
        match p["status"].as_str() {
            Some("InProgress") => {}
            // The council approved its own pledge: the transfer is in flight or done; the arrival decides.
            Some("Approved") => return PromiseOrValue::Value(()),
            Some(status) => {
                let reason = format!("the DAO's pledge proposal ended {}", status);
                Self::fail_share(plan, &funder, &reason);
                return PromiseOrValue::Value(());
            }
            None => {
                Self::fail_share(plan, &funder, "the DAO's pledge proposal has no status");
                return PromiseOrValue::Value(());
            }
        }
        let same = read_pledge(&p, &funder, &me, &token).map(|x| x.plan_id == plan_id && x.cap == share.pledged.0).unwrap_or(false);
        if !same {
            Self::fail_share(plan, &funder, "the DAO's proposal no longer matches its pledge");
            return PromiseOrValue::Value(());
        }
        event("approving", json!({"plan_id": plan_id, "funder": funder, "proposal_id": id}));
        PromiseOrValue::Promise(
            Promise::new(funder.clone())
                .function_call(
                    "act_proposal".to_string(),
                    serde_json::to_vec(&json!({"id": id, "action": "VoteApprove", "proposal": p["kind"]})).unwrap(),
                    NO_DEPOSIT,
                    GAS_ACT_PROPOSAL,
                )
                .then(Self::ext(me).with_static_gas(GAS_ON_VOTED).on_voted(plan_id, funder)),
        )
    }

    /// If Lockstep's vote did not land (the DAO has no Lockstep role, for example), the share goes back to
    /// waiting: the council can approve its own proposal until the window closes, or anyone can collect again.
    #[private]
    pub fn on_voted(&mut self, plan_id: u64, funder: AccountId, #[callback_result] r: Result<(), PromiseError>) {
        if r.is_ok() {
            return;
        }
        let plan = self.plan_mut(plan_id);
        if plan.status != PlanStatus::Collecting {
            return;
        }
        if let Some(share) = plan.shares.iter_mut().find(|s| s.funder == funder && s.state == ShareState::Requested) {
            share.state = ShareState::Waiting;
            share.note = Some("Lockstep could not approve the proposal; the council can approve it itself".into());
            event("approval_refused", json!({"plan_id": plan_id, "funder": funder, "proposal_id": share.proposal_id}));
        }
    }

    /// Anyone may ask the DAO how the share's proposal ended. A proposal the DAO marks Failed (its transfer failed,
    /// e.g. the treasury no longer holds the money), Rejected, Removed or Expired, or one that is gone, fails the
    /// share and rolls the plan back. Approved or InProgress changes nothing: the transfer may still be in flight.
    pub fn check_share(&mut self, plan_id: u64, funder: AccountId) -> Promise {
        let me = env::current_account_id();
        let plan = self.plan_mut(plan_id);
        require!(plan.status == PlanStatus::Collecting, "plan is not collecting");
        let share = plan.shares.iter().find(|s| s.funder == funder).unwrap_or_else(|| env::panic_str("no share for that DAO"));
        require!(share.state == ShareState::Requested, "share is not awaiting its transfer");
        let id = share.proposal_id.unwrap();
        Promise::new(funder.clone())
            .function_call("get_proposal".to_string(), serde_json::to_vec(&json!({"id": id})).unwrap(), NO_DEPOSIT, GAS_VIEW)
            .then(Self::ext(me).with_static_gas(GAS_ON_STATUS).on_proposal_status(plan_id, funder))
    }

    #[private]
    pub fn on_proposal_status(&mut self, plan_id: u64, funder: AccountId, #[callback_result] p: Result<serde_json::Value, PromiseError>) -> String {
        let plan = self.plan_mut(plan_id);
        let status = match p {
            Ok(v) => v["status"].as_str().unwrap_or("Unknown").to_string(),
            Err(_) => "Gone".to_string(),
        };
        if matches!(status.as_str(), "Failed" | "Rejected" | "Removed" | "Expired" | "Gone") {
            let reason = if status == "Failed" {
                "the DAO's transfer failed: its treasury no longer holds the pledged amount".to_string()
            } else {
                format!("the DAO's pledge proposal ended {}", status)
            };
            Self::fail_share(plan, &funder, &reason);
        }
        status
    }

    /// Anyone may close a plan whose time is up: an open plan past its deadline expires; a collecting plan past its
    /// window rolls back missing shares.
    pub fn finalize(&mut self, plan_id: u64) {
        let plan = self.plan_mut(plan_id);
        match plan.status {
            PlanStatus::Open => {
                require!(now() >= plan.deadline.0, "plan still open");
                plan.status = PlanStatus::Expired;
                plan.resolved_at = Some(U64(now()));
                let refunds: Vec<Claim> = plan.topups.iter().map(|t| claim(&t.contributor, t.amount.0, ClaimKind::Refund)).collect();
                plan.claims = merge_claims(refunds);
                event("expired", json!({"plan_id": plan_id}));
            }
            PlanStatus::Collecting => {
                require!(now() >= plan.collect_deadline.unwrap().0, "collection window still open");
                for s in plan.shares.iter_mut().filter(|s| s.state != ShareState::Arrived) {
                    s.state = ShareState::Failed;
                    s.note = Some("not collected within the window".into());
                }
                Self::resolve(plan);
            }
            _ => env::panic_str("plan already closed"),
        }
    }

    /// Anyone may push pending claims (payouts or refunds) for a plan, up to 8 per call.
    /// Returns how many transfers were started.
    pub fn disburse(&mut self, plan_id: u64) -> u32 {
        let me = env::current_account_id();
        let plan = self.plan_mut(plan_id);
        require!(matches!(plan.status, PlanStatus::Settled | PlanStatus::RolledBack | PlanStatus::Expired), "plan not closed");
        let token = plan.token.clone();
        let memo = format!("Lockstep plan #{}", plan_id);
        let mut sent = 0u32;
        for (i, c) in plan.claims.iter_mut().enumerate() {
            if c.state != ClaimState::Pending || sent >= 8 {
                continue;
            }
            c.state = ClaimState::InFlight;
            c.attempts += 1;
            sent += 1;
            Promise::new(token.clone())
                .function_call(
                    "ft_transfer".to_string(),
                    serde_json::to_vec(&json!({"receiver_id": c.to, "amount": c.amount, "memo": memo})).unwrap(),
                    ONE_YOCTO,
                    GAS_FT_TRANSFER,
                )
                .then(Self::ext(me.clone()).with_static_gas(GAS_ON_CLAIM).on_claim_sent(plan_id, i as u32))
                .detach();
        }
        sent
    }

    #[private]
    pub fn on_claim_sent(&mut self, plan_id: u64, index: u32, #[callback_result] r: Result<(), PromiseError>) {
        let plan = self.plan_mut(plan_id);
        let c = &mut plan.claims[index as usize];
        require!(c.state == ClaimState::InFlight, "claim not in flight");
        if r.is_ok() {
            c.state = ClaimState::Paid;
            let amt = c.amount;
            let (to, kind) = (c.to.clone(), c.kind.clone());
            plan.escrow = U128(plan.escrow.0 - amt.0);
            event("claim_paid", json!({"plan_id": plan_id, "to": to, "amount": amt, "kind": kind}));
        } else {
            c.state = ClaimState::Pending;
            let to = c.to.clone();
            event("claim_failed", json!({"plan_id": plan_id, "to": to, "retry": "call disburse again"}));
        }
    }

    // ------------------------------------------------------------ token in

    /// NEP-141 receiver. Top-ups: msg {"topup":{"plan_id":N,"lines":["travel"]}}. A DAO's pledge arrives with the
    /// msg of its transfer proposal, {"pledge":{"plan_id":N,"lines":[...]}}: Lockstep keeps the share and returns
    /// the rest of the pledged amount as unused, so the token sends it straight back to the DAO.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        require!(self.tokens.contains(&token), "token not accepted");
        let parsed: TransferMsg = serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("bad msg"));
        let unused = match parsed {
            TransferMsg::Topup { plan_id, lines } => {
                let plan = self.open_plan_mut(plan_id);
                require!(plan.token == token, "wrong token for this plan");
                require!(amount.0 > 0, "empty top-up");
                require!(plan.topups.len() < MAX_TOPUPS, "too many top-ups");
                Self::check_lines(plan, &lines);
                let id = plan.topups.len() as u32;
                plan.topups.push(TopUp { id, contributor: sender_id.clone(), amount, lines, at: U64(now()) });
                plan.escrow = U128(plan.escrow.0 + amount.0);
                event("topped_up", json!({"plan_id": plan_id, "topup_id": id, "contributor": sender_id, "amount": amount}));
                0
            }
            TransferMsg::Pledge { plan_id, .. } => {
                let plan = self.plan_mut(plan_id);
                require!(plan.status == PlanStatus::Collecting, "plan is not collecting");
                require!(plan.token == token, "wrong token for this plan");
                let share = plan.shares.iter_mut().find(|s| s.funder == sender_id).unwrap_or_else(|| env::panic_str("sender has no share"));
                // The council may approve its own pledge proposal: Waiting is accepted.
                require!(matches!(share.state, ShareState::Waiting | ShareState::Requested), "share not expected");
                require!(share.pledged == amount, "amount differs from the pledge");
                share.state = ShareState::Arrived;
                let kept = share.amount.0;
                plan.escrow = U128(plan.escrow.0 + kept);
                event("share_arrived", json!({"plan_id": plan_id, "funder": sender_id, "amount": U128(kept), "returned": U128(amount.0 - kept)}));
                Self::maybe_resolve(plan);
                amount.0 - kept
            }
        };
        PromiseOrValue::Value(U128(unused))
    }

    // ----------------------------------------------------------------- views

    pub fn get_plan(&self, plan_id: u64) -> Option<Plan> {
        self.plans.get(plan_id as u32).cloned()
    }

    pub fn get_plans(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Plan> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(20).min(50);
        (from..(from + limit).min(self.plans.len() as u64)).filter_map(|i| self.plans.get(i as u32).cloned()).collect()
    }

    pub fn get_config(&self) -> Config {
        Config {
            tokens: self.tokens.clone(),
            dao_factories: self.dao_factories.clone(),
            collect_window_sec: self.collect_window_ns / 1_000_000_000,
            plans: self.plans.len() as u64,
        }
    }

    /// Tokens owed by this contract across all plans (escrow not yet paid out).
    pub fn total_escrow(&self, token: AccountId) -> U128 {
        U128(self.plans.iter().filter(|p| p.token == token).map(|p| p.escrow.0).sum())
    }

    // -------------------------------------------------------------- internal

    fn is_dao(&self, account: &AccountId) -> bool {
        self.dao_factories.iter().any(|f| account.as_str().len() > f.as_str().len() + 1 && account.as_str().ends_with(&format!(".{}", f)))
    }

    fn plan_mut(&mut self, plan_id: u64) -> &mut Plan {
        require!(plan_id < self.plans.len() as u64, "no such plan");
        self.plans.get_mut(plan_id as u32).unwrap()
    }

    fn open_plan_mut(&mut self, plan_id: u64) -> &mut Plan {
        let plan = self.plan_mut(plan_id);
        require!(plan.status == PlanStatus::Open, "plan is not open");
        require!(now() < plan.deadline.0, "plan deadline passed");
        plan
    }

    fn check_lines(plan: &Plan, lines: &[String]) {
        require!(!lines.is_empty() && lines.len() <= MAX_LINES, "name 1..8 lines");
        for k in lines {
            require!(plan.lines.iter().any(|l| &l.key == k), "unknown line");
        }
    }

    fn fail_share(plan: &mut Plan, funder: &AccountId, reason: &str) {
        if plan.status != PlanStatus::Collecting {
            return;
        }
        let id = plan.id;
        if let Some(share) = plan.shares.iter_mut().find(|s| &s.funder == funder && s.state == ShareState::Requested) {
            share.state = ShareState::Failed;
            share.note = Some(reason.to_string());
            event("share_failed", json!({"plan_id": id, "funder": funder, "reason": reason, "proposal_id": share.proposal_id}));
            Self::maybe_resolve(plan);
        }
    }

    fn maybe_resolve(plan: &mut Plan) {
        if plan.status != PlanStatus::Collecting {
            return;
        }
        // One failed share dooms the plan: do not pull shares that were not requested yet.
        if plan.shares.iter().any(|s| s.state == ShareState::Failed) {
            for s in plan.shares.iter_mut().filter(|s| s.state == ShareState::Waiting) {
                s.state = ShareState::Failed;
                s.note = Some("not collected: another share failed".into());
            }
        }
        if plan.shares.iter().all(|s| matches!(s.state, ShareState::Arrived | ShareState::Failed)) {
            Self::resolve(plan);
        }
    }

    /// All shares are Arrived or Failed: settle or roll back.
    fn resolve(plan: &mut Plan) {
        let all_arrived = plan.shares.iter().all(|s| s.state == ShareState::Arrived);
        let mut claims: Vec<Claim> = Vec::new();
        if all_arrived {
            for l in &plan.lines {
                claims.push(claim(&l.payee, l.amount.0, ClaimKind::Payout));
            }
            // Unused parts of top-ups go back to their contributors.
            for t in &plan.topups {
                let used: u128 = plan.allocation.iter().filter(|a| a.source == format!("topup:{}", t.id)).map(|a| a.amount.0).sum();
                if t.amount.0 > used {
                    claims.push(claim(&t.contributor, t.amount.0 - used, ClaimKind::Refund));
                }
            }
            plan.status = PlanStatus::Settled;
        } else {
            for s in plan.shares.iter().filter(|s| s.state == ShareState::Arrived) {
                claims.push(claim(&s.funder, s.amount.0, ClaimKind::Refund));
            }
            for t in &plan.topups {
                claims.push(claim(&t.contributor, t.amount.0, ClaimKind::Refund));
            }
            plan.status = PlanStatus::RolledBack;
        }
        plan.claims = merge_claims(claims);
        let owed: u128 = plan.claims.iter().map(|c| c.amount.0).sum();
        require!(owed == plan.escrow.0, "escrow does not reconcile");
        plan.resolved_at = Some(U64(now()));
        event(if all_arrived { "settled" } else { "rolled_back" }, json!({"plan_id": plan.id, "claims": plan.claims.len(), "owed": U128(owed)}));
    }
}

fn claim(to: &AccountId, amount: u128, kind: ClaimKind) -> Claim {
    Claim { to: to.clone(), amount: U128(amount), kind, state: ClaimState::Pending, attempts: 0 }
}

fn merge_claims(claims: Vec<Claim>) -> Vec<Claim> {
    let mut out: Vec<Claim> = Vec::new();
    for c in claims {
        if c.amount.0 == 0 {
            continue;
        }
        if let Some(e) = out.iter_mut().find(|e| e.to == c.to && e.kind == c.kind) {
            e.amount = U128(e.amount.0 + c.amount.0);
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests;
