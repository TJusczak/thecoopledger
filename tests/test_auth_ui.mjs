// The sign-in page's one piece of pure logic: when to warn that a password would cross the network unencrypted.
//
// Run with: node tests/test_auth_ui.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import assert from "node:assert";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "static");
const src = readFileSync(join(root, "js", "auth-ui.js"), "utf8");

function warns({ page, server = "" }) {
  const u = new URL(page);
  const ctx = vm.createContext({ window: { location: { hostname: u.hostname, origin: u.origin } }, getServerUrl: () => server });
  vm.runInContext(src + "\n;this.result = passwordsTravelInTheClear();", ctx);
  return ctx.result;
}

let n = 0;
const check = (cond, msg) => { assert.ok(cond, msg); n++; };

// served over plain http from somewhere other than this machine -> the password goes out in the clear
check(warns({ page: "http://192.168.1.50:8000/" }), "LAN address over http");
check(warns({ page: "http://coop.example.com/" }), "a public hostname over http");
check(warns({ page: "http://my-nas:8000/" }), "a NAS hostname over http");

// fine: encrypted, or never leaves this machine
check(!warns({ page: "https://coop.example.com/" }), "https");
check(!warns({ page: "http://localhost:8000/" }), "localhost");
check(!warns({ page: "http://127.0.0.1:8000/" }), "loopback");
check(!warns({ page: "http://[::1]:8000/" }), "ipv6 loopback");

// the public website (https) signing in to a server elsewhere: judge the SERVER's address, not the page's
check(warns({ page: "https://thecoopledger.com/", server: "http://192.168.1.50:8000" }), "https site -> http LAN server");
check(!warns({ page: "https://thecoopledger.com/", server: "https://coop.example.com" }), "https site -> https server");
check(!warns({ page: "https://thecoopledger.com/", server: "http://localhost:8000" }), "https site -> a server on this machine");
check(!warns({ page: "https://thecoopledger.com/" }), "https site, no server configured");
check(warns({ page: "http://192.168.1.50:8000/", server: "https://coop.example.com" }) === false, "the page is http but the server it talks to is https");

console.log(`✓ auth ui: ${n} assertions passed`);
