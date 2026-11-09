#![allow(unused_must_use)]
use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const ME: &str = "lockstep.testnet";
const TOKEN: &str = "tusd.testnet";
const EVENTS: &str = "events.sputnikv2.testnet";
const BUILDERS: &str = "builders.sputnikv2.testnet";
const COMMUNITY: &str = "community.sputnikv2.testnet";
const DONOR: &str = "donor.testnet";
const COORD: &str = "coordinator.testnet";
const SEC: u64 = 1_000_000_000;
const T0: u64 = 30 * 24 * 3600 * SEC; // day 30, so a week before it is still a timestamp
const WEEK: u64 = 7 * 24 * 3600 * SEC;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn set(pred: &str, t_sec: u64, deposit: NearToken) {
    set_with(pred, t_sec, deposit, vec![]);
}

fn set_with(pred: &str, t_sec: u64, deposit: NearToken, results: Vec<PromiseResult>) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ME))
        .predecessor_account_id(acc(pred))
        .signer_account_id(acc(pred))
        .block_timestamp(T0 + t_sec * SEC)
        .account_balance(NearToken::from_near(10))
        .attached_deposit(deposit);
    testing_env!(b.build(), near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
}

fn zero() -> NearToken {
    NearToken::from_near(0)
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

fn pledge_msg(plan_id: u64, lines: &[&str]) -> String {
    serde_json::to_string(&TransferMsg::Pledge { plan_id, lines: s(lines) }).unwrap()
}

/// The JSON a Sputnik DAO returns from get_proposal for the transfer proposal it filed on itself as its pledge.
fn proposal(dao: &str, plan_id: u64, cap: u128, lines: &[&str], status: &str) -> serde_json::Value {
    json!({
        "id": 3, "proposer": dao, "description": "pledge", "status": status, "submission_time": T0.to_string(),
        "kind": {"Transfer": {"token_id": TOKEN, "receiver_id": ME, "amount": cap.to_string(), "msg": pledge_msg(plan_id, lines)}},
        "vote_counts": {}, "votes": {}
    })
}

fn policy() -> serde_json::Value {
    json!({"proposal_bond": "1000000000000000000000000", "proposal_period": WEEK.to_string(), "roles": []})
}

/// Register `p` as the pledge of `dao` on plan `id`: the public call, then the callback with the DAO's answers.
fn register_with(c: &mut Lockstep, id: u64, dao: &str, p: serde_json::Value) {
    set(COORD, 1, zero());
    c.register_pledge(id, acc(dao), 3);
    set_with(ME, 1, zero(), vec![]);
    c.on_pledge_read(id, acc(dao), 3, Ok(p), Ok(policy()));
}

fn register(c: &mut Lockstep, id: u64, dao: &str, cap: u128, lines: &[&str]) {
    register_with(c, id, dao, proposal(dao, id, cap, lines, "InProgress"));
}

fn new_contract() -> Lockstep {
    set("deployer.testnet", 0, zero());
    Lockstep::new(vec![acc(TOKEN)], vec![acc("sputnikv2.testnet")], 600)
}

/// The worked example: 1,150 pledged against a 1,000 plan, 50 short on travel.
fn worked_example() -> (Lockstep, u64) {
    let mut c = new_contract();
    set(COORD, 0, PLAN_DEPOSIT);
    let id = c.create_plan(
        "Builders' night".into(),
        acc(TOKEN),
        vec![line("venue", "venue.testnet", 400), line("food", "caterer.testnet", 300), line("travel", "speaker.testnet", 300)],
        3600,
    );
    register(&mut c, id, EVENTS, 500, &["venue"]);
    register(&mut c, id, BUILDERS, 250, &["travel"]);
    register(&mut c, id, COMMUNITY, 400, &["food", "venue"]);
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
    set(TOKEN, 2, zero());
    let msg = serde_json::to_string(&TransferMsg::Topup { plan_id: id, lines: s(lines) }).unwrap();
    c.ft_on_transfer(acc(DONOR), U128(amount), msg);
}

fn activated() -> (Lockstep, u64) {
    let (mut c, id) = worked_example();
    topup(&mut c, id, 50, &["travel"]);
    set(COORD, 2, zero());
    c.activate(id, full_allocation());
    (c, id)
}

/// The DAO's approved transfer of the whole pledge arrives; returns what Lockstep hands back as unused.
fn arrive(c: &mut Lockstep, id: u64, dao: &str, pledged: u128) -> u128 {
    set(TOKEN, 3, zero());
    match c.ft_on_transfer(acc(dao), U128(pledged), pledge_msg(id, &["venue"])) {
        PromiseOrValue::Value(v) => v.0,
        PromiseOrValue::Promise(_) => panic!("ft_on_transfer returns a value"),
    }
}

/// collect, then the DAO's answer to get_proposal, as two receipts.
fn collect_with(c: &mut Lockstep, id: u64, dao: &str, answer: Result<serde_json::Value, PromiseError>) {
    set(COORD, 3, zero());
    c.collect(id, acc(dao));
    set_with(ME, 4, zero(), vec![]);
    c.on_proposal_read(id, acc(dao), answer);
}

fn share<'a>(p: &'a Plan, dao: &str) -> &'a Share {
    p.shares.iter().find(|s| s.funder.as_str() == dao).unwrap()
}

