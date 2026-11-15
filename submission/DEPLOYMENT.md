# Caption-only Vultr deployment

This guide deploys the current caption-to-Avatar product. It does not enable generated video or a paid translation API.

## Provisioning

Create one deployable NVIDIA Cloud GPU instance with an Ubuntu GPU-enabled image. The last user-visible A16 16 GB plan was quoted at approximately $0.47/hour; availability, exact cost and credit eligibility must be checked in the account. A16 is unbenchmarked for this project and is not promised to outperform the local GPU. The live account currently has a Max Instance Cost limit of $200/month, below the previously selected GPU plan's quoted monthly price. Request a sufficient instance-cost limit before provisioning; a limit increase is not a credit top-up or a spending cap.

Use a public IPv4 address, SSH access and a domain with its DNS A record pointing to that IP. Allow TCP 22 for management and 80/443 for HTTPS. Keep port 4318 private. On the server, verify:

```bash
nvidia-smi
docker compose version
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
```

Compose must be 2.30+. Both GPU checks must work before model download. Use the official [Docker](https://docs.docker.com/engine/install/ubuntu/) and [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) guides if missing. Do not bypass certificate errors or change provider-managed vGPU drivers by guessing.

## Upload

Upload the sanitized `sign-companion-source.zip` or clone [the public repository](https://github.com/TJY-6666/youtube-sign-companion). Do not copy `.env.local`, `.env.motion.local`, `connection.local.json`, browser profiles or private models. Extract it under `/opt/sign-companion`, then:

```bash
cd /opt/sign-companion/deploy
cp .env.caption.example .env
openssl rand -hex 32
nano .env
```

Set the real `DOMAIN`, use the newly generated `APP_TOKEN`, and set `MOTION_POSE_PROFILE=experimental-inverse`. This profile is explicitly unverified. Keep the token private and run `chmod 600 .env`.

## Build, check precision, download and start

Run each command only after the previous one succeeds:

```bash
docker compose -f compose.caption.yaml build
docker compose -f compose.caption.yaml run --rm --no-deps -T app python3 - < check-gpu.py > gpu-settings.env
cat gpu-settings.env
cat gpu-settings.env >> .env
docker compose -f compose.caption.yaml run --rm --no-deps app python3 motion/download.py --accept-large-download
docker compose -f compose.caption.yaml up -d
docker compose -f compose.caption.yaml ps
docker compose -f compose.caption.yaml logs --tail=100 app
docker compose -f compose.caption.yaml logs --tail=50 https
```

The probe tests a small actual CUDA multiplication and chooses BF16 only if the device can execute it. FP32 fallback needs more memory and may be slower. A package's total GPU memory is not assumed to be available to a single device; current inference uses GPU 0.

Weights persist under `deploy/models/`. No model is silently downloaded when the app starts. The initial build downloads the runtime; the explicit setup command downloads roughly 7.3 GB of model weights plus tokenizer files.

## Verify actual cloud operation

Visit `https://YOUR_DOMAIN/api/health`. Require `motionReady: true`. `transcriptionReady: false`, `framegenConfigured: false` and `generationEnabled: false` are expected for this caption-only container.

Open `https://YOUR_DOMAIN/demo.html`, enter the app token and a sentence, give consent and verify a real result. Install the Chrome extension from that page, set the same HTTPS backend and token, refresh YouTube and test English captions. Record a short cloud demonstration showing the public URL, the generated response and the Vultr instance page with credentials hidden. Then test from another computer without using the developer computer's local service.

Keep this evidence separate from local fixtures. Update the architecture's cloud status only after this check succeeds. Do not submit an unavailable URL as a working demo or describe model output as verified ASL.

## Stop and billing

Stopping containers or powering off a Vultr instance does not necessarily stop instance charges. Back up needed artifacts and destroy the instance when finished; separately check independent storage, snapshots and other resources. Follow [Vultr's billing rules](https://docs.vultr.com/support/platform/billing/how-am-i-billed-for-my-servers). No fixed cost ceiling or unattended shutdown is implemented by this recipe.
