#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { computeSourceIdentity, sourceRevision } from './source-identity.mjs';

const RESERVED_HOST = /(?:^|\.)(?:example|invalid|localhost|test)(?:\.|$)/iu;
const SYNTHETIC = /(?:node(?:\.js)?|jsdom|fakedom|synthetic|mock|fixture)/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT_URL = /\/commit\/[0-9a-f]{40}(?:$|[/?])/iu;
const PULL_REQUEST_URL = /\/pull\/\d+(?:$|[/?])/u;
const RELEASE_STAGES = ['initial-submission', 'ga'];
const INITIAL_SUBMISSION_STATUSES = ['unlisted', 'submitted'];

function validHttpsUrl(value, allowTestValues = false) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
      && (allowTestValues || !RESERVED_HOST.test(url.hostname));
  } catch { return false; }
}

function immutableEvidenceUrl(value, allowTestValues) {
  if (!validHttpsUrl(value, allowTestValues)) return false;
  const url = new URL(value);
  if (/\b(?:latest|main|master|head)\b/iu.test(url.pathname) || url.search) return false;
  return /\/actions\/runs\/\d+(?:\/|$)/u.test(url.pathname)
    || /\/artifacts\/\d+(?:\/|$)/u.test(url.pathname)
    || /\/releases\/download\/v?\d[^/]*\//u.test(url.pathname)
    || /\/(?:commit|blob)\/[0-9a-f]{40}(?:\/|$)/iu.test(url.pathname);
}

function isoTime(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) && Number.isFinite(Date.parse(value));
}

function validateRecord(record, label, schema, errors, { allowTestValues, nowMs }) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    errors.push(`${label} evidence is missing`);
    return;
  }
  for (const field of schema.recordFields) if (!(field in record)) errors.push(`${label}.${field} is required`);
  if (!schema.allowedStatus.includes(record.status)) errors.push(`${label}.status must be passed`);
  if (!isoTime(record.observedAt)) errors.push(`${label}.observedAt must be an ISO UTC timestamp`);
  if (!immutableEvidenceUrl(record.artifactUrl, allowTestValues)) errors.push(`${label}.artifactUrl must be an immutable HTTPS run/artifact/commit/release URL`);
  if (!SHA256.test(record.artifactSha256 ?? '')) errors.push(`${label}.artifactSha256 must be a 64-character lowercase SHA-256`);
  if (typeof record.notes !== 'string' || !record.notes.trim() || /(?:fake|placeholder|todo|not tested)/iu.test(record.notes)) errors.push(`${label}.notes must be retained evidence without placeholder language`);

  const observedMs = Date.parse(record.observedAt);
  if (Number.isFinite(observedMs)) {
    if (observedMs > nowMs) errors.push(`${label}.observedAt cannot be in the future`);
    const maximumAgeMs = schema.maximumAgeDays * 86_400_000;
    if (nowMs - observedMs > maximumAgeMs) errors.push(`${label}.observedAt is older than ${schema.maximumAgeDays} days`);
  }
  const tester = record.tester;
  if (!tester || typeof tester !== 'object' || typeof tester.id !== 'string' || !tester.id.trim()) errors.push(`${label}.tester.id is required`);
  const reviewer = record.reviewer;
  if (!reviewer || typeof reviewer !== 'object' || typeof reviewer.id !== 'string' || !reviewer.id.trim() || !isoTime(reviewer.approvedAt)) {
    errors.push(`${label}.reviewer.id and reviewer.approvedAt are required`);
  } else {
    if (tester?.id === reviewer.id) errors.push(`${label} requires an independent reviewer`);
    const approvedMs = Date.parse(reviewer.approvedAt);
    if (approvedMs > nowMs) errors.push(`${label}.reviewer.approvedAt cannot be in the future`);
    if (Number.isFinite(observedMs) && approvedMs < observedMs) errors.push(`${label}.reviewer.approvedAt cannot precede observation`);
  }
  const environment = record.environment;
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) errors.push(`${label}.environment must be structured`);
  else {
    for (const field of schema.environmentFields) if (typeof environment[field] !== 'string' || !environment[field].trim()) errors.push(`${label}.environment.${field} is required`);
    if (SYNTHETIC.test(JSON.stringify(environment))) errors.push(`${label}.environment must identify a real host/device/provider/AT, not a synthetic runtime`);
  }
}

function configuredUrl(value) {
  return typeof value === 'string' ? value.replace(/\/$/u, '') : '';
}

