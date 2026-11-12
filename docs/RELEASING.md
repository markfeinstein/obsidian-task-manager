# Maintainer release process

This project uses one artifact pipeline and two explicit publication stages. Both stages run the full quality, platform, benchmark, package, checksum, and provenance-attestation gates. The stage changes only the external evidence required before the tested tag artifact may be published.

## Required repository configuration

Configure the GitHub `release` environment and set the repository variable `OBSIDIAN_RELEASE_STAGE` before pushing a release tag. The only accepted values are:

- `initial-submission` — create the first public GitHub release needed for an Obsidian Community Plugins submission, or publish a correction while that submission is pending.
- `ga` — publish after the plugin is listed, using current independently reviewed real-host evidence.

A missing or unknown value fails the tag workflow closed. Do not infer the stage from the tag, repository visibility, or the presence of a secret.

Store the owner configuration in the `OWNER_RELEASE_CONFIG_JSON` Actions secret. It must use real owner-controlled HTTPS endpoints that match `package.json` and the current `manifest.json` plugin ID.

## Initial-submission releases

For `OBSIDIAN_RELEASE_STAGE=initial-submission`, set `communityPlugins.status` in the owner configuration to:

- `unlisted` before the submission pull request exists; or
- `submitted` after submission, with `communityPlugins.submissionUrl` set to the HTTPS pull-request URL.

The workflow runs `npm run check:initial-release`. It requires the owner configuration but deliberately does not require `GA_EVIDENCE_JSON` or proof of an existing Community Plugins listing. This breaks the otherwise circular dependency in which the first GitHub release requires a listing that itself requires the release.

This stage does not bypass source, test, packaging, checksum, version, benchmark, or attestation checks. A bare version tag must still match `manifest.json` exactly, for example `0.1.0` rather than `v0.1.0`.

## GA releases

After the plugin is present in the official registry:

1. Set `OBSIDIAN_RELEASE_STAGE=ga`.
2. Set `communityPlugins.status` to `listed`.
3. Set `communityPlugins.upstreamCommitUrl` to immutable registry evidence for the current plugin ID.
4. Configure `GA_EVIDENCE_JSON` with digest-bound, current, independently reviewed real-host observations.

The workflow then runs `npm run check:ga-evidence`. GA publication remains blocked if owner metadata, registry evidence, source identity, observation age, reviewer independence, or required environments do not validate.

## Tag and artifact flow

1. Verify the working tree and generated assets are clean.
2. Run the release checks with the pinned Node/npm toolchain.
3. Push a bare version tag matching `manifest.json`.
4. Let CI build one candidate, validate it, upload it, and attest the exact files.
5. The publish job downloads that same artifact, verifies its source revision and checksums, and creates the GitHub release.

Do not upload an older local `release/` directory or rebuild between validation and publication.