// -------------------------------------------------------------- the plan

#[test]
#[should_panic(expected = "line travel must be covered exactly")]
fn gap_blocks_activation() {
    let (mut c, id) = worked_example();
    set(COORD, 2, zero());
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
    set(COORD, 2, zero());
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
    set(COORD, 2, zero());
    c.activate(id, vec![a(&format!("pledge:{BUILDERS}"), "travel", 300)]);
}

#[test]
#[should_panic(expected = "token not accepted")]
fn foreign_token_refused() {
    let (mut c, id) = worked_example();
    set("fake-token.testnet", 2, zero());
    let msg = serde_json::to_string(&TransferMsg::Topup { plan_id: id, lines: s(&["travel"]) }).unwrap();
    c.ft_on_transfer(acc(DONOR), U128(50), msg);
}

#[test]
fn plan_paid_entirely_by_top_ups_settles_at_activation() {
    let mut c = new_contract();
    set(COORD, 0, PLAN_DEPOSIT);
    let id = c.create_plan("Small".into(), acc(TOKEN), vec![line("food", "caterer.testnet", 100)], 3600);
    topup(&mut c, id, 100, &["food"]);
    set(COORD, 2, zero());
    c.activate(id, vec![a("topup:0", "food", 100)]);
    assert_eq!(c.get_plan(id).unwrap().status, PlanStatus::Settled);
}

// ------------------------------------------------------------ the pledge

#[test]
fn a_pledge_is_the_daos_own_transfer_proposal() {
    let (c, id) = worked_example();
    let p = c.get_plan(id).unwrap();
    let events = p.pledges.iter().find(|p| p.funder.as_str() == EVENTS).unwrap();
    assert_eq!((events.cap.0, events.lines.clone(), events.proposal_id), (500, s(&["venue"]), 3));
    assert_eq!(events.expires_at.0, T0 + WEEK); // the proposal's own expiry on the DAO
}

#[test]
#[should_panic(expected = "pledges come from a DAO")]
fn only_dao_accounts_pledge() {
    let (mut c, id) = worked_example();
    set(COORD, 1, zero());
    c.register_pledge(id, acc(DONOR), 3);
}

#[test]
#[should_panic(expected = "a proposal the DAO filed on itself")]
fn a_proposal_filed_by_one_council_member_is_not_a_pledge() {
    let (mut c, id) = worked_example();
    let mut p = proposal(BUILDERS, id, 300, &["travel"], "InProgress");
    p["proposer"] = json!("alice.testnet");
    register_with(&mut c, id, BUILDERS, p);
}

#[test]
#[should_panic(expected = "the pledge does not pay Lockstep")]
fn a_pledge_must_pay_lockstep() {
    let (mut c, id) = worked_example();
    let mut p = proposal(BUILDERS, id, 300, &["travel"], "InProgress");
    p["kind"]["Transfer"]["receiver_id"] = json!("someone-else.testnet");
    register_with(&mut c, id, BUILDERS, p);
}

#[test]
#[should_panic(expected = "the pledge transfers another token")]
fn a_pledge_must_be_in_the_plans_token() {
    let (mut c, id) = worked_example();
    let mut p = proposal(BUILDERS, id, 300, &["travel"], "InProgress");
    p["kind"]["Transfer"]["token_id"] = json!("other-token.testnet");
    register_with(&mut c, id, BUILDERS, p);
}

#[test]
#[should_panic(expected = "the pledge names another plan")]
fn a_pledge_for_another_plan_is_refused() {
    let (mut c, id) = worked_example();
    register_with(&mut c, id, BUILDERS, proposal(BUILDERS, id + 1, 300, &["travel"], "InProgress"));
}

