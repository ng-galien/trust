# Build the TRUST server image

Run from the repository root:

```sh
docker build -f charts/trust/container/Dockerfile \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" -t trust-server:0.1.0 .
```

The Dockerfile-specific `Dockerfile.dockerignore` restricts the root build context to required workspace sources and assets. It excludes local databases, credentials, environment files, build output and node_modules. Docker documents this supported [per-Dockerfile ignore mechanism](https://docs.docker.com/build/concepts/context/). Inspect the context rules whenever adding a required build input.

The build installs locked dependencies, compiles runtime/SDK/shell, builds the browser UI and all three shipped extension bundles, packages documentation and the Runner, then prunes development dependencies. The image preserves the installation layout required by `resolveTrustInstallation`, including Runner scripts and skill sources. Git and CA certificates support the existing Git registry synchronization boundary; domain-specific Runner tools are not silently installed. It does not preinstall extension registry configuration or provider accounts. The development issuer is not a production dependency. The source revision label identifies Git HEAD; local changes require the separately recorded source manifest and do not become committed merely because an image is built.

The default base is the maintained [official Node 24 Debian slim image](https://github.com/nodejs/docker-node). For a reviewed release, set `--build-arg NODE_IMAGE=node:24-bookworm-slim@sha256:<verified-digest>` and record the resolved base digest and build revision. Pin the produced image digest in Helm values. This repository supplies an image recipe, not a public registry release.

Run with a mounted canonical configuration selected by `TRUST_CONFIG_FILE`, a writable `/var/lib/trust` volume and `/tmp`, and existing credential references. The shell starts both runtime and web processes and forwards termination for graceful database ownership release. The image runs as the existing `node` user, UID 1000; it requires no privileged container or Docker socket. It listens on the configured browser port (4173 by default). Only the browser port needs to be published.

Builds and disposable smoke tests must not mount the owner's retained databases or use retained cluster contexts. External publication and deployment require their own explicit authorization.
