# 0015. Soft delete for messages and append-only audit

Status: accepted

## Context

Agents delete and edit messages; customers delete accounts; operators and members change things that must be explainable later. Hard deletes lose evidence and break receipts, quotes (`ref_message_id`) and counters.

## Decision

Messages are soft deleted (`deleted_at`, content hidden in every DTO, quotes show "Message deleted"). Contact and workspace purges (GDPR) are explicit, partition-key scoped operations, not side effects of deleting a message. The audit log is append-only at the database level: triggers reject `UPDATE` and `DELETE`, so even a buggy script or a compromised application user cannot rewrite it; retention of audit rows is an operator decision made outside the application.

## Consequences

Storage grows with deleted rows until retention/archival runs; analytics must ignore deleted rows explicitly. The audit table needs its own archival process at very large scale (not implemented).
