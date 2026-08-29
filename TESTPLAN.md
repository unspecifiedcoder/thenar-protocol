# THENAR — test plan

Every page, endpoint, contract call and flow that exists today, with what
"correct" means for each. A pass means the observed result matches the
**Correct** column exactly, with a clean console and no failed requests.

Target: https://thenar.io · Monad Testnet (10143)

| Contract | Address |
| --- | --- |
| `GraspLog` | `0x10325941C86397a4355b4801dC28EDf6c41F3c6f` |
| `GraspMarket` | `0x0f87309F410BDBB13B3E0d5c206e7aAC1397fBFa` |
| `TaskRegistry` | `0x70244c42300f427a721a86416331d2a8d6ce2a51` |
| `FoundryMarket` | `0x754845ff489f16a4a216562f0029aea29c678bad` |
| `LeafVerifier` | `0xc98c786dbac66ce418bde2d0170b3a1b137281cd` |

---

## Pages

| # | Item | Correct means |
| --- | --- | --- |
| P1 | `/` landing | 200. Title "THENAR — contact data for physical AI". Hero renders. The three.js rigs (band, grasp trace, hotaru) initialise without console error. |
| P2 | `/` ledger strip | Reads GraspLog over JSON-RPC and draws the anchors the chain actually holds. Shows "ANCHORED BATCHES, MONAD TESTNET" and "READ LIVE FROM THE CONTRACT — NOT A SIMULATION". Never draws invented blocks. |
| P3 | `/` RPC failure | With the RPC unreachable the strip says it could not reach Monad. It must not fall back to fabricated blocks. |
| P4 | `/protocol` | 200. Describes the leaf, the monotonic head, revocation, payment-with-terms. |
| P5 | `/market` | 200. Go-to-market copy renders. |
| P6 | `/products` | 200. |
| P7 | `/faq` | 200. |
| P8 | `/company` | 200. |
| P9 | `/terms` and `/privacy` | 200 each. |
| P10 | 404 | An unknown path renders the in-world 404, not a stack trace. |
| P11 | `/verify` loads | 200. Log and market addresses render and link to the explorer. Head reads "N captures across M anchors" from chain. |
| P12 | `/verify` anchor table | Every anchor the chain holds, newest first, with index, root, size, block, and whether it carries a withdrawal. |
| P13 | `/verify` sample load | "Load a real capture" fills the form from `sample-proof.json`. |
| P14 | `/verify` positive | Asking the contract with the loaded sample answers **in the log**. |
| P15 | `/verify` negative | One byte altered in the preimage → **not in the log**. |
| P16 | `/verify` wrong length | A preimage that is not 154 bytes is refused client-side with a readable message naming the actual length. |
| P17 | Nav | Every page links to Products, Protocol, Market, FAQ, Company, Verify. No dead links. |
| P18 | Mobile 375×812 | Nav does not overlap; no horizontal body scroll; the verify table scrolls in its own container. |

## Static assets

| # | Item | Correct means |
| --- | --- | --- |
| A1 | `/grasp-chain.js` | 200, and contains the current `GraspLog` address. |
| A2 | `/sample-proof.json` | 200, `expected: true`, 154-byte preimage. |
| A3 | `/sample-task.json` | 200. Contains the published TaskSpec, registry and market addresses. |
| A4 | `/site.css`, `/mark.svg`, `/og.png` | 200 each. |
| A5 | No orphan assets | Every shipped `.js` is referenced by at least one page. |

## API

| # | Item | Correct means |
| --- | --- | --- |
| E1 | `POST /api/join` valid | Accepts a name and a real-looking email. Either sends via Resend and returns success, or fails **loudly** with the reason. Never a cheerful 200 that drops the person. |
| E2 | `POST /api/join` bad email | 400 with a readable error. |
| E3 | `POST /api/join` empty body | 400, not a 500. |
| E4 | `GET /api/join` | 405 with an `Allow: POST` header. |