#[test]
#[should_panic(expected = "no longer in progress")]
fn a_decided_proposal_is_not_a_pledge() {
    let (mut c, id) = worked_example();
    register_with(&mut c, id, BUILDERS, proposal(BUILDERS, id, 300, &["travel"], "Approved"));
}

#[test]
#[should_panic(expected = "the pledge proposal has expired")]
fn an_expired_proposal_is_not_a_pledge() {
    let (mut c, id) = worked_example();
    let mut p = proposal(BUILDERS, id, 300, &["travel"], "InProgress");
    p["submission_time"] = json!((T0 - WEEK - SEC).to_string());
    register_with(&mut c, id, BUILDERS, p);
}

#[test]
#[should_panic(expected = "a pledge expires before the collection window closes")]
fn activation_needs_pledges_that_outlive_the_collection_window() {
    let (mut c, id) = worked_example();
    topup(&mut c, id, 50, &["travel"]);
    let mut p = proposal(BUILDERS, id, 250, &["travel"], "InProgress");
    p["submission_time"] = json!((T0 - WEEK + 300 * SEC).to_string()); // expires 5 minutes from now
    register_with(&mut c, id, BUILDERS, p);
    set(COORD, 2, zero());
    c.activate(id, full_allocation());
}

#[test]
fn pledge_can_be_replaced_and_withdrawn() {
    let (mut c, id) = worked_example();
    register(&mut c, id, BUILDERS, 300, &["travel"]);
    assert_eq!(c.get_plan(id).unwrap().pledges.iter().find(|p| p.funder.as_str() == BUILDERS).unwrap().cap.0, 300);
    set(BUILDERS, 2, zero());
    c.withdraw_pledge(id);
    assert_eq!(c.get_plan(id).unwrap().pledges.len(), 2);
}

// ------------------------------------------------------------ collection

#[test]
fn collecting_reads_the_daos_proposal_and_approves_it_without_attaching_near() {
    let (mut c, id) = activated();
    collect_with(&mut c, id, EVENTS, Ok(proposal(EVENTS, id, 500, &["venue"], "InProgress")));
    let receipts = get_created_receipts();
    let calls: Vec<(String, String, u128)> = receipts
        .iter()
        .flat_map(|r| {
            r.actions.iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight { method_name, attached_deposit, .. } => {
                    Some((r.receiver_id.to_string(), String::from_utf8(method_name.clone()).unwrap(), attached_deposit.as_yoctonear()))
                }
                _ => None,
            })
        })
        .collect();
    assert!(calls.iter().any(|(to, m, _)| to == EVENTS && m == "act_proposal"));
    assert!(!calls.iter().any(|(_, m, _)| m == "add_proposal"), "Lockstep never files a proposal");
    assert!(calls.iter().all(|(_, _, d)| *d == 0), "Lockstep attaches no NEAR: {calls:?}");
}

#[test]
fn happy_path_keeps_each_share_returns_the_rest_and_reconciles() {
    let (mut c, id) = worked_example();
    topup(&mut c, id, 60, &["travel"]); // 10 more than needed: refunded at settlement
    set(COORD, 2, zero());
    c.activate(id, full_allocation());
    let p = c.get_plan(id).unwrap();
    assert_eq!(p.status, PlanStatus::Collecting);
    assert_eq!(p.shares.len(), 3);

    collect_with(&mut c, id, EVENTS, Ok(proposal(EVENTS, id, 500, &["venue"], "InProgress")));
    assert_eq!(arrive(&mut c, id, EVENTS, 500), 100); // Events pledged 500, the plan takes 400
    assert_eq!(arrive(&mut c, id, COMMUNITY, 400), 100); // the council approved its own pledge
    assert_eq!(c.get_plan(id).unwrap().status, PlanStatus::Collecting);
    assert_eq!(arrive(&mut c, id, BUILDERS, 250), 0);

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
    let (mut c, id) = activated();
    arrive(&mut c, id, EVENTS, 500);
    arrive(&mut c, id, BUILDERS, 250);
    // Lockstep approved Community DAO's pledge; the DAO's own transfer then failed.
    collect_with(&mut c, id, COMMUNITY, Ok(proposal(COMMUNITY, id, 400, &["food", "venue"], "InProgress")));
    set_with(ME, 5, zero(), vec![]);
    c.on_voted(id, acc(COMMUNITY), Ok(()));
    set(COORD, 6, zero());
    c.check_share(id, acc(COMMUNITY));
    set_with(ME, 7, zero(), vec![]);
    let status = c.on_proposal_status(id, acc(COMMUNITY), Ok(json!({"id": 3, "status": "Failed"})));
    assert_eq!(status, "Failed");

    let p = c.get_plan(id).unwrap();
    assert_eq!(p.status, PlanStatus::RolledBack);
    let mut refunds: Vec<(String, u128)> = p.claims.iter().map(|c| (c.to.to_string(), c.amount.0)).collect();
    refunds.sort();
    assert_eq!(refunds, vec![(BUILDERS.to_string(), 250), (DONOR.to_string(), 50), (EVENTS.to_string(), 400)]);
    assert!(p.claims.iter().all(|c| c.kind == ClaimKind::Refund));
}

