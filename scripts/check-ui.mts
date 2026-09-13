/**
 * Serve the production build and check what actually crosses the wire.
 *
 *   npm run check:ui
 *
 * The view-model test proves the *payload* carries no address; this proves the *response*
 * does, which is a different thing — a component could interpolate an id into a `title`, a
 * `data-` attribute or an SVG label without ever putting it in the view model, and the HTML
 * is where that would show up. It also confirms both routes render at all, which no unit test
 * in this repo does.
 *
 * Requires `npm run build` first, and a snapshot on disk.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const PORT = 3117;
const BASE = `http://127.0.0.1:${PORT}`;
/** Addresses the interface is allowed to name: infrastructure identities, not people. */
const ALLOWED = new Set<string>();

async function waitForServer(deadlineMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    try {
      const response = await fetch(BASE, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`server did not answer on ${BASE} within ${deadlineMs} ms`);
}

async function main() {
  const fixture = JSON.parse(readFileSync("contracts/test/fixtures/report.json", "utf8")) as {
    signers: string[];
    workflowOwner: string;
  };
  ALLOWED.add(fixture.workflowOwner.toLowerCase());
  for (const signer of fixture.signers) ALLOWED.add(signer.toLowerCase());

  const accounts = new Set(
    (
      JSON.parse(readFileSync("data/completed.json", "utf8")) as { positions: { account: string }[] }
    ).positions.map((p) => p.account.toLowerCase()),
  );

  const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let failures = 0;

  try {
    await waitForServer();

    for (const path of ["/", "/styleguide"]) {
      const response = await fetch(`${BASE}${path}`);
      const html = await response.text();
      const hex = [...new Set((html.match(/0x[0-9a-fA-F]{40}/g) ?? []).map((h) => h.toLowerCase()))];
      const leakedAccounts = hex.filter((h) => accounts.has(h));
      const unexpected = hex.filter((h) => !ALLOWED.has(h));

      console.log(`${path} → ${response.status}, ${(html.length / 1024).toFixed(0)} KB`);
      console.log(`  40-hex strings in the response: ${hex.length === 0 ? "none" : hex.join(", ")}`);
      console.log(`  accounts from the sample: ${leakedAccounts.length}`);

      if (!response.ok) {
        console.error(`FAIL ${path} answered ${response.status}`);
        failures++;
      }
      if (leakedAccounts.length > 0) {
        console.error(`FAIL ${path} leaked ${leakedAccounts.length} sampled accounts`);
        failures++;
      }
      if (unexpected.length > 0) {
        console.error(`FAIL ${path} contains unexpected addresses: ${unexpected.join(", ")}`);
        failures++;
      }
    }

    // Non-vacuity: a page that rendered an error state would also contain no addresses.
    const home = await (await fetch(BASE)).text();
    for (const marker of ["signature verified", "Price shock to ETH and BTC", "Borrower overlap"]) {
      if (!home.includes(marker)) {
        console.error(`FAIL the dashboard did not render "${marker}"`);
        failures++;
      }
    }
    console.log(`sample count checked against: ${accounts.size} accounts`);
    console.log(failures === 0 ? "OK" : `${failures} failures`);
  } finally {
    server.kill("SIGTERM");
  }

  if (failures > 0) process.exitCode = 1;
}

await main();
