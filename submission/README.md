# Submission assets

Rebuild with `npm run submission:assets`. Nothing here is hand-edited, so a colour token or a
figure moving is one command rather than a redraw.

| file | what the form asks for | what it is |
|---|---|---|
| `sentinel-logo.png` | logo, square 512x512 | two rings and the lens where they overlap, inside the boundary the overlap is computed behind |
| `sentinel-cover.png` | cover, 16:9 1920x1080 | the claim, the live figure and its block, and the three sponsor surfaces |
| `sentinel-ss1.png` | screenshot | the dashboard: the signal, rendered only after the signer quorum verifies |
| `sentinel-ss2.png` | screenshot | the cascade: two standardized schemas joined, shock ladder against real DEX depth |
| `sentinel-ss3.png` | screenshot | the explorer: the cross-protocol read with no address anywhere in it |

The screenshots are copies of `docs/evidence/screens/`, which `npm run capture:ui` regenerates and
`npm run check:ui` audits for leaked addresses. The demo video is `docs/demo.mp4`.
