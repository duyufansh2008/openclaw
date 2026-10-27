---
title: "Resumable Git update downloads"
summary: "Proposal and runnable protocol experiment for byte-resumable Git update artifacts"
read_when:
  - Designing recovery from interrupted Git update downloads
  - Reviewing Git bundle publication, download identity, or restart recovery
---

# Resumable Git update downloads

**Status: architecture proposal with a local protocol experiment.** The production
updater is unchanged. This proposes a separate download transport, building on
the existing update owners. It does not claim that ordinary `git fetch` now
resumes an interrupted pack.

## Problem and feasibility

A Git update can retry a failed fetch and reuse objects Git has already imported.
An interrupted pack still has to be transferred again. Retry limits and transfer
feedback are separate improvements, tracked in
[the download retry and progress PR](https://github.com/openclaw/openclaw/pull/184452).

True byte resume needs a fixed representation the client can request again by
offset. The current updater delegates the transfer to `git fetch`; it does not
own a stable download URL or a surviving partial-file path for that pack. A live
protocol-v2 capability read from `openclaw/openclaw` on October 27, 2026 advertised
`fetch=shallow wait-for-done filter`, without `packfile-uris` or `bundle-uri`.
This observation is server-specific and can change.

[Git bundle URIs](https://git-scm.com/docs/bundle-uri) separate object delivery
from reference negotiation, making a fixed bundle a suitable transport artifact.
Enabling that Git capability alone does not establish OpenClaw's partial-file,
restart, or validation contracts. A source archive also cannot replace the current
Git worktree and object-transfer flow while preserving commit identities and
history.

## Proposed first scope

Publish an immutable **incremental Git bundle** for an exact stable or beta
release, with explicitly selected prerequisite commits. Use it to populate the
existing private inspection repository before the normal target-resolution and
candidate-admission flow. Resume its download across network failures and update
process restarts.

The first implementation would support the official GitHub release authority.
Older releases without the artifact, missing prerequisites, custom remotes, and
development targets retain the existing Git transport. Those paths do not gain
byte resume. Supporting arbitrary development commits requires a producer that
publishes artifacts for those exact commits; a moving `main` URL is insufficient.

A full-history bundle must not be the assumed fallback. GitHub limits each
[release asset to less than 2 GiB](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).
Measure actual output, publication time, and client disk requirements before
choosing a baseline or partition strategy. Existing repository pack sizes do not
predict the size of a newly generated bundle.

## Ownership and integration

| Responsibility                                   | Existing owner and proposed integration                                                                                                                    |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Select the authoritative remote and fresh target | `src/infra/update-runner-git-target.ts`, inside `fetchGitUpdateTarget`; keep remote selection and cancellation semantics                                   |
| Retain the partial download                      | Stationary artifact storage supplied by `opts.gitArtifactStorageRoot ?? gitRoot` in `src/infra/update-runner-git.ts`; never the disposable inspection root |
| Verify and import downloaded objects             | The existing private inspection repository; verify bundle prerequisites and the selected reference before consumption                                      |
| Admit and transfer the candidate                 | Keep `prepareGitCandidateTransfer`, candidate validation, and `beforeGitMutation` in their current order                                                   |
| Publish source artifacts                         | `scripts/lib/release-publish-children.sh` and its caller in `.github/workflows/openclaw-release-publish.yml`                                               |

The download owner receives a pinned artifact descriptor, a caller-owned signal
and deadline, and exclusive access to its partial file. It reports bytes received
through the existing update progress path. It does not select versions, stop the
Gateway, admit candidate execution, or create a second update manager.

Release target discovery must precede the large transfer. Use the selected
remote's `ls-remote` results, retaining both annotated-tag object IDs and peeled
commit IDs. Do not interpret a release's `target_commitish` as the pinned commit:
GitHub can return a branch name such as `main`. Avoid downloading all release
tags before selecting the artifact, which would leave the original expensive
fetch ahead of the resumable path.

The bundle only supplies objects. It cannot override remote authority, change
the selected target, satisfy freshness using a stale local tag, or bypass the
existing inspection, admission, and rollback boundaries.

## Artifact identity and publication

Bind the descriptor to repository, target reference and object IDs, asset ID,
expected byte length, and SHA-256. GitHub's
[release asset metadata](https://docs.github.com/en/rest/releases/assets#get-a-release-asset)
supplies an asset ID, size, and digest. Reject unsupported or absent integrity
metadata instead of guessing it. A checksum fetched beside an arbitrary URL is
not an independent source of trust; the release authority and selected Git target
must still match.

The producer creates the incremental bundle from pinned Git object IDs, records
its actual prerequisite set, and verifies it before publication. A client with
those prerequisites must be able to import it and read the exact target tree.
A client without them must refuse bundle import and use the existing transport.
One declared baseline is not proof that every prerequisite is available.

Reuse the release owner's upload-or-verify behavior. Never overwrite an in-flight
download payload with `--clobber`. Repacking identical Git objects can change
bundle bytes: publication retries must reuse or validate the existing artifact,
rather than assume a fresh pack is byte-identical. Asset replacement produces a
new identity and a new partial-file path, even if its public filename is reused.

## Download and recovery contract

Key partial artifacts by the pinned content identity. The actual file length is
the resume offset; do not maintain a separate JSON byte counter. Read the length
only after obtaining the update owner's exclusive file custody. Additional durable
metadata, if needed, belongs to an existing SQLite owner and needs its schema
review. Scope paths to the installation and remote authority.

Request `Accept-Encoding: identity`; range offsets describe the stored
representation, so reject an encoded response before appending. For a retained
prefix of length `N`, request `Range: bytes=N-`:

| Response or local state                                | Required behavior                                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `206 Partial Content`                                  | Append only if `Content-Range` starts at `N` and matches the pinned total length and returned segment; reject multipart or malformed ranges |
| `200 OK` after a range request                         | Truncate and replace the prefix before writing the complete body                                                                            |
| `416 Range Not Satisfiable`                            | Never infer success from the status; verify an already-complete local file, otherwise reject or restart from zero                           |
| Local file already has the expected length             | Hash it first; a process may have died after the final write and before completion was recorded                                             |
| Interrupted network, cancellation, or process exit     | Retain the written prefix for a later invocation of the same artifact                                                                       |
| Wrong length, oversized response, or checksum mismatch | Refuse consumption; discard invalid data or explicitly restart it before retrying                                                           |

Verify the final length and whole-file digest, including the retained prefix,
before promoting the partial file. Then run Git's bundle prerequisite and object
integrity checks and confirm the selected target. Only verified data enters the
existing inspection repository. No downloaded candidate code executes before
the normal admission boundary.

An optimization failure can fall back to the existing Git transport with a
recorded diagnostic. Cancellation and an exhausted caller deadline must stop
work instead of starting another transport. A successful fallback must not be
reported as a resumed transfer.

Production integration must account for exclusive writers, symlink-safe opens,
disk exhaustion, retained-artifact limits and cleanup, and interrupted cleanup.
Reuse the update owner's custody and lifecycle. Define a bounded retention policy
before rollout; digest-keyed files alone would otherwise accumulate abandoned
downloads. Progress must distinguish retained bytes from newly received bytes.

## Runnable protocol experiment

From a source checkout with Node and Git:

```bash
node scripts/dev/resumable-git-bundle-proof.mjs
```

The command creates a synthetic repository, baseline, and incremental bundle;
starts a loopback HTTP fixture; and runs downloads in separate Node processes.
It exercises these observable boundaries:

- A network disconnect after 65,536 bytes, followed by a request for the actual
  retained offset.
- A `SIGKILL` after that prefix is written, followed by a fresh process resuming
  the same file.
- A server ignoring Range, malformed and unsatisfiable ranges, changed response
  bytes, encoded responses, and a complete file awaiting promotion.
- Git refusing the bundle without its prerequisites, then importing it after
  baseline hydration; exact target and payload checks and `git fsck --strict`.

It prints a JSON summary and removes its temporary fixture. It requires no
Gateway, account, credentials, model, or release publication. The worker accepts
only the parent's loopback HTTP fixture. It is an executable design experiment,
not a reusable production downloader: it does not exercise `openclaw update`,
real GitHub release redirects, production locking and retention, upgrade data
survival, or abrupt machine power loss. Its fixed fixture deadline is not a
proposal for the updater's timeout policy.

## Decisions before implementation and rollout

1. Select supported baseline versions, the incremental span, size limits, and
   fallback behavior after measuring real producer and client costs.
2. Agree on artifact publication, identity, availability, and retention under the
   release owner, including immutable payload behavior on publication retries.
3. Implement fresh target discovery and private-repository hydration together,
   plus durable partial-file custody and bounded cleanup in the update owner.
4. Prove the actual update path with interrupted HTTP delivery, a killed updater,
   unavailable prerequisites, and an upgrade from the supported stable baseline.
   Verify cancellation, data survival, candidate admission, and rollback.

The protocol experiment establishes that the byte-transfer mechanism works. The
production feature is complete only when a published artifact and the installed
updater use the same contract end to end.
