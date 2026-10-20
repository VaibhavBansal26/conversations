# 0016. Analytics exports are pseudonymous: HMAC keys from a per-workspace pepper

Status: accepted

## Context

A separate Python service trains on conversation behaviour. It must be able to join people across this product and the funnels product for the same customer, but never receive raw email, phone, names or message text.

## Decision

Exports carry `contact_key = hex(HMAC-SHA256(pepper, lower(trim(email))))` (and phone, agent keys likewise). The pepper is a per-workspace secret that the workspace admin can read (permission `analytics_identity:manage`) and give to the other product, which derives the same keys. Rotating it changes every key and is audited. Free text is never exported.

## Alternatives

* Plain hashes (SHA-256 of the email): trivially reversible by dictionary attack across workspaces and linkable between customers.
* A global pepper: one leak links every workspace.

## Consequences

Keys are stable per workspace until rotated, so consumers must handle a rotation (version returned with the pepper). Exports cannot be used to reach a person without the workspace's cooperation.
