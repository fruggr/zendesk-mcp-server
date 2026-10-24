#!/usr/bin/env node
/**
 * Container base image report: `node scripts/base-image-report.mjs [--base <git ref>] [--out <file>]`.
 * Runs node inside each FROM image to read what it really carries (Node, OpenSSL,
 * Alpine, apk packages), fails when the Dockerfile tags, the README badge and the
 * images disagree, and writes a Markdown comparison with the base ref's runtime
 * image. Run by .github/workflows/base-image.yml; why: docs/release-automation.md.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const MARKER = '<!-- base-image-report -->';
const CATALOG = 'https://hub.docker.com/hardened-images/catalog/dhi/node';

export const parseFromLines = (dockerfile) =>
  [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map(([, ref]) => {
    const [name, digest] = ref.split('@');
    const colon = name.lastIndexOf(':');
    return { ref, image: name.slice(0, colon), tag: name.slice(colon + 1), digest };
  });

export const parseTag = (tag) => {
  const match = /^(\d+\.\d+\.\d+)-alpine(\d+\.\d+)(-dev)?$/.exec(tag);
  return match ? { node: match[1], alpine: match[2], dev: match[3] !== undefined } : undefined;
};

export const parseApk = (db) => {
  if (db === null) return null;
  const packages = {};
  for (const entry of db.split('\n\n')) {
    const name = /^P:(.+)$/m.exec(entry)?.[1];
    const version = /^V:(.+)$/m.exec(entry)?.[1];
    if (name && version) packages[name] = version;
  }
  return packages;
};

export const parseOsVersion = (osRelease) =>
  osRelease === null ? undefined : /^VERSION_ID="?([^"\n]+)"?$/m.exec(osRelease)?.[1];

export const readmeTag = (readme) => /message=dhi\.io%2Fnode%3A([^&)]+)/.exec(readme)?.[1];

export const checkBase = ({ froms, readme, probes }) => {
  const problems = [];
  const versions = new Set(froms.map((f) => f.tag.replace(/-dev$/, '')));
  if (versions.size > 1) {
    problems.push(
      `The FROM lines name different versions: ${froms.map((f) => f.tag).join(', ')}. Both stages must track one tag.`,
    );
  }
  for (const from of froms) {
    if (!parseTag(from.tag)) {
      problems.push(
        `${from.ref}: the tag must read <node x.y.z>-alpine<x.y>[-dev], so the Node version shows in the Dockerfile and in Renovate's PRs.`,
      );
    }
  }
  const runtime = froms.at(-1);
  const badge = readmeTag(readme);
  if (badge !== runtime.tag) {
    problems.push(`README badge says ${badge}, the runtime FROM says ${runtime.tag}.`);
  }
  for (const from of froms) {
    const tag = parseTag(from.tag);
    const probe = probes[from.ref];
    if (!tag || !probe) continue;
    if (probe.node !== tag.node) {
      problems.push(`${from.ref} runs Node ${probe.node}, its tag says ${tag.node}.`);
    }
    if (probe.alpine !== undefined && !`${probe.alpine}.`.startsWith(`${tag.alpine}.`)) {
      problems.push(`${from.ref} runs Alpine ${probe.alpine}, its tag says ${tag.alpine}.`);
    }
  }
  return problems;
};

const shortDigest = (digest) => (digest ? `\`${digest.slice(0, 19)}\`` : '—');

const packageRows = (before, after) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((name) => before[name] !== after[name])
    .map((name) => ({ name, before: before[name], after: after[name] }));

export const renderReport = ({ before, after }) => {
  const sides = before ? [before, after] : [after];
  const row = (label, read) => {
    const values = sides.map(read);
    const changed = before && values[0] !== values[1];
    return `| ${label} | ${values.map((v, i) => (changed && i === 1 ? `**${v}**` : v)).join(' | ')} |`;
  };
  const lines = [
    MARKER,
    '### Container base image',
    '',
    'What the runtime stage of the image is built on, read from inside each image by the Base image workflow.',
    '',
    before ? '| | Before | After |' : '| | Current |',
    before ? '| --- | --- | --- |' : '| --- | --- |',
    `| Image | ${sides.map((s) => `\`${s.from.image}:${s.from.tag}\``).join(' | ')} |`,
    `| Digest | ${sides.map((s) => shortDigest(s.from.digest)).join(' | ')} |`,
    row('Node.js', (s) => s.probe.node),
    row('OpenSSL', (s) => s.probe.openssl),
    row('Alpine', (s) => s.probe.alpine ?? 'unknown'),
    '',
  ];

  if (!before) {
    if (after.probe.packages === null) {
      lines.push('Alpine packages: not listed, the image carries no apk database.', '');
    }
  } else if (before.probe.packages === null || after.probe.packages === null) {
    lines.push('Alpine packages: not compared, an image carries no apk database.', '');
  } else {
    const rows = packageRows(before.probe.packages, after.probe.packages);
    const count = (test) => rows.filter(test).length;
    const updated = count((r) => r.before && r.after);
    const added = count((r) => !r.before);
    const removed = count((r) => !r.after);
    if (rows.length === 0) {
      lines.push('Alpine packages: unchanged.', '');
    } else {
      lines.push(
        `<details><summary>Alpine packages: ${updated} updated, ${added} added, ${removed} removed</summary>`,
        '',
        '| Package | Before | After |',
        '| --- | --- | --- |',
        ...rows.map((r) => `| ${r.name} | ${r.before ?? '—'} | ${r.after ?? '—'} |`),
        '',
        '</details>',
        '',
      );
    }
  }

  const node = after.probe.node;
  const notes =
    before && before.probe.node !== node
      ? `Node.js release notes: [${node}](https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V${node.split('.')[0]}.md#${node}). `
      : '';
  lines.push(`${notes}Image catalog: [dhi.io/node](${CATALOG}).`, '');
  return lines.join('\n');
};

// Runs inside the base image, which has node but no shell.
const PROBE = `const fs = require('node:fs');
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
console.log(JSON.stringify({ versions: process.versions, osRelease: read('/etc/os-release'), apk: read('/lib/apk/db/installed') }));`;

const probeImage = (ref) => {
  const run = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--platform',
      'linux/amd64',
      '--network',
      'none',
      '--entrypoint',
      'node',
      ref,
      '-e',
      PROBE,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (run.status !== 0) throw new Error(`docker run ${ref} failed: ${run.stderr}`);
  const raw = JSON.parse(run.stdout);
  return {
    node: raw.versions.node,
    openssl: raw.versions.openssl,
    alpine: parseOsVersion(raw.osRelease),
    packages: parseApk(raw.apk),
  };
};

const main = () => {
  const { values } = parseArgs({ options: { base: { type: 'string' }, out: { type: 'string' } } });
  const froms = parseFromLines(readFileSync('Dockerfile', 'utf8'));
  const readme = readFileSync('README.md', 'utf8');
  const runtime = froms.at(-1);

  const baseDockerfile = values.base
    ? spawnSync('git', ['show', `${values.base}:Dockerfile`], { encoding: 'utf8' }).stdout
    : '';
  const baseRuntime = parseFromLines(baseDockerfile).at(-1);
  const changed = baseRuntime !== undefined && baseRuntime.ref !== runtime.ref;

  const probes = Object.fromEntries(froms.map((f) => [f.ref, probeImage(f.ref)]));
  const report = renderReport({
    before: changed ? { from: baseRuntime, probe: probeImage(baseRuntime.ref) } : undefined,
    after: { from: runtime, probe: probes[runtime.ref] },
  });
  if (values.out) writeFileSync(values.out, report);
  else console.log(report);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);

  const problems = checkBase({ froms, readme, probes });
  for (const problem of problems) console.error(`::error file=Dockerfile::${problem}`);
  if (problems.length > 0) process.exit(1);
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
