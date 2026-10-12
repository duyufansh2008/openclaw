# PR #148193: real Linux CPU behavior and upgrade proof

Tested on 2026-10-12 against **unchanged commit `8c68e283f3145d6455956867c81902ca7f908b43`**. The source checkout was clean. Both installed candidate prefixes report that commit in `dist/build-info.json`. No product source, package version, database compatibility guard, or inference response was patched to make a test pass.

Host: Debian 13, Linux 6.12.107+deb13-amd64 x86_64, Intel i5-8265U (4 cores / 8 threads), 16,415,363,072 bytes of physical RAM; Node 26.11.1. These are CPU runs with the managed verified llama-server b10809. A lightweight Bubblewrap/nsenter namespace uses a synthetic home and excludes the operator's credentials and real OpenClaw state. No Docker container was used. Network bandwidth was approximately 1 MB/s; the fresh media cell downloaded all four pinned GGUF artifacts, while subsequent cells reused verified local copies.

## Observed results

| Cell | Observation | Evidence |
| --- | --- | --- |
| Cold explicit media setup | Consent accepted; runtime and four models/projectors downloaded and verified; both real OCR/vision checks passed before routes were saved | [fresh setup](logs/fresh-media-setup.terminal.log.txt), [artifact hashes](integrity.json) |
| Decline | Configuration hash unchanged; model download directory absent, including an independently repeated empty-state cell with before/after receipt | [decline](logs/fresh-media-decline-repeat.terminal.log.txt), `decline-preservation.json` within [evidence](evidence.json) |
| Shipped image inference CLI | OCR returned `OPENCLAW OCR 4827`; vision returned `Red square`, both through local transport / HTTP 200 | [OCR](logs/fresh-ocr-cli.json.txt), [vision](logs/fresh-vision-cli.json.txt), [fixtures](ocr.png) |
| Genuine published updater | npm OpenClaw **2026.10.1** and its published llama.cpp plugin invoked the official updater to install the exact candidate artifact; exit 0, status `ok`, npm mode, 314,910 ms | [updater transcript](logs/published-updater-to-candidate.log.txt), [published integrity/build identities](integrity.json) |
| Stored memory compatibility | Schema 24 → 26; all 26 memory-prefixed tables (including virtual/shadow tables) / 32 snapshotted rows exactly preserved at activation; real post-update semantic search retrieved the pre-existing synthetic fact; dimensions 768, embedding probe successful, index identity valid | [snapshots, searches, statuses](evidence.json) |
| Existing configuration → media | Chat default, memory configuration, unrelated provider, audio/video routes retained; image routes became local with no fallback; stale preset section pruned; operator comments/settings retained | [setup](logs/existing-media-setup.terminal.log.txt), [configs](evidence.json), [before preset](before-media-native-preset.ini) |
| Media → ordinary local setup | Both media preset sections and operator settings retained; router keeps `--models-max 1` and compatible inherited `--image-max-tokens 512`; real embedding search still succeeds | [ordinary setup](logs/ordinary-setup-after-media.terminal.log.txt), [final preset](after-ordinary-native-preset.ini), [memory status](evidence.json) |
| Oversized inherited router setting | `--image-max-tokens 4096` refused against media limit 1024 before downloads; exit 1, configuration unchanged | [isolated guard](logs/oversized-router-isolated.terminal.log.txt) |
| Genuine inference failure rollback | A one-second OCR inference timeout made verification fail; existing config, native preset bytes and preset directory inventory remained exactly unchanged; candidate preset removed | [timeout](logs/verification-failure.terminal.log.txt), `failure-preservation.json` within [evidence](evidence.json) |
| Public Gateway scheduler Code Mode | Real catalog discovery and registered `local_image` execution; workspace relative, home-relative, managed inbound, and owner-derived approved attachment root all returned OCR text; existing outside-workspace file denied; omitted task selected vision and returned `Red square` | [script](local-image-proof-final.js), `code-mode-results.json` / run receipt within [evidence](evidence.json) |
| Structured Tool Search boundary | Installed public agent-harness SDK constructed the registered plugin surface; actual `tool_search` discovered the exact id; `tool_call` dispatched real OCR and exposed answer at `details.result.details.text` | [SDK script](structured-sdk-proof.mjs), [actual returned envelopes](logs/structured-sdk-proof.jsonl.txt) |

The Code Mode run finished successfully in 62,859 ms. Its approved attachment root is derived from the real scheduler owner's session key; identities are included in `evidence.json`. All four OCR copies and the denied outside file contained the same fixture. The typed OCR route was also tested with the misleading prompt "Describe its colors." The default vision question asked which shape is above the blue circle. The original PNGs were unchanged. A subsequent native `/models` observation showed only vision loaded and the other three inventory models unloaded; this is a point observation, not continuous residency measurement.

## Published-driver and data details

The baseline was an actual published npm install, with managed native presets, a configured pinned Qwen chat route, and a real EmbeddingGemma index containing `The blue lantern maintenance code is ORCHID-4827.` Real indexing and vector search were exercised before updating. The chat route was configured before updating; chat inference was first attempted after updating.

