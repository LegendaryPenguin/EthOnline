# Phase 1 evidence — one query document, five protocols

Captured live. Every row below comes from the **same unmodified GraphQL document**
executed against five different lending-protocol subgraphs. No per-protocol adapters,
no field remapping — that is the standardized-schema leverage this project rests on.

## Query (verbatim, unmodified across all endpoints)

```graphql
{
  _meta { block { number } }
  lendingProtocols { name schemaVersion totalBorrowBalanceUSD cumulativeUniqueUsers }
  positions(first: 1, orderBy: balance, orderDirection: desc) {
    id side isCollateral balance
    account { id }
    market { name liquidationThreshold inputTokenPriceUSD }
  }
}
```

## Results — all five at the same chain-head block 25963504

| Protocol | Subgraph ID | Messari schema | totalBorrowBalanceUSD | cumulativeUniqueUsers |
|---|---|---|---|---|
| Aave V3 Ethereum | `JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk` | 3.1.0 | 9,884,244,952 | 4,511,520 |
| Compound V3 Ethereum | `AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9` | 3.1.0 | 580,742,995 | 382,694 |
| Aave V2 Ethereum | `C2zniPn45RnLDGzVeGZCx2Sw3GXrbc9gL4ZfL8B8Em2j` | 3.1.0 | 13,969,316 | 1,412,480 |
| Compound V2 Ethereum | `4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a` | 2.0.1 | 11,949,182 | 434,031 |
| Morpho Aave V2 Ethereum | `DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy` | 3.0.1 | 5,970 | 3,451 |

All five returned identical `_meta.block.number` = **25963504**, i.e. every deployment
is synced to chain head. Data is live, not mocked or static.

## Notable finding: schema version skew

The five deployments span three schema versions (3.1.0, 3.0.1, 2.0.1). A standard is a
floor, not a guarantee of uniformity, so the client negotiates per-deployment
capability rather than assuming a single version. This is handled explicitly in
`lib/graph/` rather than papered over.
