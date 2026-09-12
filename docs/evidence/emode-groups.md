# E-Mode correlated asset groups

Derived 2026-09-12T22:30:52.098Z by `npm run emode:groups`.

Aave V3 E-Mode raises the liquidation threshold for a book whose collateral and debt are correlated. The Messari lending schema does not express it, and ignoring it made $3.9B of $5.7B of observed debt compute insolvent while alive on chain. These groups are what let the confidential workflow evaluate those books instead of discarding them.

Each asset below was regressed on the ETH and BTC factors over up to a year of the protocols' own oracle prices and classified by `classifyAsset` in `lib/cascade/emode.ts` — the same function the runtime inference calls, so the groups cannot mean something different from the code that applies them. Threshold: **0.95**, hand-verified against Aave's `getUserAccountData` in `npm run verify:emode`.

Group membership takes one requirement beyond that classification: the asset must load within 0.15 of 1 on its own anchor and no more than 0.2 on the other one (`tracksAnchor`). Sharing a liquidation threshold is a stronger claim than sharing a shock: LINK falls when ETH falls and should be shocked with it, but it is not an Aave E-Mode pair with WETH, and admitting it would manufacture solvency for a book that does not have it.

## ETH — 5 assets

| asset | address | depth | beta ETH | beta BTC | R2 | daily vol | obs |
|---|---|---|---|---|---|---|---|
| WETH | `0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2` | $5,339,547,113 | 1.000 | 0.000 | 100.0% | 0.03391 | 364 |
| weETH | `0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee` | $3,663,926,488 | 0.940 | 0.073 | 94.7% | 0.03436 | 364 |
| wstETH | `0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0` | $2,871,535,606 | 0.979 | 0.032 | 98.6% | 0.03414 | 364 |
| rETH | `0xae78736cd615f374d3085123a210448e74fc6393` | $105,943,357 | 0.937 | 0.000 | 76.0% | 0.03664 | 354 |
| cbETH | `0xbe9895146f7af43049ca1c1ae358b0541ea49704` | $16,881,177 | 0.977 | -0.116 | 71.2% | 0.03650 | 312 |

## BTC — 4 assets

| asset | address | depth | beta ETH | beta BTC | R2 | daily vol | obs |
|---|---|---|---|---|---|---|---|
| WBTC | `0x2260fac5e5542a773aa44fbcfedf7c193bc2c599` | $2,628,356,268 | 0.000 | 1.000 | 100.0% | 0.02347 | 364 |
| cbBTC | `0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf` | $1,404,333,340 | -0.002 | 0.999 | 98.2% | 0.02359 | 364 |
| LBTC | `0x8236a87084f8b84306f72007f36f2618a5634494` | $209,004,741 | 0.002 | 0.883 | 75.8% | 0.02409 | 356 |
| tBTC | `0x18084fba666a33d37592fa2633fd49a74dd93a88` | $132,560,303 | 0.028 | 0.915 | 88.9% | 0.02375 | 360 |

## USD — 14 assets

| asset | address | depth | beta ETH | beta BTC | R2 | daily vol | obs |
|---|---|---|---|---|---|---|---|
| USDT | `0xdac17f958d2ee523a2206206994597c13d831ec7` | $3,175,154,398 | -0.003 | 0.006 | 4.9% | 0.00031 | 364 |
| USDC | `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` | $2,374,340,229 | -0.001 | 0.001 | 0.8% | 0.00011 | 364 |
| USDe | `0x4c9edd5852cd905f086c759e8383e09bff1e68b3` | $630,318,949 | -0.003 | 0.006 | 4.9% | 0.00031 | 364 |
| sUSDe | `0x9d39a5de30e57443bff2a8307a4256c8797a3497` | $232,880,951 | -0.002 | 0.005 | 4.2% | 0.00031 | 364 |
| GHO | `0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f` | $135,162,787 | 0.000 | 0.000 | 0.0% | 0.00000 | 364 |
| DAI | `0x6b175474e89094c44da98b954eedeac495271d0f` | $132,129,155 | 0.001 | -0.000 | 1.5% | 0.00018 | 364 |
| syrupUSDT | `0x356b8d89c1e1239cbbb9de4815c39a1474d5ba7d` | $111,886,582 | -0.001 | 0.002 | 1.5% | 0.00023 | 199 |
| USDtb | `0xc139190f447e929f090edeb554d95abb8b18ac1c` | $15,500,674 | 0.001 | -0.000 | 0.4% | 0.00023 | 364 |
| USDG | `0xe343167631d89b6ffc58b88d6b7fb0228795491d` | $10,777,518 | 0.000 | 0.000 | 2.0% | 0.00006 | 246 |
| USDS | `0xdc035d45d973e3ec169d2276ddab16f1e407384f` | $9,359,848 | -0.000 | 0.000 | 0.7% | 0.00012 | 364 |
| PYUSD | `0x6c3ea9036406852006290770bedfcaba0e23a0e8` | $7,521,464 | -0.000 | -0.000 | 0.1% | 0.00016 | 364 |
| PT-srUSDe-22OCT2026 | `0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34` | $6,116,363 | -0.006 | 0.011 | 4.3% | 0.00051 | 76 |
| RLUSD | `0x8292bb45bf1ee4d140127049757c2e0ff06317ed` | $4,633,118 | -0.000 | 0.001 | 0.8% | 0.00011 | 364 |
| LUSD | `0x5f98805a4e8be255a32880fdec7f6728c6568ba0` | $1,917,237 | -0.002 | 0.007 | 0.6% | 0.00130 | 183 |

## Classified into no group — 19 assets

