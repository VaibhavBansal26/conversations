// Prints a new VAPID key pair for Web Push (docs/NOTIFICATIONS.md). Put the three lines in the server's environment; keep the private key secret.
//   npm run vapid --prefix server
import { generateVapidKeys } from "../src/push/webpush.js";
const k = generateVapidKeys();
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}\nVAPID_SUBJECT=mailto:you@example.com`);
