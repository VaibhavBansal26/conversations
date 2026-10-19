# Load and scale harness

Multi-process harness that starts a real stack (PostgreSQL + Redis + N app nodes, or a single SQLite node), opens thousands of Socket.IO
clients from several generator processes and checks **correctness as well as speed**: every `message:new` must arrive with
`seq = previous + 1` (a jump is a *gap*, a repeat is a *dup*), delivery latency is measured from the server-stamped `created_at`, and CPU and
RSS are sampled once a second for every node, Redis and every generator.

Results, methodology and analysis: [docs/PERFORMANCE.md](../docs/PERFORMANCE.md). Capacity model: [docs/SCALING.md](../docs/SCALING.md).

```bash
npm run build --prefix ../server && npm install        # once
node run.mjs ramp --nodes 4 --conns 10000 --workers 6 --connect-rate 700 --out results/ramp.json
node summary.mjs results/ramp.json                      # the numbers that matter, one screen
./suite.sh                                              # everything used for PERFORMANCE.md (~45 min)
```

Needs `redis-server` on `PATH` (the PostgreSQL is the embedded one from `server/node_modules`, so no Docker). Nothing here talks to a real
provider, and no credentials exist: the nodes run with a throwaway `JWT_SECRET` and `RATE_LIMIT_SCALE=100000` (so one source IP is not
throttled by the per-IP limits the product ships with).

## Scenarios

| Scenario | What it does | Pass criteria it reports |
| --- | --- | --- |
| `ramp` | creates N visitor sessions + rooms over REST, then connects them in ten steps | open sockets per step, connect latency p50/p99, errors, RSS and CPU per node, event-loop lag |
| `fanout` | N visitors + A agents on one node; visitors send at `--rate` msg/s for `--duration` s; every agent must see every message | delivery ratio, gaps, dups, delivery and ack latency |
| `multinode` | as `fanout` on `--nodes` nodes; agents on node 0 only, visitors on the others, so every delivery crosses Redis | same, plus per-node CPU/RSS |
| `storm` | steady traffic, then 50% of visitor sockets are killed at the TCP level at once; clients reconnect with the product's backoff and re-sync over REST | seconds to 99% reconnected, messages recovered by re-sync, messages still missing after an audit |
| `slow` | some agent sockets stop reading; the server must drop them without hurting others | slow-consumer disconnects, healthy-socket latency, bounded RSS |
| `soak` | steady traffic for `--duration` s with a time series every 30 s | RSS, delivery p99, loop lag, gaps and dups over time |
| `idempotency` | 10,000 sends of 1,000 distinct client ids (10 racing duplicates each), spread across nodes | stored messages must equal distinct ids; per-room `seq` contiguous |
| `rest` | autocannon / a closed-loop POSTer on the hot REST paths | req/s, p50/p99, non-2xx |
| `drain` | SIGTERM one node under load | exit time, `server:draining` delivered |

Options: `--nodes --db sqlite|postgres --redis true|false --conns --agents --workers --rate --duration --connect-rate --bytes --out`, plus
`--quiet-load N --quiet-wait S` (wait until the machine's load average is below N before starting; the load average is recorded either way).
`LOADTEST_NODE_LOGS=1` shows node logs, `LOADTEST_NODE_FLAGS="--cpu-prof --cpu-prof-dir=/tmp/prof"` profiles the nodes (`node prof-top.mjs file.cpuprofile`).

`proxy.mjs` is a ~40-line round-robin TCP proxy for pointing generators at one address instead of the node list (`node proxy.mjs 9000 3001 3002 3003`);
it is a TCP pass-through, so WebSockets work unchanged. The scenarios connect to node ports directly by default so the proxy is not a bottleneck.

## Getting past this laptop's limits (commands for you to run, not run by the harness)

Every loopback connection costs **two** file descriptors in the kernel's global table (client end and server end), so a single machine
tops out at about `kern.maxfiles / 2` connections. The values below are what the measurements in PERFORMANCE.md ran with; raise them to go further.
These need `sudo`; the harness never runs them.

macOS:

```bash
sysctl kern.maxfiles kern.maxfilesperproc kern.ipc.somaxconn net.inet.ip.portrange.first   # inspect
sudo sysctl -w kern.maxfiles=1048576 kern.maxfilesperproc=524288   # global fd table; this is what limits one-box tests to ~10k sockets
sudo sysctl -w kern.ipc.somaxconn=4096                              # accept backlog; at the default 128 a burst of a few hundred SYNs per node is reset
sudo sysctl -w net.inet.ip.portrange.first=10000                    # more ephemeral ports per (src ip, dst ip, dst port)
ulimit -n 200000                                                    # in the shell that runs run.mjs
```

Linux (run the generators on a separate machine if you can):

```bash
ulimit -n 1000000
sudo sysctl -w fs.file-max=2000000 net.core.somaxconn=4096 net.ipv4.tcp_max_syn_backlog=8192 \
  net.ipv4.ip_local_port_range="10000 65535" net.ipv4.tcp_tw_reuse=1
```

Ephemeral ports are per `(source IP, destination IP, destination port)`, and the harness spreads clients over the node ports, so 4 nodes already
give four times the port space. To get more with one box, add loopback aliases and point generators at them
(`sudo ifconfig lo0 alias 127.0.0.2 up`; Linux: `sudo ip addr add 127.0.0.2/8 dev lo`).