These keep their published thresholds. An asset with too little history or a poor factor fit is *unmeasured*, which is not the same as uncorrelated — so no E-Mode is claimed for it, and a book containing one does not qualify.

| asset | address | depth | beta ETH | beta BTC | R2 | obs | why |
|---|---|---|---|---|---|---|---|
| rsETH | `0xa1290d69c65a6fe4df752f95823fae25cb99e5a7` | $908,264,746 | 0.573 | 0.242 | 50.6% | 250 | fit or beta below the gate |
| osETH | `0xf1c9acdc66974dfb6decb12aa385b9cd01190e38` | $325,322,902 | 0.582 | 0.120 | 45.2% | 254 | fit or beta below the gate |
| AAVE | `0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9` | $103,327,018 | 0.817 | 0.348 | 57.6% | 364 | fit or beta below the gate |
| LINK | `0x514910771af9ca656af840dff83e8264ecf986ca` | $95,835,807 | 0.807 | 0.298 | 79.2% | 364 | in ETH by shock beta, but does not track the anchor |
| XAUt | `0x68749665ff8d2d112fa859aa293f07a622782f38` | $65,632,413 | 0.045 | 0.166 | 11.4% | 362 | fit or beta below the gate |
| ETH | `0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` | $55,523,112 | 0.779 | 0.147 | 78.6% | 352 | in ETH by shock beta, but does not track the anchor |
| EURC | `0x1abaea1f7c830bd89acc67ec4af516284b1bc33c` | $46,996,082 | 0.019 | 0.011 | 8.2% | 364 | fit or beta below the gate |
| sFRAX | `0xa663b02cf0a4b149d2ad41910cb81e23e1c41c32` | $36,695,854 | 0.000 | 0.000 | 0.0% | 0 | only 0 overlapping daily returns, below the 60 needed; no beta is assumed |
| FBTC | `0xc96de26018a54d51c097160568752c4e3bd6c364` | $14,282,930 | 0.208 | 0.192 | 30.0% | 101 | fit or beta below the gate |
| stETH | `0xae7ab96520de3a18e5e111b5eaab095312d7fe84` | $8,722,274 | 0.685 | -0.110 | 34.9% | 337 | fit or beta below the gate |
| eBTC | `0x657e8c867d8b37dcc18fa4caead9c45eb088c642` | $6,408,710 | 0.041 | 0.690 | 49.4% | 222 | fit or beta below the gate |
| tETH | `0xd11c452fc99cf405034ee446803b6f6c1f6d5ed8` | $4,098,429 | 0.000 | 0.000 | 0.0% | 11 | only 11 overlapping daily returns, below the 60 needed; no beta is assumed |
| UNI | `0x1f9840a85d5af5bf1d1762f925bdaddc4201f984` | $2,690,816 | 0.677 | 0.317 | 30.8% | 293 | fit or beta below the gate |
| CRV | `0xd533a949740bb3306d119cc777fa900ba034cd52` | $2,666,371 | 0.828 | 0.044 | 26.3% | 229 | fit or beta below the gate |
| DAI | `0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359` | $2,268,401 | 0.000 | 0.000 | 0.0% | 46 | only 46 overlapping daily returns, below the 60 needed; no beta is assumed |
| BAT | `0x0d8775f648430679a709e98d2b0cb6250d2887ef` | $2,185,465 | 0.713 | -0.164 | 14.7% | 120 | fit or beta below the gate |
| COMP | `0xc00e94cb662c3520282e6f5717214004a7f26888` | $2,018,501 | 0.448 | -0.409 | 3.6% | 109 | fit or beta below the gate |
| AMPL | `0xd46ba6d942050d489dbd938a2c909a5d5039a161` | $1,653,166 | 0.000 | 0.000 | 0.0% | 0 | only 0 overlapping daily returns, below the 60 needed; no beta is assumed |
| BTC.b | `0xb0f70c0bd6fd87dbeb7c10dc692a2a6106817072` | $1,142,757 | 0.000 | 0.000 | 0.0% | 46 | only 46 overlapping daily returns, below the 60 needed; no beta is assumed |

## The policy block

Paste into `SENTINEL_RISK_POLICY`. Secret: see `lib/signal/policy.ts` for why.

```json
{
  "emode": {
    "threshold": 0.95,
    "groups": [
      [
        "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee",
        "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
        "0xae78736cd615f374d3085123a210448e74fc6393",
        "0xbe9895146f7af43049ca1c1ae358b0541ea49704"
      ],
      [
        "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
        "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
        "0x8236a87084f8b84306f72007f36f2618a5634494",
        "0x18084fba666a33d37592fa2633fd49a74dd93a88"
      ],
      [
        "0xdac17f958d2ee523a2206206994597c13d831ec7",
        "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        "0x4c9edd5852cd905f086c759e8383e09bff1e68b3",
        "0x9d39a5de30e57443bff2a8307a4256c8797a3497",
        "0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f",
        "0x6b175474e89094c44da98b954eedeac495271d0f",
        "0x356b8d89c1e1239cbbb9de4815c39a1474d5ba7d",
        "0xc139190f447e929f090edeb554d95abb8b18ac1c",
        "0xe343167631d89b6ffc58b88d6b7fb0228795491d",
        "0xdc035d45d973e3ec169d2276ddab16f1e407384f",
        "0x6c3ea9036406852006290770bedfcaba0e23a0e8",
        "0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34",
        "0x8292bb45bf1ee4d140127049757c2e0ff06317ed",
        "0x5f98805a4e8be255a32880fdec7f6728c6568ba0"
      ]
    ]
  }
}
```
