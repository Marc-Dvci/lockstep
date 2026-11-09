# Security

Lockstep's contract holds escrowed tokens between collection and payout, and the hosted demo signs NEAR testnet
transactions with throwaway demo accounts. Please report a vulnerability privately, through this repository's
**Security → Report a vulnerability** form, rather than in a public issue.

Useful details: the contract method or page route, the plan id on testnet if one is involved, and what an attacker
gains. Reports are answered within a few days.

The deployed contracts `lockstep-v2.testnet` and `lockstep.testnet` have no access keys, so a change ships as a new
deployment on a new account, as Lockstep 2 did, with the plans of the earlier one left readable on chain.
