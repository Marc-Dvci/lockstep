[![ci](https://github.com/Marc-Dvci/lockstep/actions/workflows/ci.yml/badge.svg)](https://github.com/Marc-Dvci/lockstep/actions/workflows/ci.yml)
[![live demo and verify](https://github.com/Marc-Dvci/lockstep/actions/workflows/live.yml/badge.svg)](https://github.com/Marc-Dvci/lockstep/actions/workflows/live.yml)
[![CodeQL](https://github.com/Marc-Dvci/lockstep/actions/workflows/codeql.yml/badge.svg)](https://github.com/Marc-Dvci/lockstep/actions/workflows/codeql.yml)
![tests: 46 passing](https://img.shields.io/badge/tests-46%20passing-2ea44f)
![gap engine coverage: 100% of lines, 89% of branches](https://img.shields.io/badge/gap%20engine%20coverage-100%25%20lines%20%C2%B7%2089%25%20branches-2ea44f)
![contract coverage: 91% of lines](https://img.shields.io/badge/contract%20coverage-91%25%20of%20lines-2ea44f)
![verify on testnet: 95 passed, 0 failed](https://img.shields.io/badge/verify%20on%20testnet-95%20passed%2C%200%20failed-2ea44f)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)
[![live demo](https://img.shields.io/badge/demo-live%20on%20NEAR%20testnet-1f5eff)](https://lockstep-f45z2r7dda-ew.a.run.app)

[![Lockstep, the film (2:00): the demo page says 1,150 tUSD pledged for a 1,000 plan, and still 50 short, because only Builders DAO may pay for speaker travel; a play button](docs/film-thumbnail.png)](https://youtu.be/Fvwn0QpIKu0)

**Watch the film (2:00): https://youtu.be/Fvwn0QpIKu0**. It shows the first contract, `lockstep.testnet`; the live demo runs Lockstep 2 through the same two stories.

# Lockstep

**Community DAOs pledge to a shared plan. Money moves only when the whole plan is funded, and the page shows the exact amount and category that would complete it.**

I built Lockstep solo at NEAR HACKATHON. I am Marc Donovici, an auditor in the technology practice of a large European banking group, where my missions cover payment systems and governance. In that work the first questions about a payment are who approved it, within what limit, and what record proves it. Lockstep answers each one on chain: the council's vote approves, the pledge sets the limit, and `npm run verify` rechecks every plan from public data, without keys.

| Try it | Tracks | Built with | On chain on 9 November |
| --- | --- | --- | --- |
| [Live demo, no account](https://lockstep-f45z2r7dda-ew.a.run.app) · [the film, 2:00](https://youtu.be/Fvwn0QpIKu0) · `npm run verify` | Social Money (`social`), Real-World Money (`realworld`) | Rust `near-sdk` 5.30 · Sputnik DAO v2 · NEP-141 · `near-api-js` 7.4 | Lockstep 2: plan #0 settled, #1 rolled back. Lockstep 1: 9 plans. `verify` 95 passed, 0 failed |

[For judges](#for-judges) · [See it work](#see-it-work) · [The problem](#the-problem) · [How it works](#how-it-works) · [What NEAR does here](#what-near-does-here) · [What a council grants](#what-a-council-grants) · [Evidence](#evidence) · [Lockstep 1, as filmed](#lockstep-1-as-filmed) · [Run it](#run-it)

## For judges

Code links point at the release `v2.0.0`.

| Criterion | What to inspect | Where |
| --- | --- | --- |
| Technical implementation | The pledge is a transfer proposal the DAO files on itself by a council vote. Lockstep reads it back, approves it when the plan is funded, keeps the share and returns the rest in the same transfer | [`read_pledge`](https://github.com/Marc-Dvci/lockstep/blob/v2.0.0/contract/src/lib.rs#L242-L267), [`register_pledge`](https://github.com/Marc-Dvci/lockstep/blob/v2.0.0/contract/src/lib.rs#L328-L365), [`activate`](https://github.com/Marc-Dvci/lockstep/blob/v2.0.0/contract/src/lib.rs#L380-L434), [`collect`](https://github.com/Marc-Dvci/lockstep/blob/v2.0.0/contract/src/lib.rs#L439-L504), [`check_share`](https://github.com/Marc-Dvci/lockstep/blob/v2.0.0/contract/src/lib.rs#L527-L555), [`ft_on_transfer`](https://github.com/Marc-Dvci/lockstep/blob/v2.0.0/contract/src/lib.rs#L634-L668); 34 contract tests, 5 sandbox end-to-end tests with real DAO votes |
| Design | One sentence says what completes the plan ("50 for speaker travel completes it; 50 for food would not"); councils see every step as an ordinary proposal in their treasury app | Gap engine [`solve`](https://github.com/Marc-Dvci/lockstep/blob/v2.0.0/core/gap.js#L113-L140) and [`completions`](https://github.com/Marc-Dvci/lockstep/blob/v2.0.0/core/gap.js#L185-L200); [See it work](#see-it-work); [Trezu screens](#seen-from-the-councils-treasury-app-trezu) |
| Impact | Shared funding that today is settled in chat: "we pay if they pay" becomes enforceable, and a failed share refunds everyone | [The problem](#the-problem); [the plans on chain](#evidence) |
| Originality | A max-flow with a min-cut certificate decides what the pledges can legally cover, and anyone can recheck it without running an optimizer. Each DAO's own vote fixes the token, the amount and the receiver of the only transfer Lockstep may approve | [`verifyCertificate`](https://github.com/Marc-Dvci/lockstep/blob/v2.0.0/core/gap.js#L146-L178); the contract accepts any feasible allocation and does not need the engine |
| Sustainability | The contract has no access keys and attaches no NEAR; `npm run verify` rechecks every plan and every proposal Lockstep touched on each DAO, every six hours during judging | [`scripts/verify.js`](https://github.com/Marc-Dvci/lockstep/blob/v2.0.0/scripts/verify.js); [live check](https://github.com/Marc-Dvci/lockstep/actions/workflows/live.yml) |

## See it work

Captured from the hosted demo on 9 November 2026, driven in a headless browser through both stories on NEAR testnet with Lockstep 2 (plans #0 and #1). Full pages are in [docs/screens](docs/screens).

| | |
| --- | --- |
| ![Plan #0: 1,150 tUSD pledged for a 1,000 plan, and still 50 short on speaker travel](docs/screens/top/01-gap.png) | ![After a 50 tUSD top-up for travel, the plan is fully covered on paper and ready to activate](docs/screens/top/03-covered.png) |
| **Pledged, and still short.** Only Builders DAO may pay for travel. | **50 for travel completes it.** A donor's top-up is held in escrow. |
| ![Plan #0 funded and paid: each DAO paid exactly its share through its own transfer proposal](docs/screens/top/05-paid.png) | ![Plan #1: Community DAO's council pays 250 elsewhere before activation](docs/screens/top/06-spent-elsewhere.png) |
| **Settled.** Each DAO paid its share through its own transfer proposal. | **Same plan again**, but one council spends its money elsewhere first. |
| ![Plan #1 rolled back: Community DAO's transfer failed, so nobody paid for part of the plan](docs/screens/top/07-rolled-back.png) | ![Plan #1 refunds paid to Events DAO, Builders DAO and the donor](docs/screens/top/08-refunded.png) |
| **Rolled back.** The DAO marked its own transfer `Failed`; Lockstep read it back. | **Refunded.** Every token that arrived went back where it came from. |

## The problem

Three community DAOs want to fund a builders' night together: venue 400, food 300, speaker travel 300. Each council can only fund certain things. Between them they pledge 1,150, more than the 1,000 the evening costs, and it still cannot happen. Only one DAO may pay for travel, and it pledged 250 of the 300. Today this gets sorted out in chat. Each council waits for the others, nobody can enforce "we pay if they pay", and nothing returns the money if the plan falls through.

With Lockstep:

- Each DAO votes **once** on a pledge, as an ordinary Sputnik proposal. The vote makes the DAO file its own transfer proposal to Lockstep for its cap. No money moves.
- The page says **"50 tUSD for speaker travel completes it. The same amount for venue or food would not."** That sentence is computed with max-flow and backed by a min-cut certificate that anyone can recheck.
- Anyone fills the gap with a top-up, which is held in escrow.
- On activation, Lockstep approves each DAO's own transfer proposal with a role that may only approve. It keeps the allocated share, and the rest of the pledge goes straight back to the DAO in the same transfer.
- If every share arrives, the payees are paid. **If any share fails, everything that arrived goes back to where it came from.** Nobody pays for part of a plan.

## How it works

<img src="docs/architecture.png" width="700" alt="Lockstep's flow: each DAO's council votes a pledge, which makes the DAO file its own transfer proposal to Lockstep; the page computes the gap; anyone tops up the exact gap; activate checks the allocation; collect approves each DAO's own proposal with a role that may only approve, keeps the share and returns the rest; if every share arrives the plan settles and pays, and if any share fails everything that arrived is refunded">

| Method | Who | What it checks or does |
| --- | --- | --- |
| `create_plan(title, token, lines, open_for_sec)` | anyone, 0.1 NEAR storage deposit | 1–8 cost lines, each with a payee; accepted token only. |
| `register_pledge(plan_id, dao, proposal_id)` | anyone | Reads the DAO's proposal and policy back from the DAO. The proposal must be filed by the DAO itself, in progress, a transfer of the plan's token to Lockstep with `{"pledge":{"plan_id","lines"}}` as `msg`. Its amount is the cap; its expiry on the DAO is the pledge's expiry. A second registration replaces the DAO's pledge. |
| `ft_on_transfer` with `{"topup":{"plan_id","lines"}}` | the accepted token | Escrowed top-up; refunded if the plan does not settle, unused part refunded if it does. |
| `activate(plan_id, allocation)` | anyone | Every line covered exactly; every amount within its pledge or top-up and its permitted lines; every pledge used outlives the collection window. |
| `collect(plan_id, funder)` | anyone | Reads the DAO's pledge proposal and approves it with Lockstep's role. Attaches no NEAR. If the vote cannot land (a DAO without the role), the share waits for the council's own approval. |
| `ft_on_transfer` with `{"pledge":{"plan_id","lines"}}` | the accepted token, sender = a DAO with a share | The amount must equal the pledge. Lockstep keeps the share and returns the rest as unused, which the token sends straight back to the DAO. |
| `check_share(plan_id, funder)` | anyone | Reads the DAO's proposal; `Failed`, `Rejected`, `Removed` or `Expired` fails the share. `Approved` changes nothing, because the transfer may still be in flight. |
| `finalize(plan_id)` | anyone | Expires an open plan past its deadline, or rolls back missing shares after the 10-minute collection window. |
| `disburse(plan_id)` | anyone | Sends up to 8 pending claims per call. A failed transfer leaves its claim pending for retry; a claim is never paid twice. |

A plan moves from `Open` to `Collecting` on activation, then to `Settled` when every share arrived, or to `RolledBack` when one failed or the collection window closed. An open plan past its deadline becomes `Expired`. `disburse` then pays the payout or refund claims.

The gap engine ([core/gap.js](core/gap.js)) is the same file in Node and in the browser:

- `solve` computes the most the pledges can legally cover (a maximum flow on pledge → permitted line → plan), an allocation, and the minimum cut that proves no allocation does better.
- `completions` finds, for each line, the smallest top-up restricted to that line alone that completes the plan, or reports that none does.
- `verifyCertificate` checks an allocation and a cut without running any optimizer.

The contract accepts any allocation that is feasible and covers every line exactly, so it does not depend on the engine.

The demo page ([web/](web)) runs the demo accounts' actions through a small Node server. It queues one chain job at a time, reads through two RPC endpoints with failover, and retries rate-limited reads.

## What NEAR does here

| NEAR piece | What it does in Lockstep |
| --- | --- |
| **Sputnik DAO v2** (the code `sputnikv2.testnet` deploys today, v3.31) | Each DAO keeps custody and its own council. The pledge vote is a **`FunctionCall` proposal on the DAO itself**: it calls the DAO's own `add_proposal`, so the DAO files a `Transfer` proposal to Lockstep with its own proposal bond. A **`ChangePolicyAddOrUpdateRole` proposal** installs a one-member `lockstep-v2` role limited to `transfer:VoteApprove`. |
| **Transfer proposals with `msg`** | The DAO's pledge is `Transfer { token_id, receiver_id: lockstep-v2.testnet, amount: cap, msg: {"pledge":{"plan_id":N,"lines":[...]}} }`. When Lockstep approves it, Sputnik executes `ft_transfer_call`, and Lockstep's `ft_on_transfer` sees `sender_id` = the DAO. If the treasury no longer holds the money, Sputnik marks the proposal `Failed`, and Lockstep reads that back with `check_share`. |
| **NEP-141** | One accepted token per deployment (tUSD, a test token with no value). Top-ups arrive by `ft_transfer_call`; the unused part of a pledge goes back through the standard's own refund of unused amounts; payouts and refunds leave by `ft_transfer`. |
| **Named accounts** | Every pledge, share, proposal and claim names the DAO, payee or donor account. |
| **NEP-330** | The contract publishes its source link and version 2.0.0 (`contract_source_metadata`). |

Lockstep keeps the multisig in charge. Each treasury keeps its council, its voting rules and its money until the moment a fully funded plan settles.

### Seen from the council's treasury app (Trezu)

Everything Lockstep does on a DAO is an ordinary Sputnik proposal, so a council sees it in the treasury app it already uses. The hosted [Trezu](https://github.com/NEAR-DevHub/trezu) is mainnet-only. These screenshots come from Trezu's own testnet dev mode (`nt-fe`, `bun run testnet:mock`, commit `7b063dd`), run locally on 3 November 2026 against the demo DAOs, viewed as a guest, with the first contract. Lockstep 2's pledges are Transfer proposals of the same kind, filed by the DAO itself.

- **Events DAO, Executed tab:** each pledge vote and each share, a Payment Request to Lockstep.

  ![Trezu, Events DAO: pledges voted by the council, and share transfers](docs/screens/v1/trezu-events-executed.png)

- **Community DAO, Failed tab:** the shares that failed after its council spent the money elsewhere. Lockstep reads exactly this status back, then rolls the plan back.

  ![Trezu, Community DAO: failed share transfers](docs/screens/v1/trezu-community-failed.png)

## What a council grants

- **The council's own vote files each transfer.** The token, the amount and the receiver (Lockstep) are written in the DAO's proposal. Lockstep's role may approve transfer proposals and cannot file one, and Lockstep approves only the proposal registered as this DAO's pledge, once the whole plan is covered. `verify` reads every proposal on each DAO and confirms that each one Lockstep approved is a share of a plan that DAO pledged to.
- **Lockstep attaches no NEAR.** The DAO pays the pledge's proposal bond to itself when its vote files the pledge, so the bond never leaves the DAO. Collecting a share, settled or failed, never lowers Lockstep's NEAR balance (checked in the end-to-end tests).
- **The role is the council's choice.** A DAO without it approves its own pledge proposal during the collection window, and the share arrives like any other (end-to-end test).
- Tokens sit in Lockstep only between collection and payout, or as escrowed top-ups until the plan closes.
- The money stays in the DAO's treasury until settlement. A DAO can spend it elsewhere before activation; the plan then rolls back and nobody pays. The demo shows this on purpose.

## Evidence

> [!IMPORTANT]
> The contract, the DAOs, every vote and every transfer are real NEAR testnet transactions. tUSD is a test token with no value, and the councils, donor and payees are demo accounts.

### Live on NEAR testnet

| Account | Role |
| --- | --- |
| [`lockstep-v2.testnet`](https://testnet.nearblocks.io/address/lockstep-v2.testnet) | Lockstep 2. Deployed and initialised in [BdDDDf71…](https://testnet.nearblocks.io/txns/BdDDDf71sASaKdHXu4rN65eff5Ud4u5ZkpiHrUF6Kru9), code hash `3qxX1HHzqrtwiXxhTbfGmyRQPa5SmaJTjTGVrWEJzgoy`. **It has no access keys** (deleted in [DV9R7Esq…](https://testnet.nearblocks.io/txns/DV9R7EsqosRE6e5CUBb9s7egJZNahpBk7itzQ6nwsejZ)), so nobody can redeploy it or sign for it. |
| [`tusd.lockstep.testnet`](https://testnet.nearblocks.io/address/tusd.lockstep.testnet) | tUSD, a NEP-141 test token with no value (6 decimals). |
| [`lockstep-events.sputnikv2.testnet`](https://testnet.nearblocks.io/address/lockstep-events.sputnikv2.testnet), [`lockstep-builders…`](https://testnet.nearblocks.io/address/lockstep-builders.sputnikv2.testnet), [`lockstep-community…`](https://testnet.nearblocks.io/address/lockstep-community.sputnikv2.testnet) | Three demo DAOs created through the `sputnikv2.testnet` factory, each with a two-member council. Each installed the `lockstep-v2` role by council vote (proposals #18, #18 and #21). |

The two stories on Lockstep 2, through the hosted demo on 9 November:

| Plan | What happened | Transactions |
| --- | --- | --- |
| #0, settled | Each council voted its pledge (500 venue, 250 travel, 400 food or venue), and each vote filed the DAO's own transfer proposal to Lockstep; the coordinator registered the three. A 50 travel top-up. Activation, then Lockstep approved the three DAO proposals. Events DAO sent 500 and got 100 back in the same transfer; Builders sent 250; Community sent 400 and got 100 back. Payees paid 400, 300, 300. | Events [vote](https://testnet.nearblocks.io/txns/8Dy8NrJkcFu3Lw4TEHxPS8jxnYYH4CcMQJSkDs2Ay295) and [registration](https://testnet.nearblocks.io/txns/DE19AUtYuYGCQEX9VZSiFaLRMb41FGYb9mgZGBCPUbCh) · [top-up](https://testnet.nearblocks.io/txns/FcKrCi3GAJoXMbRgXy1HBBEBoc3sGq2CQqGSnk5Dfger) · [activate](https://testnet.nearblocks.io/txns/7y6hSZYSmGovnfFLHn6y4Yqkg2mqpXcEZ6AX8j1ZJiH) · collect [Events](https://testnet.nearblocks.io/txns/HXp7NjGiE2rJgdcAJ2opzrDJDWoZWxcktMLsc2NAh4W5), [Builders](https://testnet.nearblocks.io/txns/CHJttL7V7cym4UnMCpSqzn88iqMRfBDoWGSuJ5bvo5c9), [Community](https://testnet.nearblocks.io/txns/Ah8GFy6xZxu2NdHdDVrCzWX3ZcKfDVahM9Gr6JA3Z7fU) · [pay out](https://testnet.nearblocks.io/txns/3RGQxnCEZLyJQn5b2XgsLdxXFCZZ17Z6qVzuszhwsuEY) |
| #1, rolled back | Same pledges and top-up. Before activation, Community DAO's council [paid 250 elsewhere](https://testnet.nearblocks.io/txns/HksN3qoFf3Nt7gvoiYxoPMHEfYUfzuRM1bYuZDf7tX7D). Lockstep approved its pledge proposal #25; the DAO's own transfer of 400 failed, the DAO marked it `Failed`, and Lockstep read that back and rolled the plan back. Events DAO got 400 back, Builders DAO 250, the donor 50. | [activate](https://testnet.nearblocks.io/txns/DJ5oXsw9JBWgLhvTBNpjEQxwG18JkbKaK9BgUTDPTtGH) · collect [Events](https://testnet.nearblocks.io/txns/CYTNnu3BAEdxquQkwUMGw7dK8ppaACh3DRdg4YdNcwVg), [Builders](https://testnet.nearblocks.io/txns/2WgNPeQrSbW6TibJdtwuewiQjEFbktYpKhdUnM7X5rpJ), [Community (fails)](https://testnet.nearblocks.io/txns/7tmUhacUMMfUMeH1DxgHAwHABiagZgo6VTHFhmWR6DeS) · [check_share](https://testnet.nearblocks.io/txns/QRg8SeM5hkiXTEQca1sFriTEnzbpLRy6HNVuqgthcvj) · [refunds](https://testnet.nearblocks.io/txns/DiriRLSoLtgMc6WbGJwwX8JrwXnAQi246YNx8ZMrBLRi) |

### What `verify` checks

`scripts/verify.js` reads only public chain state, for Lockstep 2 ([deployments/testnet.json](deployments/testnet.json)) and then for the first contract ([deployments/testnet-v1.json](deployments/testnet-v1.json)):

- The contract has no access keys, publishes NEP-330 source metadata, and runs the recorded build; with a local build, the hashes are compared too.
- Each DAO's Lockstep 2 role is a one-member group whose only permission is `transfer:VoteApprove`.
- For each open plan, the gap is recomputed and its min-cut certificate checked, and every pledge is matched with the DAO's own proposal (filed by the DAO, to Lockstep, in the plan's token, for the cap, with the plan id in `msg`).
- For each activated plan:
  - the accepted allocation covers every line exactly, within each pledge's cap and permitted lines;
  - every share is matched with the DAO's own proposal and its status (`Approved` / `Failed`);
  - everything that arrived is owed out, as payouts plus unused top-ups, or as refunds;
  - escrow equals unpaid claims.
- From each DAO's side: of all its proposals, Lockstep filed none, and every one it approved is a share of a plan that DAO pledged to. The script also prints how much each DAO's open pledges let Lockstep approve right now.
- The contract's token balance covers what it owes across all plans.

### Claims and the tests behind them

46 tests: 7 for the gap engine, 34 for the contract, 5 end-to-end on a local sandbox with real Sputnik DAOs and real votes. The gap engine's tests cover 100% of its lines and 89% of its branches (`npm run coverage`; CI fails below 95% of lines or 85% of branches). The contract's tests cover 91.2% of the lines of `contract/src/lib.rs` (`cargo llvm-cov -p lockstep`; CI fails below 85%).

| Claim | Code | Test |
| --- | --- | --- |
| 1,150 pledged, 50 short on travel: 50 travel completes it, 49 leaves 1, 50 food changes nothing | [core/gap.js](core/gap.js) | [gap tests](core/gap.test.js#L16-L40), [e2e](tests/e2e.test.js#L124) |
| The engine agrees with exhaustive cut enumeration; tampered or stale certificates are rejected | [core/gap.js](core/gap.js) | [500 random plans](core/gap.test.js#L68), [tampering](core/gap.test.js#L50) |
| A pledge is the DAO's own transfer proposal: filed by the DAO, to Lockstep, in the plan's token, for this plan, in progress, not expired | [`read_pledge`](contract/src/lib.rs#L242-L267), [`register_pledge`](contract/src/lib.rs#L328-L365) | [`a_pledge_is_the_daos_own_transfer_proposal`](contract/src/tests.rs#L211), [`a_proposal_filed_by_one_council_member_is_not_a_pledge`](contract/src/tests.rs#L229) and five more; [e2e, a stranger's pledge-shaped proposal](tests/e2e.test.js#L252) |
| Collecting approves the DAO's proposal, files nothing and attaches no NEAR | [`collect`](contract/src/lib.rs#L439-L504) | [`collecting_reads_the_daos_proposal_and_approves_it_without_attaching_near`](contract/src/tests.rs#L302); e2e: Lockstep's NEAR balance holds through a settled and a rolled-back plan, and it filed no proposal on any DAO |
| Each DAO pays exactly its share; the rest of its pledge comes straight back | [`ft_on_transfer`](contract/src/lib.rs#L634-L668) | [`happy_path_keeps_each_share_returns_the_rest_and_reconciles`](contract/src/tests.rs#L323), [e2e](tests/e2e.test.js#L124) |
| Activation with a gap, over a cap, outside a pledge's lines, or with a pledge that expires during collection is refused | [`activate`](contract/src/lib.rs#L380-L434) | [`gap_blocks_activation`](contract/src/tests.rs#L151), [`restriction_enforced`](contract/src/tests.rs#L166), [`cap_enforced`](contract/src/tests.rs#L182), [`activation_needs_pledges_that_outlive_the_collection_window`](contract/src/tests.rs#L279) |
| One failed share rolls the plan back, and waiting shares are not pulled | [lib.rs](contract/src/lib.rs) | [`one_failed_share_rolls_everything_back`](contract/src/tests.rs#L349), [`a_rejected_pledge_fails_fast_without_pulling_other_shares`](contract/src/tests.rs#L372), [e2e](tests/e2e.test.js#L182) |
| A council without the role pays by approving its own pledge | [`on_voted`](contract/src/lib.rs#L509-L522) | [`a_dao_without_the_role_is_not_failed_and_can_pay_by_its_own_vote`](contract/src/tests.rs#L391), [e2e](tests/e2e.test.js#L228) |
| An in-flight transfer reported `Approved` is not mistaken for a failure; a changed proposal is not approved | [lib.rs](contract/src/lib.rs) | [`in_flight_transfer_is_not_mistaken_for_failure`](contract/src/tests.rs#L424), [`a_changed_proposal_is_not_approved`](contract/src/tests.rs#L414) |
| A share cannot arrive twice or with another amount; no double activation or collect | [lib.rs](contract/src/lib.rs) | [`share_cannot_arrive_twice`](contract/src/tests.rs#L440), [`arrival_must_be_the_pledged_amount`](contract/src/tests.rs#L448), [`no_double_activation`](contract/src/tests.rs#L462), [`no_double_collect`](contract/src/tests.rs#L469) |
| Spoofed tokens, non-DAO pledges and fake pledges sent through the real token are refused and refunded | [lib.rs](contract/src/lib.rs) | [`only_dao_accounts_pledge`](contract/src/tests.rs#L221), [`foreign_token_refused`](contract/src/tests.rs#L190), [e2e](tests/e2e.test.js#L252) |
| A failed payout stays retryable and pays once; a duplicate callback is rejected | [lib.rs](contract/src/lib.rs) | [`claims_pay_once_and_failed_transfers_stay_retryable`](contract/src/tests.rs#L509), [`duplicate_claim_callback_rejected`](contract/src/tests.rs#L533) |
| Expiry before activation refunds top-ups; a closing collection window rolls back | [lib.rs](contract/src/lib.rs) | [`unactivated_plan_expires_and_refunds_top_ups`](contract/src/tests.rs#L489), [`window_closes_and_missing_shares_roll_back`](contract/src/tests.rs#L478) |
| The hosted page runs both stories with no page error, at 1280 px and at 390 px | [web/](web) | [UI drive](tests/ui.drive.js), [its report](docs/screens/drive-report.json) |

### Measured

On NEAR testnet, through the hosted demo (9 November 2026, headless browser, [drive report](docs/screens/drive-report.json)):

| What | Measured |
| --- | --- |
| Preparing a demo plan: the plan, 3 pledge votes with 2 council votes each, 3 registrations | 64.1 s and 72.4 s |
| Top-up, from click to final | 6.7 s and 7.7 s |
| Activate | 4.6 s |
| Collecting three shares (settled plan) | 27.4 s |
| A council spending 250 elsewhere: proposal and two votes | 15.7 s |
| Collecting three shares, one of which fails, plus the status check (rolled-back plan) | 31.4 s |
| Paying out three claims | 6.9 s |

On the local sandbox (9 November 2026, [e2e report](docs/e2e-report.json)):

| What | Measured |
| --- | --- |
| Gas burnt by one `collect` transaction, all receipts included (proposal read, approval, DAO transfer, arrival, return of the unused part) | 22 Tgas, for each of the 3 DAOs |
| Collecting three shares, one after another, waiting for final blocks each time | 25.5 s |
| Contract size | 240,212 bytes (`cargo near build non-reproducible-wasm`) |

## Lockstep 1, as filmed

The film shows the first contract, [`lockstep.testnet`](https://testnet.nearblocks.io/address/lockstep.testnet) (source at tag [`v1.0.1`](https://github.com/Marc-Dvci/lockstep/tree/v1.0.1)). There, Lockstep filed and approved each share's transfer proposal itself, through a role with `transfer:AddProposal` and `transfer:VoteApprove`, and attached the DAO's proposal bond. Lockstep 2 hands the filing to the DAO's own vote, so its role only approves and it attaches no NEAR. `lockstep.testnet` stays live with no keys, and `npm run verify` rechecks its 9 plans and every proposal it filed (69 checks). Its screenshots are in [docs/screens/v1](docs/screens/v1).

The two stories, as first run on chain:

| Plan | What happened | Transactions |
| --- | --- | --- |
| #1, settled | Three pledges (500 venue, 250 travel, 400 food or venue) and a 50 travel top-up. Activation, then three transfer proposals filed and approved by Lockstep, one on each DAO. Payees paid 400, 300, 300. | [top-up](https://testnet.nearblocks.io/txns/AHsmP9DLDwG4TCNJLeykjvr1mW7sUAZeU9sZbWaiTCCk) · [activate](https://testnet.nearblocks.io/txns/GS4zJbLSLhpkHyKVtSyaX7TYh7yXjq8gMTNgbeskjKvj) · collect [Events](https://testnet.nearblocks.io/txns/CMBVcT3WWNPCEV971Wr8qUQp3hP7iv31AJrN62W1yi11), [Builders](https://testnet.nearblocks.io/txns/5EMVPabzyWdU73JeVGJDMfUr7dgPHMV25NxqhjDkNYSK), [Community](https://testnet.nearblocks.io/txns/AZZnrDJuhCAGZdagm5WLckBL8Xu5S9TRttkBeYFV9T5J) · [pay out](https://testnet.nearblocks.io/txns/Eu8dW7oSUma8sXoXsqyq7QGrEssCERLY8yeyFhjBhBFF) |
| #2, rolled back | Same pledges and top-up. Before activation, Community DAO's council [paid 250 elsewhere](https://testnet.nearblocks.io/txns/8aE33gQyj7rFVK26kr1Z4Ev7ATC7SDF1iA8sMJE7rio). Its share transfer failed inside the DAO ("The account doesn't have enough balance"), the DAO marked the proposal `Failed`, and Lockstep read that back and rolled the plan back. Events DAO got 400 back, Builders DAO 250, the donor 50. | [activate](https://testnet.nearblocks.io/txns/8BfiNWkDz3CzVkav1be2gPRYHirPjBcVZPmnjXWuW5de) · collect [Events](https://testnet.nearblocks.io/txns/Gexcnqmkf2iQdAvu6MBL9QQrRLPrBrTLM8UKiCzsv8jU), [Builders](https://testnet.nearblocks.io/txns/43Q3CjjHckRLhSfV2xL7TksoVVL9Ai8BLFyRe1bLiKLb), [Community (fails)](https://testnet.nearblocks.io/txns/D8r1FbogVTV3YnDNTwoxuK1nNtvzwBe4uA6F3NL5f9Y3) · [check_share](https://testnet.nearblocks.io/txns/HHbnpxJDi2nkjw8MBig1Y1mPGE1UnX748Kn7gckxDqNP) · [refunds](https://testnet.nearblocks.io/txns/636yAtixjnQ4MUCq6UUFCg2azVhU9uVVv5bzXUA8c7kS) |

Plans #3 to #8 repeat the same two stories through the demo page: #3, #5 and #7 settled; #4, #6 and #8 rolled back. Plan #0 is open with two pledges, and `verify` checks its certificate like any other open plan.

## Run it

### Without installing anything

Open the [live demo](https://lockstep-f45z2r7dda-ew.a.run.app) and click **Start a new plan**. About a minute later a plan with three DAO pledges appears, each voted by a two-member council. Then follow the page: top up 50 for travel, then **1 · Activate**, **2 · Collect shares** and **3 · Pay out**. **Community DAO spends 250 elsewhere** shows the rollback. The demo runs on Google Cloud Run; after a quiet spell, the first request takes a few seconds while it starts.

### Check every plan without keys (testnet)

```bash
git clone https://github.com/Marc-Dvci/lockstep && cd lockstep && npm ci
npm run verify
```

Expected last line: `N passed, 0 failed`. N grows with the number of plans: it was `95 passed, 0 failed` on 9 November (26 checks for Lockstep 2 with plans #0 and #1, 69 for the first contract), and every plan someone runs on the hosted demo adds checks. The first lines confirm that `lockstep-v2.testnet` has 0 access keys and runs the recorded build `3qxX1HHzqrtwiXxhTbfGmyRQPa5SmaJTjTGVrWEJzgoy`. If you build the contract (`npm run build`), the script also compares your build's hash with the deployed code hash.

### The page, read-only, without keys

```bash
NETWORK=testnet npm start          # or: docker compose up
```

Expected: `Lockstep demo on http://127.0.0.1:8787 (testnet, contract lockstep-v2.testnet, read-only)` (port 7860 with Docker). The page shows every live plan on testnet; its action buttons are off, and the server answers that this copy is read-only.

### The whole flow on a local sandbox

The demo runs against a local NEAR sandbox (nearcore 2.14.0, protocol 88, the same protocol as testnet) with the same Sputnik DAO code as testnet.

Requirements: Node 22+, Rust with `wasm32-unknown-unknown`, [cargo-near](https://github.com/near/cargo-near) 0.22, and a Linux or WSL2 shell for the sandbox binary (NEAR publishes it for Linux and macOS only).

| Do | See |
| --- | --- |
| `npm ci` | Dependencies installed (`near-api-js` 7.4.0). |
| `npm test` | `pass 7`: the gap engine, including 500 random plans checked against exhaustive cut enumeration. |
| `cargo test -p lockstep` | `34 passed`: contract logic, with the cross-contract callbacks simulated. On Windows, set `AWS_LC_SYS_PREBUILT_NASM=1` for the test-only dependency. |
| `npm run build` | `target/near/lockstep/lockstep.wasm` and `target/near/tusd/tusd.wasm`. |
| In Linux/WSL: `bash tests/sandbox.sh` | A fresh sandbox on `127.0.0.1:3030`; the root key is copied to `/tmp/lockstep-sandbox-root-key.json`. On glibc older than 2.39, point `GLIBC_DIR` at an extracted libc6 2.39 tree (see the script). |
| Copy that key to `tests/res/sandbox-root-key.json`, then `npm run test:e2e` | `pass 5`: real Sputnik DAOs, real votes, settle, roll back, a DAO without the role, spoofing attempts. |
| `PREFIX=d2 DAO_PREFIX=d2 npm run seed -- sandbox`, then `NETWORK=sandbox npm start` | `Lockstep demo on http://127.0.0.1:8787`. The prefix keeps the demo accounts apart from the ones the end-to-end tests created. |
| Open it and click **Start a new plan** | About a minute later, a coordinator's plan with three DAO pledges, each voted by a two-member council. The headline reads **"1,150 tUSD pledged for a 1,000 plan, and still 50 short."** |
| Choose *Food* and amount 50 in "What completes it" | **"This would not help: that line is already covered."** |
| Choose *Speaker travel*, then click **Top up as the demo donor** | The headline turns to **"Fully covered on paper. Ready to activate."** |
| Click **1 · Activate**, then **2 · Collect shares** | Lockstep approves the three DAOs' own transfer proposals; the headline reads **"Every share arrived. The plan is settled."** |
| Click **3 · Pay out** | **"Funded and paid."** Venue 400, caterer 300, speaker 300. Every line under "Checked in this browser" is ticked. |
| Click **Start a new plan**, top up 50 for travel, click **Community DAO spends 250 elsewhere**, then Activate and Collect | **"Rolled back. Nobody paid for part of a plan."** Community DAO's own proposal is marked `Failed` by the DAO itself; Events and Builders DAO are owed 400 and 250 back, the donor 50. |
| Click **3 · Pay out** | Every refund is shown as *Paid*. Each DAO treasury is back where it started. |
| `npm run verify -- sandbox` | Ends with `0 failed`: every plan on your sandbox checked against chain state. |

With the demo server running, `CHROME=<path to a Chromium or chrome-headless-shell> npm run test:ui` drives the same two stories in headless Chromium and fails on any page error. It checks the page at 1280 px and at 390 px (no horizontal scroll). `BASE=<url>` points it at another server, such as the hosted demo.

### Hosting

The hosted demo is this repository's [Dockerfile](Dockerfile) on Google Cloud Run, deployed by [deploy/cloudrun.sh](deploy/cloudrun.sh). It runs one instance at most, so chain jobs never race, and reads the demo accounts from Secret Manager. [scripts/attach.js](scripts/attach.js) deployed Lockstep 2 to its own account and attached it to the demo DAOs, each council voting the new role.

## Built with

- Contract: Rust, `near-sdk` 5.30.0. Test token: `near-contract-standards` 5.30.0.
- Scripts, demo server and page: Node, `near-api-js` 7.4.0, no framework. UI drive: `playwright-core`. Lint: ESLint.
- Sputnik DAO v2 code for tests: [near-daos/sputnik-dao-contract @ 7764926c](https://github.com/near-daos/sputnik-dao-contract/tree/7764926cfd3c47f62b5fcde231c251f3c3892887), fetched by `scripts/fetch-sputnik.js` and checked against SHA-256 `880bae9a…952da`. That is the code `sputnikv2.testnet` deploys by default (version [3,31]).

**Baseline disclosure:** every file in this repository was written during the event, starting 3 November 2026. No earlier code of the author's is used.

## Other entry

My other NEAR HACKATHON entry is LIFO (https://github.com/Marc-Dvci/lifo), in Memecoins With Mechanics; the two share no code.

## License

MIT, see [LICENSE](LICENSE).
