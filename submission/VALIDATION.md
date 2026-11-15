# Validation evidence — 15 November 2026

These results establish local integration, request boundaries and playback behavior. They do not establish correct ASL, reliable live YouTube compatibility, public hosting or competition acceptance.

## Automated checks

- Working workspace: `npm test` passed 96 Node tests, including historical tests retained outside the public release.
- Motion Python: 11 tests passed for hand-pose conversion, streamed checkpoint loading and prompt handling. An initial concurrent run hit Windows paging-file exhaustion; a sequential rerun passed without restarting the resident model.
- GPU precision probe: two unit tests cover successful BF16, unsupported/failed BF16 fallback and missing/broken CUDA. The selected cloud GPU has not been tested.
- Public workspace: `scripts/submission-browser-check.mjs` passed real model inference, token rejection before inference, consent gating, text bounds, WebGL playback, pause/replay without new inference, sanitized extension download, unready-model behavior and no horizontal overflow at 1440/768/390 pixels.
- Timed-caption extension: `scripts/timed-caption-browser-check.mjs` passed a real MV3 MAIN-world caption bridge with a synthetic timed-text/video source, the resident model and real Avatar. It checks fetching before opening the panel, preparing future segments while paused, timestamp-based display, pause, seek, stop, replay and input provenance. A race discovered in the native-response path was fixed: a complete track arriving during the initial Start request now waits for startup to settle before switching modes. Both direct-file and native-response checks passed after the fix. This is a controlled integration check, not a live YouTube availability claim.

The three recorded workspace requests took 0.786, 0.875 and 0.693 seconds according to the worker response, each returning 32 frames at 20 FPS. These are short local requests. They are not a cloud benchmark, end-to-end viewing-latency guarantee or whole-video translation result. All returned `accuracyReviewed: false` and `poseProfile: experimental-inverse`.

## Visual and media checks

- Desktop, tablet and mobile screenshots were captured and inspected. Mobile consent-text overflow was corrected.
- Source-style lint reported no failures or warnings. Rendered inspection reported no failures and one visual warning about unused space under the Avatar panel; the fixed-height stage keeps the hands at a consistent viewing scale. This is a cosmetic limitation.
- The recording uses actual local model requests and has a visible local/cloud/ASL status notice. The model-unavailable health state is deliberately simulated only for its separate failure screenshot.
- MP4 conversion was fully decoded: 608 frames, 25 FPS, 24.32 seconds, 1440 × 1000, no audio. The original recording's timing is retained. Suggested narration is in `DEMO-SCRIPT.md`.

## Release boundary

The public source package omits historical teacher-derived demo/phrase data and the tests that require those data. The isolated public release passed its own 88 Node tests, with the eight historical data-dependent tests excluded. API, caption, queue and renderer tests remain included. Model weights, private SMPL-X files, account credentials, participant emails, browser profiles, downloaded YouTube footage and Signapse output are excluded. SHA-256 checks and an actual local-secret scan are performed before publication.

## Not yet verified

- A build or inference run on Vultr, selected A16 compatibility/performance, public HTTPS operation and access from an independent device.
- Fluent-ASL-user comprehension, accurate handshapes, facial grammar, source pose conventions and arbitrary long-video coverage.
- Real user reach, usage counts, adoption, market size or an accepted late competition entry.

The live Vultr account displayed $200 remaining credit, zero instances, a maximum of five instances and **Max Instance Cost: $200/month**. This prevents creating the previously selected A16 GPU plan at its quoted monthly rate. No instance or limit-change request was submitted by this work.
