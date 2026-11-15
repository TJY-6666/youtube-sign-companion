# Vultr Community project fields

Use only verified URLs. Replace the three pending link fields before final submission; do not paste them as working links.

## Project name
YouTube Sign Companion

## Short description
A YouTube caption-to-ASL Avatar prototype with synchronized playback, caption lookahead and a source-to-output comparison panel. Accuracy validation is in progress.

## Event and track
HackGlobal 2026 — Multimodal and accessibility

## Industry / domain
Accessibility, educational video, assistive technology research

## Overview
Sign Companion explores an additional signed viewing layer for people who use sign language while watching English YouTube videos. The viewer keeps the original video and captions, opens a companion panel and explicitly starts caption processing. No video upload is required.

The extension attempts to read timed English captions on page entry. After consent, it prepares upcoming segments using a resident RoboSTAR model and sends the motion to a Three.js Avatar. Prepared results wait for the video's playback clock; pause and seek are respected, and missing current motion can trigger buffering. If the full track is unavailable, the prototype reads visible English CC. The current viewer never switches to audio capture.

The panel shows the source captions, the sentence associated with the displayed motion, processing state and input provenance. A separate authenticated web workspace lets reviewers test a short sentence with the same real model pipeline.

Prototype limitation: current output has significant pose and handshape errors. ASL meaning and facial grammar require further work and review with fluent signers; the local integration checks establish the viewing workflow, not translation accuracy.

## Technology stack
Chrome Manifest V3; JavaScript; Node.js HTTP API; Python; PyTorch; pretrained RoboSTAR; Three.js/WebGL; skinned WebXR hand assets; Docker Compose; Caddy HTTPS; target hosting on Vultr Compute with an NVIDIA GPU.

## System design
Attach `architecture.svg` and the current workspace / extension screenshots. State that the cloud boundary is planned until deployment has been independently verified.

## How Vultr is used
Planned: Vultr Compute hosts the authenticated Node backend and resident GPU motion model, with Caddy providing HTTPS. The browser renders the Avatar. At package preparation time, cloud execution is not yet verified. Replace this paragraph with the actual instance type and verified behavior after deployment; a $200 credit balance alone is not deployment evidence.

## Links — pending external work
- Public GitHub repository: not yet published / verified.
- Public live demo URL: not yet deployed / verified.
- Recorded demo URL: local recording prepared separately; hosted link pending.

## Validation and impact
Describe the local checks in `VALIDATION.md` and preserve their scope. No user adoption, international reach, translation-accuracy percentage or market-size number has been measured. Do not invent these results.

## Contributor
Tan Jun Yong — solo builder, Universiti Malaya. Confirm the exact Vultr Community profile in the form. Do not include a contact email in the public description unless intentionally chosen by the participant.

## Tags
Hackathons; Accessibility; AI; Three.js; PyTorch; Chrome Extension. Under “Build for an event?” select HackGlobal 2026.

## Submission condition
The organizer guide gives a 15 November 2026 12:00 IST deadline (14:30 Malaysia/Singapore) and says late submissions are not accepted. The normal deadline has passed; no exception or extension has been verified. A saved HackCulture prototype is not the final Vultr Community submission. Confirm eligibility with the organizer before representing this package as an accepted competition entry.
