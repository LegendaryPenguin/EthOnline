/**
 * Registry of Messari Lending/CDP standardized-schema deployments.
 *
 * Every entry here answers the same query document. That is the whole point:
 * adding a protocol to Sentinel means adding a row to this table, not writing
 * an adapter. See docs/evidence/phase1-multiprotocol-query.md.
 *
 * `schemaVersion` is the version observed live at registration time. It is a
 * hint only — the client re-reads it at runtime, because deployments upgrade
 * independently and the skew is real (3.1.0, 3.0.1 and 2.0.1 all in use).
 */

export type Deployment = {
  /** Stable key used in snapshots and reports. */
  key: string;
  /** Human label for UI and video. */
  label: string;
  /** Subgraph ID on the decentralized network. */
  subgraphId: string;
  network: string;
  /** Messari schema version observed at registration. */
  schemaVersion: string;
};

export const DEPLOYMENTS: Deployment[] = [
  {
    key: "aave-v3-eth",
    label: "Aave V3",
    subgraphId: "JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk",
    network: "mainnet",
    schemaVersion: "3.1.0",
  },
  {
    // Registered on purpose, and rejected at runtime on purpose. Its position
    // mappings handle Borrow but not Repay — positions show up to 41 borrows and
    // zero repays — so `balance` is lifetime cumulative borrowing, overstating
    // outstanding debt by three orders of magnitude: 1925x on one snapshot,
    // 1011x on another. The multiple moves with whichever positions the sample
    // draws; what does not move is that sampled debt exceeds protocol-reported
    // debt, and a subset cannot legitimately exceed its total. The gate keys on
    // that inequality, not on the size of the miss. The gate in snapshot.ts catches
    // this without any Aave-specific code and records the reason in provenance.
    // Keeping the row is the evidence that the gate does something.
    key: "aave-v2-eth",
    label: "Aave V2",
    subgraphId: "C2zniPn45RnLDGzVeGZCx2Sw3GXrbc9gL4ZfL8B8Em2j",
    network: "mainnet",
    schemaVersion: "3.1.0",
  },
  {
    key: "compound-v3-eth",
    label: "Compound V3",
    subgraphId: "AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9",
    network: "mainnet",
    schemaVersion: "3.1.0",
  },
  {
    key: "compound-v2-eth",
    label: "Compound V2",
    subgraphId: "4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a",
    network: "mainnet",
    schemaVersion: "2.0.1",
  },
  {
    key: "morpho-aave-v2-eth",
    label: "Morpho Aave V2",
    subgraphId: "DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy",
    network: "mainnet",
    schemaVersion: "3.0.1",
  },
];

export function deploymentByKey(key: string): Deployment | undefined {
  return DEPLOYMENTS.find((d) => d.key === key);
}

/**
 * Mainnet lending subgraphs that were evaluated and did not qualify.
 *
 * Recorded because the reach of the standard is a finding, not a marketing
 * claim. Sentinel covers the lending protocols that actually publish the Messari
 * schema on the decentralized network; these publish lending data under their own
 * schemas, so including them would mean writing exactly the per-protocol adapters
 * the standard is supposed to make unnecessary.
 */
export const REJECTED_CANDIDATES = [
  {
    label: "Silo Finance v2 Mainnet",
    subgraphId: "2z5Mn4WW7K4yR1iH9KdignREkTq9EM1S4GX3yLaztRFg",
    reason: "has a LendingProtocol type, but no totalBorrowBalanceUSD or totalValueLockedUSD",
  },
  {
    label: "Fraxlend Mainnet",
    subgraphId: "8G87c8NeUgFYsrHSgETW8GTJv6gF5NfzZ6szgkcMDH3J",
    reason: "no lendingProtocols field; not the Messari lending schema",
  },
  {
    label: "Silo v1 Mainnet",
    subgraphId: "2f5AXi3o6zSvEGrwq6E7KFgbUwLYREiSai5iMfkczi92",
    reason: "no lendingProtocols field; not the Messari lending schema",
  },
] as const;
