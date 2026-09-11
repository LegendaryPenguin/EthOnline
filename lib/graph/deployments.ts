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
