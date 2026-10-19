/**
 * Lua ports of algorithms.ts. Every script reads the clock with TIME (never from the caller), so clock skew between app nodes cannot
 * change a decision, and every key it writes gets a TTL. Keys belonging to one decision share a {hash tag} so Redis Cluster keeps them in
 * one slot. Scripts are registered with ioredis `defineCommand`, which sends EVALSHA and transparently falls back to EVAL on NOSCRIPT
 * (after `SCRIPT FLUSH` or a failover to a replica that never saw the script).
 */

const NOW = `local t = redis.call('TIME'); local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)`;

// ARGV tail for the penalty box: thr, windowMs, decayMs, steps...(seconds)
const PENALTY = `
local function pen_args(i)
  local thr = tonumber(ARGV[i]); if not thr or thr <= 0 then return nil end
  local steps = {}
  for j = i + 3, #ARGV do steps[#steps + 1] = tonumber(ARGV[j]) end
  return { thr = thr, win = tonumber(ARGV[i + 1]), decay = tonumber(ARGV[i + 2]), steps = steps }
end
local function pen_remaining(pk, now)
  local u = tonumber(redis.call('HGET', pk, 'until') or '0')
  if u > now then return u - now end
  return 0
end
local function pen_violation(pk, now, c)
  local h = redis.call('HMGET', pk, 'v', 'vs', 'lvl', 'last', 'until')
  local v = tonumber(h[1] or '0'); local vs = tonumber(h[2] or '0'); local lvl = tonumber(h[3] or '0'); local last = tonumber(h[4] or '0'); local untilMs = tonumber(h[5] or '0')
  local ref = math.max(last, untilMs)
  if lvl > 0 and ref > 0 then lvl = math.max(0, lvl - math.floor((now - ref) / c.decay)) end
  if now - vs > c.win then v = 0; vs = now end
  v = v + 1
  if v >= c.thr then
    lvl = math.min(#c.steps, lvl + 1)
    untilMs = now + c.steps[lvl] * 1000
    v = 0; vs = now
  end
  redis.call('HSET', pk, 'v', v, 'vs', string.format('%.0f', vs), 'lvl', lvl, 'last', string.format('%.0f', now), 'until', string.format('%.0f', untilMs))
  redis.call('PEXPIRE', pk, c.decay * (#c.steps + 1))
end
`;

/** KEYS: gcra key, penalty key. ARGV: emissionMs, burst, cost, [penalty args] -> {allowed, remaining, retryAfterMs, resetMs, blocked} */
export const GCRA = `${NOW}
${PENALTY}
local T = tonumber(ARGV[1]); local B = tonumber(ARGV[2]); local cost = tonumber(ARGV[3])
local pc = pen_args(4)
if pc then
  local rem = pen_remaining(KEYS[2], now)
  if rem > 0 then return { 0, 0, rem, rem, 1 } end
end
local tat = tonumber(redis.call('GET', KEYS[1]) or '0')
if tat < now then tat = now end
local newTat = tat + cost * T
local allowAt = newTat - B * T
if allowAt > now then
  if pc then pen_violation(KEYS[2], now, pc) end
  local remaining = math.max(0, math.floor((B * T - (tat - now)) / T + 1e-9))
  return { 0, remaining, math.ceil(allowAt - now), math.ceil(tat - now), 0 }
end
redis.call('SET', KEYS[1], string.format('%.0f', newTat), 'PX', math.ceil(newTat - now + T) + 1000)
local remaining = math.max(0, math.floor((B * T - (newTat - now)) / T + 1e-9))
return { 1, remaining, 0, math.ceil(newTat - now), 0 }
`;

/** KEYS: gcra key. ARGV: emissionMs, burst, cost, want -> {granted, remaining, retryAfterMs, resetMs} */
export const GCRA_LEASE = `${NOW}
local T = tonumber(ARGV[1]); local B = tonumber(ARGV[2]); local cost = tonumber(ARGV[3]); local want = tonumber(ARGV[4])
local tat = tonumber(redis.call('GET', KEYS[1]) or '0')
if tat < now then tat = now end
local available = math.max(0, math.floor((B * T - (tat - now)) / T + 1e-9))
local granted = math.min(want, available)
if granted < cost then
  local newTat = tat + cost * T
  local allowAt = newTat - B * T
  return { 0, available, math.ceil(allowAt - now), math.ceil(tat - now) }
end
local newTat = tat + granted * T
redis.call('SET', KEYS[1], string.format('%.0f', newTat), 'PX', math.ceil(newTat - now + T) + 1000)
return { granted, math.max(0, math.floor((B * T - (newTat - now)) / T + 1e-9)), 0, math.ceil(newTat - now) }
`;