## Contracts — reads

| # | Item | Correct means |
| --- | --- | --- |
| C1 | `GraspLog.anchorCount` | Returns the real count; matches what `/verify` renders. |
| C2 | `GraspLog.anchorAt(i)` | Every anchor's `prevRoot` equals the previous anchor's `root`; size strictly increases. |
| C3 | **Anchor coherence** | For every anchor, the stored `size` is the size of the tree its `root` was computed from. An anchor whose size and root disagree is a FAIL — no inclusion proof can verify against it. |
| C4 | `GraspLog.verifyClip` capture | A genuine capture preimage + proof returns true. |
| C5 | `LeafVerifier.verifyLeaf` capture | Same capture verifies through the version-agnostic path. |
| C6 | `LeafVerifier.verifyLeaf` episode | A 197-byte episode preimage + proof against its anchor returns true. |
| C7 | `LeafVerifier.episodeFacts` | Returns the taskId, worldSeed, success flag and quality score committed in the preimage. |
| C8 | `LeafVerifier` version guards | Unknown version, empty preimage, and version/length disagreement each revert with a named error. |
| C9 | `TaskRegistry.taskAt` | The published task reads back with its curator, share and target. |
| C10 | `FoundryMarket.capTable` | Weights sum to the recorded total and differ by quality. |
| C11 | `GraspLog.verifyAppendOnly` | A consistency proof between two coherent anchors returns true. |
| C12 | `GraspLog.verifyConsentLive` | A key never revoked proves non-membership against the anchored revocation root. |

## Contracts — writes (real transactions)

| # | Item | Correct means |
| --- | --- | --- |
| W1 | `GraspLog.anchor` monotonic | A size that does not grow reverts `SizeMustGrow`; an unchanged root reverts `RootMustChange`. |
| W2 | `TaskRegistry.publish` | Writes the task; a duplicate spec hash reverts `AlreadyPublished`; a share above 3000 bps reverts. |
| W3 | `FoundryMarket.sealCorpus` | Refuses a root the log never anchored, mismatched cap-table lengths, and all-zero weights. |
| W4 | `FoundryMarket.license` | Pays curator, contributors and protocol in one transaction; no value stranded in the contract. |

## Flows

| # | Item | Correct means |
| --- | --- | --- |
| F1 | Verify a capture end to end | Load the sample on `/verify`, ask the contract, get "in the log", with zero console errors. |
| F2 | Verify an episode end to end | The same page accepts a 197-byte episode leaf and answers from `LeafVerifier`. |
| F3 | Task → episodes → corpus → licence | A curator publishes, episodes anchor, the corpus seals, a buyer licenses, everyone is paid their exact share. |
| F4 | Scene reconstruction | Given a taskId and worldSeed read from chain, the scene rebuilds byte-identically. |
| F5 | Consent withdrawal | A withdrawn key stops proving live, and the chain reports the block it became knowable. |

## Suites

| # | Item | Correct means |
| --- | --- | --- |
| S1 | `forge test` | Every Solidity suite passes. |
| S2 | `packages/protocol/test/run.ts` | All protocol checks pass. |
| S3 | `packages/protocol/test/foundry.ts` | All TaskSpec, sampler and registry checks pass. |
| S4 | `pnpm test:protocol` | Runs **both** TypeScript suites, not just one. |
| S5 | Solidity/TypeScript agreement | Episode encoding in `episode.ts` and `EpisodeLeaf.sol` produce identical bytes and identical leaf hashes. |

## Global

| # | Item | Correct means |
| --- | --- | --- |
| G1 | Console | Zero errors on every page. |
| G2 | Network | Zero failed requests on every page. |
| G3 | No mocks | Zero mock/stub/fake/placeholder/TODO in shipped code. |
| G4 | Contract verification | All five contracts report verified on Sourcify. |
| G5 | Repo parity | `thenar-avax` carries the same protocol and contract sources as `thenar-monad`. |
