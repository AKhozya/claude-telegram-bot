FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
# BUILD_TS busts this layer each scheduled rebuild. bun update, not install:
# install pins to bun.lock and rebuilds refresh nothing (froze SDK at 0.2.119).
# bunfig.toml = minimumReleaseAge supply-chain gate.
ARG BUILD_TS=local
COPY package.json bun.lock* bunfig.toml ./
RUN echo "build: $BUILD_TS" && bun update

# whisper.cpp and its model. Both live in this stage because it declares no BUILD_TS: the
# runtime stage below does, and a declared ARG joins the cache key of every RUN after it, so
# a scheduled rebuild there re-downloads the 148 MB model. Here they survive the rebuild and
# arrive by COPY.
# Built static so the runtime image needs no libstdc++/libgomp and the toolchain never lands
# in it. OpenMP is off because static libgomp on musl is the usual failure; ggml's own thread
# pool covers it.
FROM oven/bun:1.3-alpine AS whisper
# A git tag is mutable. The commit it pointed at when this was pinned is checked below, so a
# moved tag fails the build instead of silently changing the binary — matching how kubectl,
# flux and the model are all checksum-verified.
# The expected commit is literal, not an ARG: an expected hash that --build-arg can replace
# is not a pin, it just moves both sides of the comparison. The tag stays overridable because
# a mismatch then fails here.
ARG WHISPER_VERSION=v1.9.1
RUN apk add --no-cache cmake g++ make git curl \
    && git clone --depth 1 --branch "${WHISPER_VERSION}" \
         https://github.com/ggml-org/whisper.cpp /tmp/whisper.cpp \
    && cd /tmp/whisper.cpp \
    && commit="$(git rev-parse --verify 'HEAD^{commit}')" \
    && test "${commit}" = "f049fff95a089aa9969deb009cdd4892b3e74916" \
    && cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
         -DWHISPER_BUILD_TESTS=OFF -DGGML_OPENMP=OFF \
         -DCMAKE_EXE_LINKER_FLAGS=-static \
    && cmake --build build -j"$(nproc)" --config Release \
    && ! ldd build/bin/whisper-cli 2>&1 | grep -q "=>"

# Multilingual base model — the English-only variant silently forces English output. Pinned
# to a HuggingFace revision rather than `main` so a scheduled rebuild cannot pick up a
# different file, and checksum-verified like kubectl and flux below.
# The checksum is literal for the same reason as the commit above.
ARG WHISPER_MODEL_REV=5359861c739e955e79d9a303bcbc70fb988958b1
RUN mkdir -p /out/whisper \
    && curl -fsSL "https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODEL_REV}/ggml-base.bin" \
         -o /out/whisper/ggml-base.bin \
    && echo "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe  /out/whisper/ggml-base.bin" \
       | sha256sum -c -

FROM oven/bun:1.3-alpine

ARG BUILD_TS=local

# System dependencies. poppler-utils = pdftotext (text layer) + pdftocairo
# (page->PNG render for image/scanned/print PDFs, read via Claude vision).
# unzip = Info-ZIP (supports `unzip -Z1` member listing); BusyBox's applet does not,
# so zip archives need this to be listed/validated and extracted in the container.
# bubblewrap + socat = the Linux Bash sandbox deps (bwrap = filesystem/process isolation,
# socat = its network proxy). With the sandbox's failIfUnavailable, a missing dep makes the
# bot fail-closed (won't run) rather than execute Bash unconfined.
# github-cli = gh. nodejs + npm = runtime plugin hooks / MCP servers — no CLI install,
# the Agent SDK vendors the engine binary in its platform package (…-linux-x64-musl).
# chezmoi = dotfile/skills sync (init container uses same image).
# ffmpeg = audio extraction for transcription. whisper.cpp cannot read Telegram's opus, and
# fails silently rather than erroring, so this is a hard dependency of that feature.
# apk deliberately unpinned: alpine drops old package versions from the index, and the
# pinned base image + bi-weekly rebuild keep these fresh.
RUN apk add --no-cache git openssh-client curl jq ca-certificates bash poppler-utils unzip \
    bubblewrap socat github-cli nodejs npm chezmoi ffmpeg

# kubectl (pinned — match cluster k3s version; bump deliberately). Checksum-verified.
ARG KUBECTL_VERSION=v1.36.2
RUN curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
      -o /usr/local/bin/kubectl \
    && echo "$(curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl.sha256")  /usr/local/bin/kubectl" | sha256sum -c - \
    && chmod +x /usr/local/bin/kubectl

# flux CLI (pinned — match cluster flux minor; bump deliberately). Checksum-verified.
ARG FLUX_VERSION=2.9.3
RUN set -o pipefail && cd /tmp \
    && curl -fsSLO "https://github.com/fluxcd/flux2/releases/download/v${FLUX_VERSION}/flux_${FLUX_VERSION}_linux_amd64.tar.gz" \
    && curl -fsSLO "https://github.com/fluxcd/flux2/releases/download/v${FLUX_VERSION}/flux_${FLUX_VERSION}_checksums.txt" \
    && grep " flux_${FLUX_VERSION}_linux_amd64.tar.gz\$" "flux_${FLUX_VERSION}_checksums.txt" | sha256sum -c - \
    && tar -xzf "flux_${FLUX_VERSION}_linux_amd64.tar.gz" -C /usr/local/bin flux \
    && rm -f "flux_${FLUX_VERSION}_linux_amd64.tar.gz" "flux_${FLUX_VERSION}_checksums.txt"

COPY --from=whisper /tmp/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper /out/whisper/ggml-base.bin /usr/local/share/whisper/ggml-base.bin

# Codex CLI (pre-commit review gate). The linux-x64 platform dep ships codex's
# static musl binary (codex publishes musl-only for linux) — alpine-safe.
# Installs to /usr/bin, outside the /home/akhozya PVC shadow.
# Latest on each scheduled rebuild (BUILD_TS busts the layer). Trusted publisher —
# no release-age gate, matching the Anthropic-SDK exemption in bunfig.toml.
RUN echo "codex refresh: ${BUILD_TS}" \
    && npm install -g @openai/codex@latest \
    && codex --version

# oven/bun:alpine already has UID 1000 as 'bun' user.
# Create akhozya as alias + home dir for K8s securityContext (runAsUser: 1000).
# Must precede the COPYs below — --chown resolves the name from /etc/passwd.
RUN deluser bun && adduser -D -u 1000 -h /home/akhozya akhozya

WORKDIR /app
# --chown on each COPY, not a trailing `chown -R /app`: recursive chown rewrites
# every inode into a new layer, duplicating node_modules (+744MB measured).
RUN chown akhozya:akhozya /app
COPY --from=deps --chown=akhozya:akhozya /app/node_modules ./node_modules
COPY --chown=akhozya:akhozya . .

USER akhozya

CMD ["bun", "run", "src/index.ts"]