export function validateOwnerReleaseConfig(config, {
  packageJson,
  pluginId,
  releaseStage = 'ga',
  allowTestValues = false,
} = {}) {
  const errors = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) return ['owner release configuration is missing'];
  if (config.schemaVersion !== 1) errors.push('owner config schemaVersion must be 1');
  if (!RELEASE_STAGES.includes(releaseStage)) errors.push(`release stage must be one of: ${RELEASE_STAGES.join(', ')}`);
  for (const field of ['repositoryUrl', 'homepageUrl', 'releaseBaseUrl', 'supportUrl']) {
    if (!validHttpsUrl(config[field], allowTestValues)) errors.push(`owner config ${field} must be an owner-controlled HTTPS URL`);
  }

  const communityPlugins = config.communityPlugins;
  if (!communityPlugins || typeof communityPlugins !== 'object' || Array.isArray(communityPlugins)) {
    errors.push('Community Plugins configuration is missing');
  } else {
    if (communityPlugins.pluginId !== pluginId) errors.push('Community Plugins pluginId must match the manifest');
    if (releaseStage === 'initial-submission') {
      if (!INITIAL_SUBMISSION_STATUSES.includes(communityPlugins.status)) {
        errors.push('Community Plugins status must be unlisted or submitted for an initial-submission release');
      }
      if (communityPlugins.status === 'submitted'
        && (!validHttpsUrl(communityPlugins.submissionUrl, allowTestValues) || !PULL_REQUEST_URL.test(communityPlugins.submissionUrl ?? ''))) {
        errors.push('Submitted Community Plugins status requires an HTTPS pull-request URL');
      }
    } else if (releaseStage === 'ga') {
      if (communityPlugins.status !== 'listed') errors.push('Community Plugins status must be listed for a GA release');
      if (!validHttpsUrl(communityPlugins.upstreamCommitUrl, allowTestValues) || !COMMIT_URL.test(communityPlugins.upstreamCommitUrl ?? '')
        || !(communityPlugins.upstreamCommitUrl ?? '').includes(pluginId ?? '')) errors.push('Community Plugins evidence must be an immutable upstream commit URL containing the plugin ID');
    }
  }

  if (packageJson) {
    const repository = typeof packageJson.repository === 'string' ? packageJson.repository : packageJson.repository?.url;
    const bugs = typeof packageJson.bugs === 'string' ? packageJson.bugs : packageJson.bugs?.url;
    if (configuredUrl(repository) !== configuredUrl(config.repositoryUrl)) errors.push('package.repository must match owner config repositoryUrl');
    if (configuredUrl(packageJson.homepage) !== configuredUrl(config.homepageUrl)) errors.push('package.homepage must match owner config homepageUrl');
    if (configuredUrl(bugs) !== configuredUrl(config.supportUrl)) errors.push('package.bugs must match owner config supportUrl');
  }
  return errors;
}

export function validateGaEvidence(evidence, {
  expectedRevision,
  expectedDigest,
  schema,
  ownerConfig,
  packageJson,
  pluginId,
  allowTestValues = false,
  now = new Date(),
} = {}) {
  const errors = validateOwnerReleaseConfig(ownerConfig, { packageJson, pluginId, allowTestValues });
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return [...errors, 'GA evidence must be a JSON object'];
  if (evidence.schemaVersion !== schema.schemaVersion) errors.push(`schemaVersion must be ${schema.schemaVersion}`);
  if (evidence.sourceRevision !== expectedRevision) errors.push('sourceRevision must exactly match the release commit');
  if (evidence.sourceContentSha256 !== expectedDigest) errors.push('sourceContentSha256 must exactly match the release source identity');
  const options = { allowTestValues, nowMs: now.getTime() };
  for (const key of schema.requiredPlatforms) validateRecord(evidence.platforms?.[key], `platforms.${key}`, schema, errors, options);
  for (const key of schema.requiredInstallation) validateRecord(evidence.installation?.[key], `installation.${key}`, schema, errors, options);
  for (const key of schema.requiredAccessibility) validateRecord(evidence.accessibility?.[key], `accessibility.${key}`, schema, errors, options);
  for (const key of schema.requiredProviders) validateRecord(evidence.providers?.[key], `providers.${key}`, schema, errors, options);
  for (const key of schema.requiredVisualInteraction) validateRecord(evidence.visualInteraction?.[key], `visualInteraction.${key}`, schema, errors, options);
  return errors;
}

function parseInput(inline, file, label) {
  if (!inline && !existsSync(file)) return { error: `${label} is absent: ${file}` };
  try { return { value: JSON.parse(inline ?? readFileSync(file, 'utf8')) }; }
  catch (error) { return { error: `${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}` }; }
}

async function cli() {
  const root = process.cwd();
  const args = process.argv.slice(2);
  const unknownArgs = args.filter((arg) => arg !== '--initial-submission');
  if (unknownArgs.length > 0) {
    console.error(`Unknown release evidence option: ${unknownArgs.join(', ')}`);
    process.exit(1);
  }
  const releaseStage = args.includes('--initial-submission') ? 'initial-submission' : 'ga';
  const ownerPath = path.resolve(root, process.env.OWNER_RELEASE_CONFIG_FILE ?? 'release-evidence/owner-release-config.json');
  const owner = parseInput(process.env.OWNER_RELEASE_CONFIG_JSON, ownerPath, 'Owner release configuration');
  if (owner.error) {
    console.error(owner.error);
    console.error('Publication remains blocked until owners supply real repository, release, and support endpoints.');
    process.exit(1);
  }
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));

  if (releaseStage === 'initial-submission') {
    const errors = validateOwnerReleaseConfig(owner.value, { packageJson, pluginId: manifest.id, releaseStage });
    if (errors.length > 0) {
      console.error('Initial-submission release configuration validation failed:');
      for (const error of errors) console.error(`- ${error}`);
      process.exit(1);
    }
    console.log(`Initial-submission release configuration passed for ${manifest.id}.`);
    return;
  }

  const schema = JSON.parse(readFileSync(path.join(root, 'quality', 'ga-evidence-schema.json'), 'utf8'));
  const evidencePath = path.resolve(root, process.env.GA_EVIDENCE_FILE ?? 'release-evidence/ga-evidence.json');
  const evidence = parseInput(process.env.GA_EVIDENCE_JSON, evidencePath, 'Public GA evidence');
  if (evidence.error) {
    console.error(evidence.error);
    console.error('GA remains blocked until owners supply registry status and immutable independently reviewed observations.');
    process.exit(1);
  }
  const errors = validateGaEvidence(evidence.value, {
    expectedRevision: sourceRevision(root), expectedDigest: computeSourceIdentity(root).sha256,
    schema, ownerConfig: owner.value, packageJson, pluginId: manifest.id,
  });
  if (errors.length > 0) {
    console.error('Public GA evidence validation failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(`Public GA evidence passed for ${evidence.value.sourceRevision}/${evidence.value.sourceContentSha256.slice(0, 12)}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await cli();
