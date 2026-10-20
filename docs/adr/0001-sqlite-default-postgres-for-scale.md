# 0001. SQLite by default, PostgreSQL + Redis to scale out

Status: accepted (backfilled 2026-10-20 from the decisions made while building; dates of the original decisions are in git history).

## Context

The product must run with no external services for development and small deployments, and also scale horizontally.

## Decision

One async repository interface (`Db`) with two implementations: `SqliteDb` (node:sqlite, WAL) and `PgDb` (pg pool). Services use a portable SQL subset (`?` placeholders, 0/1 integers, `ON CONFLICT`, `RETURNING`). Redis is optional and auto-detected from `REDIS_URL`. The whole test suite runs on SQLite, on PostgreSQL, and on PostgreSQL plus Redis.

## Consequences

Zero-dependency start; the same code scales out. Cost: SQL must stay in the portable subset, dialect differences hide behind `Db` helpers (`ilike`, `forUpdate`, `jsonArrayHas`), and a few features (partitioning, replicas) are PostgreSQL only.

## Alternatives

Rejected: PostgreSQL only (heavy for development), an ORM (hides the SQL we need to EXPLAIN-test).
