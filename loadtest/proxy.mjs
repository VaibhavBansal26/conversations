// Round-robin TCP proxy (pass-through, so WebSockets work): node proxy.mjs <listenPort> <targetPort> [<targetPort> ...]
import net from "node:net";

const [listen, ...targets] = process.argv.slice(2).map(Number);
if (!listen || !targets.length) {
  console.error("usage: node proxy.mjs <listenPort> <targetPort> [<targetPort> ...]");
  process.exit(1);
}
let i = 0;
net
  .createServer({ allowHalfOpen: false }, (client) => {
    const upstream = net.connect(targets[i++ % targets.length], "127.0.0.1");
    client.pipe(upstream).pipe(client);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", end);
    upstream.on("error", end);
    client.on("close", end);
    upstream.on("close", end);
  })
  .listen(listen, () => console.error(`proxy :${listen} -> ${targets.join(", ")}`));
