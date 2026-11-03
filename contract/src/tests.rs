#![allow(unused_must_use)]
use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const TOKEN: &str = "tusd.testnet";
const EVENTS: &str = "events.sputnikv2.testnet";
const BUILDERS: &str = "builders.sputnikv2.testnet";
const COMMUNITY: &str = "community.sputnikv2.testnet";
const DONOR: &str = "donor.testnet";
const COORD: &str = "coordinator.testnet";
const SEC: u64 = 1_000_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn set(pred: &str, t_sec: u64, deposit: NearToken) {
    set_with(pred, t_sec, deposit, vec![]);
}

fn set_with(pred: &str, t_sec: u64, deposit: NearToken, results: Vec<PromiseResult>) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("lockstep.testnet"))
        .predecessor_account_id(acc(pred))
        .signer_account_id(acc(pred))
        .block_timestamp(1_000 * SEC + t_sec * SEC)
        .account_balance(NearToken::from_near(10))
        .attached_deposit(deposit);
    testing_env!(b.build(), near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
}

fn line(key: &str, payee: &str, amount: u128) -> LineInput {
    LineInput { key: key.into(), label: key.into(), payee: acc(payee), amount: U128(amount) }
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

fn a(source: &str, line: &str, amount: u128) -> Assignment {
    Assignment { source: source.into(), line: line.into(), amount: U128(amount) }
}

/// The worked example: 1,150 pledged against a 1,000 plan, 50 short on travel.
fn worked_example() -> (Lockstep, u64) {
    set("deployer.testnet", 0, NearToken::from_near(0));
    let mut c = Lockstep::new(vec![acc(TOKEN)], vec![acc("sputnikv2.testnet")], 600);
    set(COORD, 0, PLAN_DEPOSIT);
    let id = c.create_plan(
        "Builders' night".into(),
        acc(TOKEN),
        vec![line("venue", "venue.testnet", 400), line("food", "caterer.testnet", 300), line("travel", "speaker.testnet", 300)],
        3600,
    );
    set(EVENTS, 1, NearToken::from_near(0));
    c.pledge(id, U128(500), s(&["venue"]), None);
    set(BUILDERS, 1, NearToken::from_near(0));
    c.pledge(id, U128(250), s(&["travel"]), None);
    set(COMMUNITY, 1, NearToken::from_near(0));
    c.pledge(id, U128(400), s(&["food", "venue"]), None);
    (c, id)
}

fn full_allocation() -> Vec<Assignment> {
    vec![
        a(&format!("pledge:{EVENTS}"), "venue", 400),
        a(&format!("pledge:{COMMUNITY}"), "food", 300),
        a(&format!("pledge:{BUILDERS}"), "travel", 250),
        a("topup:0", "travel", 50),
    ]
}

fn topup(c: &mut Lockstep, id: u64, amount: u128, lines: &[&str]) {
    set(TOKEN, 2, NearToken::from_near(0));
    let msg = serde_json::to_string(&TransferMsg::Topup { plan_id: id, lines: s(lines) }).unwrap();
    c.ft_on_transfer(acc(DONOR), U128(amount), msg);
}

fn arrive(c: &mut Lockstep, id: u64, dao: &str, amount: u128) {
    set(TOKEN, 3, NearToken::from_near(0));
    let msg = serde_json::to_string(&TransferMsg::Share { plan_id: id }).unwrap();
    c.ft_on_transfer(acc(dao), U128(amount), msg);
}

#[test]
#[should_panic(expected = "line travel must be covered exactly")]
fn gap_blocks_activation() {
    let (mut c, id) = worked_example();
    set(COORD, 2, NearToken::from_near(0));
    c.activate(
        id,
        vec![
            a(&format!("pledge:{EVENTS}"), "venue", 400),
            a(&format!("pledge:{COMMUNITY}"), "food", 300),
            a(&format!("pledge:{BUILDERS}"), "travel", 250),
        ],
    );
}

#[test]
#[should_panic(expected = "pledge may not pay for that line")]
fn restriction_enforced() {
    let (mut c, id) = worked_example();
    set(COORD, 2, NearToken::from_near(0));
    c.activate(
        id,
        vec![
            a(&format!("pledge:{EVENTS}"), "venue", 400),
            a(&format!("pledge:{COMMUNITY}"), "food", 300),
            a(&format!("pledge:{BUILDERS}"), "travel", 250),
            a(&format!("pledge:{EVENTS}"), "travel", 50), // Events DAO funds venue only
        ],
    );
}

#[test]
#[should_panic(expected = "pledge over its cap")]
fn cap_enforced() {
    let (mut c, id) = worked_example();
    set(COORD, 2, NearToken::from_near(0));
    c.activate(id, vec![a(&format!("pledge:{BUILDERS}"), "travel", 300)]);
}

#[test]
#[should_panic(expected = "pledges come from a DAO")]
fn only_dao_accounts_pledge() {
    let (mut c, id) = worked_example();
    set(DONOR, 1, NearToken::from_near(0));
    c.pledge(id, U128(10), s(&["food"]), None);
}

#[test]
#[should_panic(expected = "token not accepted")]
fn foreign_token_refused() {
    let (mut c, id) = worked_example();
    set("fake-token.testnet", 2, NearToken::from_near(0));
    let msg = serde_json::to_string(&TransferMsg::Topup { plan_id: id, lines: s(&["travel"]) }).unwrap();
    c.ft_on_transfer(acc(DONOR), U128(50), msg);
}

#[test]
fn happy_path_settles_and_reconciles() {
    let (mut c, id) = worked_example();
    topup(&mut c, id, 60, &["travel"]); // 10 more than needed: refunded at settlement
    set(COORD, 2, NearToken::from_near(0));
    c.activate(id, full_allocation());
    let p = c.get_plan(id).unwrap();
    assert_eq!(p.status, PlanStatus::Collecting);
    assert_eq!(p.shares.len(), 3);

    set(COORD, 3, NearToken::from_near(0));
    c.collect(id, acc(EVENTS));
    arrive(&mut c, id, EVENTS, 400);
    arrive(&mut c, id, COMMUNITY, 300); // a council may also send its share by vote
    assert_eq!(c.get_plan(id).unwrap().status, PlanStatus::Collecting);
    arrive(&mut c, id, BUILDERS, 250);

    let p = c.get_plan(id).unwrap();
    assert_eq!(p.status, PlanStatus::Settled);
    assert_eq!(p.escrow.0, 1010); // 950 in shares + 60 top-up
    let owed: u128 = p.claims.iter().map(|c| c.amount.0).sum();
    assert_eq!(owed, 1010);
    let refund = p.claims.iter().find(|c| c.kind == ClaimKind::Refund).unwrap();
    assert_eq!((refund.to.as_str(), refund.amount.0), (DONOR, 10));
    assert_eq!(p.claims.iter().filter(|c| c.kind == ClaimKind::Payout).count(), 3);
}

#[test]
fn one_failed_share_rolls_everything_back() {
    let (mut c, id) = worked_example();
    topup(&mut c, id, 50, &["travel"]);
    set(COORD, 2, NearToken::from_near(0));
    c.activate(id, full_allocation());
    arrive(&mut c, id, EVENTS, 400);
    arrive(&mut c, id, BUILDERS, 250);
    // Community DAO's transfer proposal was filed and approved, then its transfer failed.
    set(COORD, 3, NearToken::from_near(0));
    c.collect(id, acc(COMMUNITY));
    set_with("lockstep.testnet", 4, NearToken::from_near(0), vec![]);
    c.on_proposal_added(id, acc(COMMUNITY), Ok(7));
    set(COORD, 5, NearToken::from_near(0));
    c.check_share(id, acc(COMMUNITY));
    set_with("lockstep.testnet", 6, NearToken::from_near(0), vec![]);
    let status = c.on_proposal_status(id, acc(COMMUNITY), Ok(json!({"id": 7, "status": "Failed"})));
    assert_eq!(status, "Failed");

    let p = c.get_plan(id).unwrap();
    assert_eq!(p.status, PlanStatus::RolledBack);
    let mut refunds: Vec<(String, u128)> = p.claims.iter().map(|c| (c.to.to_string(), c.amount.0)).collect();
    refunds.sort();
    assert_eq!(refunds, vec![(BUILDERS.to_string(), 250), (DONOR.to_string(), 50), (EVENTS.to_string(), 400)]);
    assert!(p.claims.iter().all(|c| c.kind == ClaimKind::Refund));
}

#[test]
fn refused_proposal_fails_fast_without_pulling_other_shares() {
    let (mut c, id) = worked_example();
    topup(&mut c, id, 50, &["travel"]);
    set(COORD, 2, NearToken::from_near(0));
    c.activate(id, full_allocation());
    set(COORD, 3, NearToken::from_near(0));
    c.collect(id, acc(EVENTS));
    set_with("lockstep.testnet", 4, NearToken::from_near(0), vec![]);
    c.on_policy(id, acc(EVENTS), Ok(json!({"proposal_bond": "100", "roles": []}))); // role not installed
    let p = c.get_plan(id).unwrap();
    assert_eq!(p.status, PlanStatus::RolledBack);
    assert!(p.shares.iter().all(|s| s.state == ShareState::Failed));
    assert_eq!(p.claims.len(), 1); // only the donor's escrowed top-up comes back
    assert_eq!(p.claims[0].amount.0, 50);
}

#[test]
#[should_panic(expected = "share not expected")]
fn share_cannot_arrive_twice() {
    let (mut c, id) = worked_example();
    topup(&mut c, id, 50, &["travel"]);
    set(COORD, 2, NearToken::from_near(0));
    c.activate(id, full_allocation());
    arrive(&mut c, id, EVENTS, 400);
    arrive(&mut c, id, EVENTS, 400);
}

#[test]
#[should_panic(expected = "amount differs from the share")]
fn share_amount_must_match() {
    let (mut c, id) = worked_example();
    topup(&mut c, id, 50, &["travel"]);
    set(COORD, 2, NearToken::from_near(0));
    c.activate(id, full_allocation());
    arrive(&mut c, id, EVENTS, 399);
}

#[test]
#[should_panic(expected = "plan is not open")]
fn no_double_activation() {
    let (mut c, id) = worked_example();
    topup(&mut c, id, 50, &["travel"]);
    set(COORD, 2, NearToken::from_near(0));
    c.activate(id, full_allocation());
    c.activate(id, full_allocation());
}

#[test]
#[should_panic(expected = "share already requested")]
fn no_double_collect() {
    let (mut c, id) = worked_example();
    topup(&mut c, id, 50, &["travel"]);
    set(COORD, 2, NearToken::from_near(0));
    c.activate(id, full_allocation());
    c.collect(id, acc(EVENTS));
    c.collect(id, acc(EVENTS));
}

#[test]
fn window_closes_and_missing_shares_roll_back() {
    let (mut c, id) = worked_example();
    topup(&mut c, id, 50, &["travel"]);
    set(COORD, 2, NearToken::from_near(0));
    c.activate(id, full_allocation());
    arrive(&mut c, id, EVENTS, 400);
    set(COORD, 2 + 601, NearToken::from_near(0));
    c.finalize(id);
    let p = c.get_plan(id).unwrap();
    assert_eq!(p.status, PlanStatus::RolledBack);
    assert_eq!(p.claims.iter().map(|c| c.amount.0).sum::<u128>(), 450);
}

#[test]
fn unactivated_plan_expires_and_refunds_top_ups() {
    let (mut c, id) = worked_example();
    topup(&mut c, id, 50, &["travel"]);
    set(DONOR, 3601, NearToken::from_near(0));
    c.finalize(id);
    let p = c.get_plan(id).unwrap();
    assert_eq!(p.status, PlanStatus::Expired);
    assert_eq!(p.claims.len(), 1);
}

#[test]
#[should_panic(expected = "plan deadline passed")]
fn no_top_up_after_deadline() {
    let (mut c, id) = worked_example();
    set(TOKEN, 3601, NearToken::from_near(0));
    let msg = serde_json::to_string(&TransferMsg::Topup { plan_id: id, lines: s(&["travel"]) }).unwrap();
    c.ft_on_transfer(acc(DONOR), U128(50), msg);
}

#[test]
fn claims_pay_once_and_failed_transfers_stay_retryable() {
    let (mut c, id) = worked_example();
    topup(&mut c, id, 50, &["travel"]);
    set(COORD, 2, NearToken::from_near(0));
    c.activate(id, full_allocation());
    for (dao, amt) in [(EVENTS, 400), (COMMUNITY, 300), (BUILDERS, 250)] {
        arrive(&mut c, id, dao, amt);
    }
    set(COORD, 5, NearToken::from_near(0));
    assert_eq!(c.disburse(id), 3);
    assert_eq!(c.disburse(id), 0); // nothing pending while in flight

    set_with("lockstep.testnet", 6, NearToken::from_near(0), vec![PromiseResult::Successful(vec![])]);
    c.on_claim_sent(id, 0, Ok(()));
    set_with("lockstep.testnet", 6, NearToken::from_near(0), vec![PromiseResult::Failed]);
    c.on_claim_sent(id, 1, Err(PromiseError::Failed));
    let p = c.get_plan(id).unwrap();
    assert_eq!(p.claims[0].state, ClaimState::Paid);
    assert_eq!(p.claims[1].state, ClaimState::Pending);
    assert_eq!(p.escrow.0, 1000 - p.claims[0].amount.0);

    set(COORD, 7, NearToken::from_near(0));
    assert_eq!(c.disburse(id), 1); // only the failed one is retried
}

#[test]
#[should_panic(expected = "claim not in flight")]
fn duplicate_claim_callback_rejected() {
    let (mut c, id) = worked_example();
    topup(&mut c, id, 50, &["travel"]);
    set(COORD, 2, NearToken::from_near(0));
    c.activate(id, full_allocation());
    for (dao, amt) in [(EVENTS, 400), (COMMUNITY, 300), (BUILDERS, 250)] {
        arrive(&mut c, id, dao, amt);
    }
    set(COORD, 5, NearToken::from_near(0));
    c.disburse(id);
    set_with("lockstep.testnet", 6, NearToken::from_near(0), vec![PromiseResult::Successful(vec![])]);
    c.on_claim_sent(id, 0, Ok(()));
    c.on_claim_sent(id, 0, Ok(()));
}

#[test]
fn plan_paid_entirely_by_top_ups_settles_at_activation() {
    set("deployer.testnet", 0, NearToken::from_near(0));
    let mut c = Lockstep::new(vec![acc(TOKEN)], vec![acc("sputnikv2.testnet")], 600);
    set(COORD, 0, PLAN_DEPOSIT);
    let id = c.create_plan("Small".into(), acc(TOKEN), vec![line("food", "caterer.testnet", 100)], 3600);
    topup(&mut c, id, 100, &["food"]);
    set(COORD, 2, NearToken::from_near(0));
    c.activate(id, vec![a("topup:0", "food", 100)]);
    assert_eq!(c.get_plan(id).unwrap().status, PlanStatus::Settled);
}

#[test]
fn pledge_can_be_replaced_and_withdrawn() {
    let (mut c, id) = worked_example();
    set(BUILDERS, 2, NearToken::from_near(0));
    c.pledge(id, U128(300), s(&["travel"]), None);
    assert_eq!(c.get_plan(id).unwrap().pledges.iter().find(|p| p.funder.as_str() == BUILDERS).unwrap().cap.0, 300);
    c.withdraw_pledge(id);
    assert_eq!(c.get_plan(id).unwrap().pledges.len(), 2);
}

#[test]
fn in_flight_transfer_is_not_mistaken_for_failure() {
    let (mut c, id) = worked_example();
    topup(&mut c, id, 50, &["travel"]);
    set(COORD, 2, NearToken::from_near(0));
    c.activate(id, full_allocation());
    set(COORD, 3, NearToken::from_near(0));
    c.collect(id, acc(EVENTS));
    set_with("lockstep.testnet", 4, NearToken::from_near(0), vec![]);
    let policy = json!({"proposal_bond": "100000000000000000000000", "roles": [
        {"name": "lockstep", "kind": {"Group": ["lockstep.testnet"]}, "permissions": ["transfer:AddProposal", "transfer:VoteApprove"]}]});
    c.on_policy(id, acc(EVENTS), Ok(policy));
    c.on_proposal_added(id, acc(EVENTS), Ok(3));
    c.on_voted(id, acc(EVENTS), Ok(()));
    // The DAO reports Approved while its transfer is still in flight: nothing changes.
    c.on_proposal_status(id, acc(EVENTS), Ok(json!({"status": "Approved"})));
    let p = c.get_plan(id).unwrap();
    assert_eq!(p.shares.iter().find(|s| s.funder.as_str() == EVENTS).unwrap().state, ShareState::Requested);
    assert_eq!(p.status, PlanStatus::Collecting);
    arrive(&mut c, id, EVENTS, 400);
    assert_eq!(c.get_plan(id).unwrap().shares[0].state, ShareState::Arrived);
}

#[test]
fn role_detection_accepts_wildcards_and_rejects_strangers() {
    let me = acc("lockstep.testnet");
    let ok = json!({"roles": [{"kind": {"Group": ["lockstep.testnet"]}, "permissions": ["*:*"]}]});
    let stranger = json!({"roles": [{"kind": {"Group": ["other.testnet"]}, "permissions": ["*:*"]}]});
    let half = json!({"roles": [{"kind": {"Group": ["lockstep.testnet"]}, "permissions": ["transfer:AddProposal"]}]});
    assert!(has_lockstep_role(&ok, &me));
    assert!(!has_lockstep_role(&stranger, &me));
    assert!(!has_lockstep_role(&half, &me));
}