#[test]
fn a_rejected_pledge_fails_fast_without_pulling_other_shares() {
    let (mut c, id) = activated();
    // The council voted its own pledge proposal down after activation.
    collect_with(&mut c, id, EVENTS, Ok(proposal(EVENTS, id, 500, &["venue"], "Rejected")));
    let p = c.get_plan(id).unwrap();
    assert_eq!(p.status, PlanStatus::RolledBack);
    assert!(p.shares.iter().all(|s| s.state == ShareState::Failed));
    assert_eq!(p.claims.len(), 1); // only the donor's escrowed top-up comes back
    assert_eq!(p.claims[0].amount.0, 50);
}

#[test]
fn a_removed_pledge_proposal_fails_the_share() {
    let (mut c, id) = activated();
    collect_with(&mut c, id, EVENTS, Err(PromiseError::Failed)); // get_proposal panics: the proposal is gone
    assert_eq!(c.get_plan(id).unwrap().status, PlanStatus::RolledBack);
}

#[test]
fn a_dao_without_the_role_is_not_failed_and_can_pay_by_its_own_vote() {
    let (mut c, id) = activated();
    collect_with(&mut c, id, EVENTS, Ok(proposal(EVENTS, id, 500, &["venue"], "InProgress")));
    set_with(ME, 5, zero(), vec![]);
    c.on_voted(id, acc(EVENTS), Err(PromiseError::Failed)); // ERR_PERMISSION_DENIED on the DAO
    let p = c.get_plan(id).unwrap();
    assert_eq!(p.status, PlanStatus::Collecting);
    assert_eq!(share(&p, EVENTS).state, ShareState::Waiting);
    // The council approves its own proposal; the transfer arrives like any other.
    assert_eq!(arrive(&mut c, id, EVENTS, 500), 100);
    assert_eq!(share(&c.get_plan(id).unwrap(), EVENTS).state, ShareState::Arrived);
}

#[test]
fn a_pledge_the_council_already_approved_is_left_to_arrive() {
    let (mut c, id) = activated();
    collect_with(&mut c, id, EVENTS, Ok(proposal(EVENTS, id, 500, &["venue"], "Approved")));
    let p = c.get_plan(id).unwrap();
    assert_eq!((p.status.clone(), share(&p, EVENTS).state.clone()), (PlanStatus::Collecting, ShareState::Requested));
    assert!(!get_created_receipts().iter().any(|r| r.actions.iter().any(|a| matches!(a, MockAction::FunctionCallWeight { method_name, .. } if method_name == b"act_proposal"))));
}

#[test]
fn a_changed_proposal_is_not_approved() {
    let (mut c, id) = activated();
    // A proposal with the same id that moves another amount is not the registered pledge.
    collect_with(&mut c, id, EVENTS, Ok(proposal(EVENTS, id, 499, &["venue"], "InProgress")));
    let p = c.get_plan(id).unwrap();
    assert_eq!(p.status, PlanStatus::RolledBack);
    assert_eq!(share(&p, EVENTS).note.as_deref(), Some("the DAO's proposal no longer matches its pledge"));
}

#[test]
fn in_flight_transfer_is_not_mistaken_for_failure() {
    let (mut c, id) = activated();
    collect_with(&mut c, id, EVENTS, Ok(proposal(EVENTS, id, 500, &["venue"], "InProgress")));
    set_with(ME, 5, zero(), vec![]);
    c.on_voted(id, acc(EVENTS), Ok(()));
    // The DAO reports Approved while its transfer is still in flight: nothing changes.
    c.on_proposal_status(id, acc(EVENTS), Ok(json!({"status": "Approved"})));
    let p = c.get_plan(id).unwrap();
    assert_eq!(share(&p, EVENTS).state, ShareState::Requested);
    assert_eq!(p.status, PlanStatus::Collecting);
    arrive(&mut c, id, EVENTS, 500);
    assert_eq!(share(&c.get_plan(id).unwrap(), EVENTS).state, ShareState::Arrived);
}

