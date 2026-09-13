/**
 * The interface must not be the leak.
 *
 * Sentinel's whole argument is that a per-address leverage map is itself the harm, so the
 * view model — the last thing between the sample and the browser — is where that claim
 * either holds or quietly stops holding. The first test below serialises everything the
 * page renders and looks for *any* account address from the underlying sample. It is
 * deliberately blunt: it does not check the fields it expects to be safe, it checks all of
 * them, including ones added later by someone who has not read this file.
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDashboard, AGING_HOURS, type DashboardData } from "../view-model";
import { defaultShockLadderBps, MAX_SHOWN_ROUNDS } from "../ladder";

const DATA = ["data/shock-ladder.json", "data/cascade.json", "data/completed.json"];
const haveData = DATA.every((p) => existsSync(p));

async function ready(now?: number): Promise<DashboardData> {
  const state = await loadDashboard(now);
  if (state.status !== "ready") {
    throw new Error(`dashboard was ${state.status}: ${JSON.stringify(state).slice(0, 300)}`);
  }
  return state.data;
}

describe.runIf(haveData)("the view model", () => {
  it("carries no account address from the sample", async () => {
    const data = await ready();
    const serialised = JSON.stringify(data).toLowerCase();

    const positions = JSON.parse(readFileSync("data/completed.json", "utf8")) as {
      positions: { account: string }[];
    };
    const accounts = [...new Set(positions.positions.map((p) => p.account.toLowerCase()))];
    expect(accounts.length).toBeGreaterThan(100);

    const leaked = accounts.filter((a) => serialised.includes(a));
    expect(leaked, `addresses reachable from the browser: ${leaked.slice(0, 3).join(", ")}`).toEqual([]);
  });

  it("carries no 40-hex string at all, so a new field cannot leak one either", async () => {
    // Stricter than the test above and for a different reason: asset and market ids are
    // also addresses, and the interface has no need for them. Labels are symbols.
    const data = await ready();
    const found = JSON.stringify(data).match(/0x[0-9a-fA-F]{40}/g) ?? [];
    const allowed = [data.report.workflowOwner.toLowerCase(), ...data.report.acceptedSigners.map((s) => s.toLowerCase())];
    const unexpected = found.map((f) => f.toLowerCase()).filter((f) => !allowed.includes(f));
    // The signer set and workflow owner are public infrastructure identities, not people.
    expect([...new Set(unexpected)]).toEqual([]);
  });

  it("shows the signal it verified, with the quorum it satisfied", async () => {
    const data = await ready();
    expect(data.report.version).toBe("sentinel-signal/1");
    expect(data.report.acceptedSigners.length).toBeGreaterThanOrEqual(data.report.requiredSigners);
    expect(data.report.signerSetSize).toBeGreaterThanOrEqual(data.report.acceptedSigners.length);
    expect(data.report.asOfBlock).toBeGreaterThan(20_000_000);
    // Non-vacuity: the figures are the real ones, not a zeroed struct.
    expect(data.report.figures.debtUsd).toBeGreaterThan(1e9);
    expect(data.report.figures.evaluableDebtUsd).toBeLessThan(data.report.figures.debtUsd);
    expect(data.report.figures.suppressedBuckets).toBeGreaterThan(0);
  });

  it("reports its own age instead of implying the data is current", async () => {
    const data = await ready();
    expect(data.provenance.asOfBlock).toBe(Math.min(...Object.values(data.provenance.blocks)));

    const captured = new Date(data.provenance.capturedAt).getTime();
    const fresh = await ready(captured + 60_000);
    expect(fresh.provenance.freshness).toBe("fresh");
    const aging = await ready(captured + 3 * 3_600_000);
    expect(aging.provenance.freshness).toBe("aging");
    const stale = await ready(captured + (AGING_HOURS + 1) * 3_600_000);
    expect(stale.provenance.freshness).toBe("stale");
  });

  it("draws only edges that can transmit something", async () => {
    const data = await ready();
    const ids = new Set(data.graph.nodes.map((n) => n.id));
    for (const edge of data.graph.edges) {
      expect(ids.has(edge.source), `edge source ${edge.source}`).toBe(true);
      expect(ids.has(edge.target), `edge target ${edge.target}`).toBe(true);
    }
    // Every asset node is held at more than one protocol, or it could not propagate.
    for (const node of data.graph.nodes.filter((n) => n.kind === "asset")) {
      const links = data.graph.edges.filter((e) => e.source === node.id);
      expect(links.length, `${node.label} is posted at one protocol only`).toBeGreaterThan(1);
    }
    // Layout is inside the unit square, so the client can scale without clamping.
    for (const node of data.graph.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(1);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeLessThanOrEqual(1);
    }
  });

  it("is laid out identically on every load", async () => {
    // A force layout would not be, and then no screenshot in the docs could be compared
    // to what a reader sees.
    const [a, b] = [await ready(), await ready()];
    expect(a.graph.nodes).toEqual(b.graph.nodes);
  });
});

describe.runIf(haveData)("the shock ladder", () => {
  it("covers the slider's whole range in even steps", async () => {
    const { ladder } = await ready();
    expect(ladder.steps.map((s) => s.shockBps)).toEqual(defaultShockLadderBps());
  });

  it("liquidates nothing at a zero shock", async () => {
    const { ladder } = await ready();
    const zero = ladder.steps[0];
    expect(zero.shockBps).toBe(0);
    expect(zero.totalLiquidatedDebtUsd).toBe(0);
    expect(zero.rounds).toEqual([]);
  });

  it("brackets every rung rather than point-estimating it", async () => {
    const { ladder } = await ready();
    for (const step of ladder.steps) {
      expect(
        step.upperBound.distressedDebtUsd,
        `upper bound below the point estimate at ${step.shockBps} bps`,
      ).toBeGreaterThanOrEqual(step.distressedDebtUsd);
    }
  });

  it("summarises long cascades instead of shipping every round", async () => {
    const { ladder } = await ready();
    for (const step of ladder.steps) {
      expect(step.rounds.length).toBeLessThanOrEqual(MAX_SHOWN_ROUNDS);
      if (step.roundsToConvergence > MAX_SHOWN_ROUNDS) {
        expect(step.tail, `${step.shockBps} bps ran ${step.roundsToConvergence} rounds`).not.toBeNull();
      }
    }
  });

  it("records where distress falls as the shock grows", async () => {
    // 72% of the sample's debt is WETH-denominated, so some books get safer as ETH
    // falls. The reversal is a property of the book, and the ladder names it rather than
    // smoothing it — see `lib/ui/ladder.ts`.
    const { ladder } = await ready();
    for (const reversal of ladder.distressReversals) {
      const step = ladder.steps.find((s) => s.shockBps === reversal.shockBps)!;
      const previous = ladder.steps.find((s) => s.shockBps === reversal.previousShockBps)!;
      expect(previous.distressedDebtUsd - step.distressedDebtUsd).toBeCloseTo(reversal.fellByUsd, 6);
    }
  });

  it("holds the five-point monotonicity gate that caught the round-1 flood", async () => {
    const { ladder } = await ready();
    const coarse = ladder.steps.filter((s) => s.shockBps % 500 === 0);
    for (let i = 1; i < coarse.length; i++) {
      expect(coarse[i].distressedDebtUsd).toBeGreaterThanOrEqual(coarse[i - 1].distressedDebtUsd - 1);
    }
  });
});

describe("the empty state", () => {
  it("names what is missing and the commands that produce it", async () => {
    // The fresh-clone path, exercised by running from a directory that has no `data/`.
    // A spinner would be the wrong answer here: nothing is loading, and nothing will.
    const cwd = process.cwd();
    const empty = mkdtempSync(join(tmpdir(), "sentinel-empty-"));
    try {
      process.chdir(empty);
      const state = await loadDashboard();
      expect(state.status).toBe("empty");
      if (state.status !== "empty") return;
      expect(state.missing).toContain("data/shock-ladder.json");
      expect(state.commands).toContain("npm run shock:ladder");
    } finally {
      process.chdir(cwd);
    }
  });
});