/** KEYS: window hash, penalty key. ARGV: limit, windowMs, cost, [penalty args] */
export const WINDOW = `${NOW}
${PENALTY}
local limit = tonumber(ARGV[1]); local win = tonumber(ARGV[2]); local cost = tonumber(ARGV[3])
local pc = pen_args(4)
if pc then
  local rem = pen_remaining(KEYS[2], now)
  if rem > 0 then return { 0, 0, rem, rem, 1 } end
end
local idx = math.floor(now / win)
local h = redis.call('HMGET', KEYS[1], 'i', 'c', 'p')
local cur = 0; local prev = 0
local si = tonumber(h[1] or '-1')
if si == idx then cur = tonumber(h[2] or '0'); prev = tonumber(h[3] or '0')
elseif si == idx - 1 then prev = tonumber(h[2] or '0') end
local elapsed = (now - idx * win) / win
local weighted = prev * (1 - elapsed) + cur
local toEnd = (idx + 1) * win - now
if weighted + cost > limit + 1e-9 then
  if pc then pen_violation(KEYS[2], now, pc) end
  local retry = toEnd
  if prev > 0 then
    local room = limit - cur - cost
    if room >= 0 then
      local f = 1 - room / prev
      retry = math.min(toEnd, math.max(1, math.ceil(f * win - (now - idx * win))))
    end
  end
  return { 0, math.max(0, math.floor(limit - weighted + 1e-9)), math.max(1, math.ceil(retry)), math.ceil(toEnd), 0 }
end
cur = cur + cost
redis.call('HSET', KEYS[1], 'i', idx, 'c', cur, 'p', prev)
redis.call('PEXPIRE', KEYS[1], win * 2 + 1000)
local after = prev * (1 - elapsed) + cur
return { 1, math.max(0, math.floor(limit - after + 1e-9)), 0, math.ceil(toEnd), 0 }
`;

/** KEYS: lease zset. ARGV: id, max, ttlMs -> {ok, count} */
export const ACQUIRE = `${NOW}
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local id = ARGV[1]; local max = tonumber(ARGV[2]); local ttl = tonumber(ARGV[3])
if redis.call('ZSCORE', KEYS[1], id) then
  redis.call('ZADD', KEYS[1], now + ttl, id); redis.call('PEXPIRE', KEYS[1], ttl * 2)
  return { 1, redis.call('ZCARD', KEYS[1]) }
end
local n = redis.call('ZCARD', KEYS[1])
if n >= max then return { 0, n } end
redis.call('ZADD', KEYS[1], now + ttl, id); redis.call('PEXPIRE', KEYS[1], ttl * 2)
return { 1, n + 1 }
`;

/** KEYS: lease zset. ARGV: ttlMs, ids... : extend only leases that still exist */
export const RENEW = `${NOW}
local ttl = tonumber(ARGV[1])
for i = 2, #ARGV do redis.call('ZADD', KEYS[1], 'XX', now + ttl, ARGV[i]) end
redis.call('PEXPIRE', KEYS[1], ttl * 2)
return 1
`;

/** KEYS: zset. ARGV: entry, ttlMs, note -> adds to an admin list; score = expiry */
export const LIST_ADD = `${NOW}
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
if ARGV[3] and ARGV[3] ~= '' then redis.call('HSET', KEYS[2], ARGV[1], ARGV[3]) end
return 1
`;

/** KEYS: penalty key. ARGV: thr, windowMs, decayMs, steps... -> remaining block ms after recording one failure */
export const STRIKE = `${NOW}
${PENALTY}
local pc = pen_args(1)
pen_violation(KEYS[1], now, pc)
return pen_remaining(KEYS[1], now)
`;

/** KEYS: penalty key -> remaining block ms */
export const BLOCKED = `${NOW}
${PENALTY}
return pen_remaining(KEYS[1], now)
`;
