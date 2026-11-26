# SENTINEL 8.0 — report

## Outcome

8.0 did the thing the brief puts first: **fixed existing defects before adding
features**. The training lab no longer leaks its test fold, no longer calls a
queue-status change "cancellation", and no longer restarts GPT training from
scratch while claiming continuation. The tool audit grew from 388 to 530 real
executions. Version, acceptance gate and ledger are at 8.0.0.

The large targets were **not** reached and are not claimed:

| Measure | Current | Target |
|---|---:|---:|
| First-party lines | 78,446 | >1,000,000 |
| Tools / categories | 689 / 35 | 2,000 / 80+ |
| Executed tools | 530 | all feasible |
| Agents | 123 | 250+ |
| Checks | 1,830 | 10,000+ |

A 78k-line codebase cannot be turned into a 1M-line codebase in one slice
without exactly the filler the brief forbids. The remaining requirements are
listed by name in `docs/REQUIREMENTS-8.0.md` and are the resumable backlog.

## Defects found and fixed

1. **Group leakage in dataset splitting.** A random row split let the same text
   appear in train and test. Splits are now group-aware; tests assert zero group
   overlap across all three folds.
2. **Validation/test conflation.** LoRA/QLoRA used one fold for model selection
   *and* the reported score; HPO selected on the test fold. There are now three
   disjoint folds; selection uses validation, evaluation reads test once.
3. **No label-mapping validation.** Source and target datasets with different
   labels were combined by index. Now `LABEL_MISMATCH`.
4. **Cancellation did not interrupt computation.** The queue aborted a signal
   that the synchronous training loop never observed. Queue runners are now
   async and yield per epoch; measured cancellation 15–25 ms on a 5,000-epoch
   job.
5. **`runGptJob` retrained from scratch.** Each "block" built a new model. It
   now restores weights, vocabulary, Adam `m`/`v`, step count, learning rate and
   epoch counter, and saves every epoch.
6. **Arbitrary checkpoint reads.** `generateGpt(checkpointPath)` would read any
   file. Reads are confined to `<dataDir>/gpt`; traversal is refused.
7. **Two laboratory entry points.** `core/lab.js` and `core/lab/index.js` had
   separate implementations. The legacy code moved to `core/lab/classic.js`,
   `core/lab.js` is a shim, and both classes export from one facade.
8. **GPT sampling lacked top-p and repetition controls.** Both implemented and
   tested.

## Tool audit

The audit now writes six fixture files into a temporary workspace and executes
530 real calls. 159 tools stay unexecuted because they write files, launch or
kill processes, make calls/SMS, require network or Windows, or would run a long
training job. They are reported as unexecuted, and the acceptance gate fails if
an attempted call fails.

## Measured verification

```
run 23 · ui 48/48 · ai 25 · deep 160 · properties 5
toolpacks 1,510 · agents 7 · training 23 · executive 15 · coding 14
total 1,830 checks, 0 failures
repository self-index: 217 files, 3,044 symbols, 0 parse errors
tool audit: 530/530 attempted, 0 structural problems
```

`node scripts/acceptance-8.0.js` reproduces this and writes
`docs/ledger-8.0.json`. `node scripts/check.js` passes.

## What 8.0 still needs

The next honest milestones, in order:

1. Complete the original 2,000-check target with distinct cases (not repeated
   assertions), starting with writable-tool sandbox fixtures and security
   negatives.
2. Finish the tool audit for the 159 remaining tools using isolated sandboxes
   and mock providers, then expand tool count with genuinely new capabilities.
3. Continue the lab work: production-compatible training behind an optional
   external runtime, contamination checks, adapter inference in the assistant.
4. Model router and capability measurement using real configured providers on
   the target machine; no invented GPU numbers.
5. Agent expansion to 250 with distinct contracts, real tools and measured
   collaboration tasks.
6. Memory 3.0, research document formats, executive 2.0, desktop and telephony
   work — each requiring its own authorization and provider setup.

## Repository state

Branch `arena/15fbea48-sentinel`, PR #1 open and unmerged. Source-only: no EXE,
APK, firmware or binary packaging was produced. CI status is reported in the
session only after it runs.