The unmodified PR still has package version **2026.9.9**, numerically below the published driver's 2026.10.1. This cell is therefore an **explicit candidate-artifact update**, not a claim that `update --channel stable` selects this PR or that the PR has been published. The published driver accepts the explicit artifact, runs its normal update/Doctor path, and activates the unchanged head. The updater's warnings remain in the transcript, including candidate version, the duplicated external plugin's min-API advisory, owner configuration, and optional maintenance diagnostics. No version spoofing or compatibility bypass was used.

At activation, memory snapshots have identical SHA256 `cef625323b9da6b15e0df1dd23f128a4fbc0519157f46f06caba12bd5a74c79d`; the native preset is byte-identical. Existing `models`, `tools`, `memory`, and `agents.defaults` are unchanged. Doctor updates bookkeeping under `meta`/`wizard` and adds an empty `agents.entries.main` record.

The **first normal post-update search automatically repairs the derived index**, upgrading chunking version 5 → 6 and embedding-input format 0 → 1, rebuilding embeddings and adding a cache row. Existing chunk identities/text remain and the original fact is retrieved. The repeat query no longer warns. No manual forced reindex or SQL edits were made after the update. This proves stored data loads and works; it does not claim the derived index remains unchanged after queries.

## Reproduction entry points

The canonical packaging helper builds a tarball locally; its name does not mean a Docker container is required:

```sh
node scripts/package-openclaw-for-docker.mjs \
  --allow-unreleased-changelog --bundle-plugin llama-cpp \
  --output-dir /artifacts --output-name openclaw-pr148193.tgz
```

The tarball SHA256 is `dc3fb564df873dea5c22bac63de09d142cc4dee75e35e28c0ec0fde0bf01a47f`. Packaging passed integrity checks; it retained the unrelated Control UI startup-budget warning (36 requests versus 35).

With a genuine published installation in `/home/proof/stable-prefix` and the candidate artifact mounted at `/artifacts`:

```sh
env npm_config_prefix=/home/proof/stable-prefix \
  npm_config_allow_scripts=openclaw,esbuild,protobufjs,@google/genai,koffi \
  PATH=/home/proof/stable-prefix/bin:/proof/bin:/usr/bin:/bin \
  OPENCLAW_DEBUG=1 \
  /home/proof/stable-prefix/bin/openclaw update \
    --tag file:/artifacts/openclaw-pr148193.tgz --yes --no-restart --json
```

Media and ordinary setup use their shipped interactive CLI entry points (the transcript records consent):

```sh
openclaw models auth login --provider llama-cpp --method local-media
openclaw models auth login --provider llama-cpp --method local
openclaw infer image describe --file /home/proof/workspace/ocr.png \
  --model llama-cpp/glm-ocr-q8_0 --timeout-ms 600000 --json
openclaw infer image describe --file /home/proof/workspace/vision.png \
  --model llama-cpp/smolvlm2-2.2b-instruct-q4_k_m \
  --prompt 'Which shape is above the blue circle? Answer with its color and shape.' \
  --timeout-ms 600000 --json
```

For Code Mode, use the public `automations add` / `edit` / `run --wait` entry points with the included script: disabled every-hour job, isolated session, agent `main`, no delivery, tool allowlist `local_image`, script timeout 900 seconds, tool budget 10. After obtaining the job id, derive the owner key `agent:main:cron:<id>:trigger`, compute its approved subagent attachment root, create the fixture there, and update the script's absolute approved path. The actual job id, run id, owner key and outcome are in `evidence.json`. For the structured boundary, run `node structured-sdk-proof.mjs` against the installed candidate; its imports use exported SDK files and it invokes the real registered tool, without a mocked API, manually captured plugin factory, or fabricated model reply.

## Scope and retained limitations

These are small synthetic English OCR/spatial fixtures on one Linux CPU host. They do not measure multilingual OCR accuracy, general vision quality, other RAM tiers, GPUs or other platforms. Scheduler headless Code Mode and the public SDK structured Tool Search boundary passed. **Conversational autonomous tool selection did not pass**: the real Qwen2.5 0.5B agent turn emitted text until its output limit and made zero bridge calls. That attempt is retained in `evidence.json`; it is not used as a successful Tool Search or conversational Code Mode proof.

Initial incomplete baseline/PID-namespace preparation attempts were corrected before the recorded cells; only the final isolated oversized-limit attempt is counted. Small SDK driver mistakes about the real response envelope were corrected before its successful final run; product code was unchanged.

Only synthetic state is published. Config `apiKey` local markers are redacted. Public model URLs and loopback endpoints are retained for reproducibility; no operator account state or non-public endpoint is included. Terminal files remove ANSI formatting and transient spinner/progress repaints while retaining diagnostic warnings and final results. [integrity.json](integrity.json) records raw local file hashes and cleaned-file hashes; the raw transcripts remain on the test machine. [snapshot.py](snapshot.py) records SQLite logical rows with BLOB hashes. Product feature-branch history is unchanged; this evidence is stored on a separate fork branch.