#[test]
#[should_panic(expected = "share not expected")]
fn share_cannot_arrive_twice() {
    let (mut c, id) = activated();
    arrive(&mut c, id, EVENTS, 500);
    arrive(&mut c, id, EVENTS, 500);
}

#[test]
#[should_panic(expected = "amount differs from the pledge")]
fn arrival_must_be_the_pledged_amount() {
    let (mut c, id) = activated();
    arrive(&mut c, id, EVENTS, 400); // the share, not the pledge: not the DAO's proposal
}

#[test]
#[should_panic(expected = "plan is not collecting")]
fn a_pledge_paid_before_activation_is_refused_and_goes_back() {
    let (mut c, id) = worked_example();
    arrive(&mut c, id, EVENTS, 500); // the token refunds the whole transfer to the DAO
}

#[test]
#[should_panic(expected = "plan is not open")]
fn no_double_activation() {
    let (mut c, id) = activated();
    c.activate(id, full_allocation());
}

#[test]
#[should_panic(expected = "share already requested")]
fn no_double_collect() {
    let (mut c, id) = activated();
    c.collect(id, acc(EVENTS));
    c.collect(id, acc(EVENTS));
}

// ------------------------------------------------------------- closing

#[test]
fn window_closes_and_missing_shares_roll_back() {
    let (mut c, id) = activated();
    arrive(&mut c, id, EVENTS, 500);
    set(COORD, 2 + 601, zero());
    c.finalize(id);
    let p = c.get_plan(id).unwrap();
    assert_eq!(p.status, PlanStatus::RolledBack);
    assert_eq!(p.claims.iter().map(|c| c.amount.0).sum::<u128>(), 450);
}

#[test]
fn unactivated_plan_expires_and_refunds_top_ups() {
    let (mut c, id) = worked_example();
    topup(&mut c, id, 50, &["travel"]);
    set(DONOR, 3601, zero());
    c.finalize(id);
    let p = c.get_plan(id).unwrap();
    assert_eq!(p.status, PlanStatus::Expired);
    assert_eq!(p.claims.len(), 1);
}

#[test]
#[should_panic(expected = "plan deadline passed")]
fn no_top_up_after_deadline() {
    let (mut c, id) = worked_example();
    set(TOKEN, 3601, zero());
    let msg = serde_json::to_string(&TransferMsg::Topup { plan_id: id, lines: s(&["travel"]) }).unwrap();
    c.ft_on_transfer(acc(DONOR), U128(50), msg);
}

#[test]
fn claims_pay_once_and_failed_transfers_stay_retryable() {
    let (mut c, id) = activated();
    for (dao, amt) in [(EVENTS, 500), (COMMUNITY, 400), (BUILDERS, 250)] {
        arrive(&mut c, id, dao, amt);
    }
    set(COORD, 5, zero());
    assert_eq!(c.disburse(id), 3);
    assert_eq!(c.disburse(id), 0); // nothing pending while in flight

    set_with(ME, 6, zero(), vec![PromiseResult::Successful(vec![])]);
    c.on_claim_sent(id, 0, Ok(()));
    set_with(ME, 6, zero(), vec![PromiseResult::Failed]);
    c.on_claim_sent(id, 1, Err(PromiseError::Failed));
    let p = c.get_plan(id).unwrap();
    assert_eq!(p.claims[0].state, ClaimState::Paid);
    assert_eq!(p.claims[1].state, ClaimState::Pending);
    assert_eq!(p.escrow.0, 1000 - p.claims[0].amount.0);

    set(COORD, 7, zero());
    assert_eq!(c.disburse(id), 1); // only the failed one is retried
}

#[test]
#[should_panic(expected = "claim not in flight")]
fn duplicate_claim_callback_rejected() {
    let (mut c, id) = activated();
    for (dao, amt) in [(EVENTS, 500), (COMMUNITY, 400), (BUILDERS, 250)] {
        arrive(&mut c, id, dao, amt);
    }
    set(COORD, 5, zero());
    c.disburse(id);
    set_with(ME, 6, zero(), vec![PromiseResult::Successful(vec![])]);
    c.on_claim_sent(id, 0, Ok(()));
    c.on_claim_sent(id, 0, Ok(()));
}
