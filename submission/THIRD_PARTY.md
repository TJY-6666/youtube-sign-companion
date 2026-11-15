# Third-party components and assets

| Component | Source | Use and licensing boundary |
|---|---|---|
| RoboSTAR | https://github.com/zyjOrz/RoboSTAR at `2371ba3e7cdd57242b4a96709a977eabc298e940` | Apache-2.0 source; fetched during setup. Upstream license is also included in `licenses/RoboSTAR-APACHE-2.0.txt`. Model weights have separate terms. |
| RoboSTAR weights | https://huggingface.co/Ivystream/RoboSTAR at `bf0ed2f3bf43b8a1d9def85ca8ab51bef5a10b06` | Explicit setup download; not included in the release. The downloaded model card declares `license: other` without an explicit grant in its text. Model-service rights remain unresolved; this is not an open-license claim. |
| mT5 tokenizer | https://huggingface.co/google/mt5-large | Tokenizer/config files only; downloaded during setup. |
| Three.js | https://github.com/mrdoob/three.js | MIT. Bundled runtime license at `extension/avatar/vendor/LICENSE`. |
| WebXR generic hand assets | https://github.com/immersive-web/webxr-input-profiles/tree/f4992299601614adbfefd398dc8e281556bb7444/packages/assets/profiles/generic-hand | MIT; copyright 2019 Amazon. License and provenance accompany the original left/right GLBs. Runtime adapts motion to these meshes; this is not exact SMPL-X skinning. |
| PyTorch | https://pytorch.org/ | Runtime installed separately; upstream notices apply. |
| Playwright | https://playwright.dev/ | Apache-2.0. Used for controlled browser checks and local recordings. |
| Caddy | https://caddyserver.com/ | Apache-2.0. HTTPS reverse proxy for the target deployment. |
| NVIDIA CUDA image | https://hub.docker.com/r/nvidia/cuda | Vendor image and NVIDIA terms apply; fetched during image build. |

Private SMPL-X reference files are excluded from the release. Historical Signapse results, teacher-capture motion, video-specific demos, caption-phrase catalogs, downloaded YouTube videos and generation experiments are not part of the current public viewer or submission evidence. A technical running result is not a linguistic endorsement by any model or asset author.

Original project source is provided for inspection. No blanket license is asserted over third-party models or data. Review usage and redistribution terms before public or commercial deployment.
