# 0013. Platform operators are separate from workspace members

Status: accepted

## Context

Running the product for many customers needs someone who can see across workspaces: suspend an abusive tenant, correct credits, look at an account to help. The legacy product used an agency hierarchy inside the same user model.

## Decision

Operators are a separate table with their own accounts, tokens (own issuer and audience, 30 minutes, in memory in the browser), routes (`/admin/api`) and rate limits. Two-factor is mandatory (an operator without it can only enrol). Roles are `superadmin` and `support`; only superadmins change anything. Operators are created by a CLI, never over HTTP. Support access is a 15-minute workspace token capped to read permissions that refuses every non-GET request and socket event, requires a recorded reason, and is written to the **workspace's** audit log so the customer can see it. The directory shows the shape of an account (plan, billing state, seats, usage, ledger), never message content, contact details or card data.

## Alternatives

* A "super" role inside workspaces: one bug in tenant authorisation would become a platform compromise, and members could not be told apart from operators in audit.
* Full impersonation with write access: convenient, but a mistake or abuse is indistinguishable from the customer acting.

## Consequences

Two token types and two authorisation tables to keep apart (tests assert that neither token opens the other's API). No SSO or IP allow-list for operators yet; the docs say to put the console behind network controls.
