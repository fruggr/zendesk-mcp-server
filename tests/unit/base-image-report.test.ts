import { describe, expect, it } from 'vitest';
import {
  checkBase,
  parseApk,
  parseFromLines,
  parseOsVersion,
  parseTag,
  readmeTag,
  renderReport,
  // @ts-expect-error - plain JS CI script, no type declarations
} from '../../scripts/base-image-report.mjs';

const DOCKERFILE = `# syntax=docker/dockerfile:1
FROM dhi.io/node:24.22.1-alpine3.24-dev@sha256:aaaa1111bbbb AS build
RUN echo hi
FROM dhi.io/node:24.22.1-alpine3.24@sha256:cccc2222dddd
`;

const README = `# x
[![Container base](https://img.shields.io/static/v1?label=container%20base&message=dhi.io%2Fnode%3A24.22.1-alpine3.24&color=2496ED)](https://github.com/fruggr/zendesk-mcp-server/blob/main/docs/http-deployment.md#container)
`;

describe('parseFromLines', () => {
  it('reads every FROM line, without its stage name', () => {
    expect(parseFromLines(DOCKERFILE)).toEqual([
      {
        ref: 'dhi.io/node:24.22.1-alpine3.24-dev@sha256:aaaa1111bbbb',
        image: 'dhi.io/node',
        tag: '24.22.1-alpine3.24-dev',
        digest: 'sha256:aaaa1111bbbb',
      },
      {
        ref: 'dhi.io/node:24.22.1-alpine3.24@sha256:cccc2222dddd',
        image: 'dhi.io/node',
        tag: '24.22.1-alpine3.24',
        digest: 'sha256:cccc2222dddd',
      },
    ]);
  });
});

describe('parseTag', () => {
  it('splits a full DHI tag into Node and Alpine versions', () => {
    expect(parseTag('24.22.1-alpine3.24')).toEqual({ node: '24.22.1', alpine: '3.24', dev: false });
    expect(parseTag('24.22.1-alpine3.24-dev')).toEqual({
      node: '24.22.1',
      alpine: '3.24',
      dev: true,
    });
  });

  it('rejects a floating or variant tag', () => {
    expect(parseTag('24-alpine3.24')).toBeUndefined();
    expect(parseTag('24.22-alpine3.24')).toBeUndefined();
    expect(parseTag('24.22.1-alpine3.24-fips')).toBeUndefined();
  });
});

describe('parseApk', () => {
  it('maps each installed package to its version', () => {
    const db = 'C:Q1x\nP:musl\nV:1.2.5-r10\nA:x86_64\n\nP:libcrypto3\nV:3.5.2-r0\n';
    expect(parseApk(db)).toEqual({ musl: '1.2.5-r10', libcrypto3: '3.5.2-r0' });
  });

  it('returns null when the image carries no apk database', () => {
    expect(parseApk(null)).toBeNull();
  });
});

describe('parseOsVersion', () => {
  it('reads VERSION_ID, quoted or not', () => {
    expect(parseOsVersion('NAME="Alpine Linux"\nVERSION_ID=3.24.1\n')).toBe('3.24.1');
    expect(parseOsVersion('VERSION_ID="3.24.1"\n')).toBe('3.24.1');
    expect(parseOsVersion(null)).toBeUndefined();
  });
});

describe('readmeTag', () => {
  it('reads the tag from the README badge', () => {
    expect(readmeTag(README)).toBe('24.22.1-alpine3.24');
    expect(readmeTag('no badge')).toBeUndefined();
  });
});

const probe = (node: string, alpine: string) => ({ node, openssl: '3.5.2', alpine, packages: {} });

describe('checkBase', () => {
  const froms = parseFromLines(DOCKERFILE);
  const probes = Object.fromEntries(
    froms.map((f: { ref: string }) => [f.ref, probe('24.22.1', '3.24.1')]),
  );

  it('passes when the tags, the README and the images agree', () => {
    expect(checkBase({ froms, readme: README, probes })).toEqual([]);
  });

  it('names every disagreement', () => {
    const drifted = DOCKERFILE.replace('24.22.1-alpine3.24-dev', '24.21.0-alpine3.24-dev');
    const driftedFroms = parseFromLines(drifted);
    const wrong = {
      [driftedFroms[0].ref]: probe('24.21.0', '3.24.1'),
      [driftedFroms[1].ref]: probe('24.22.0', '3.23.4'),
    };
    expect(
      checkBase({
        froms: driftedFroms,
        readme: README.replace('24.22.1', '24.20.0'),
        probes: wrong,
      }),
    ).toMatchInlineSnapshot(`
      [
        "The FROM lines name different versions: 24.21.0-alpine3.24-dev, 24.22.1-alpine3.24. Both stages must track one tag.",
        "README badge says 24.20.0-alpine3.24, the runtime FROM says 24.22.1-alpine3.24.",
        "dhi.io/node:24.22.1-alpine3.24@sha256:cccc2222dddd runs Node 24.22.0, its tag says 24.22.1.",
        "dhi.io/node:24.22.1-alpine3.24@sha256:cccc2222dddd runs Alpine 3.23.4, its tag says 3.24.",
      ]
    `);
  });

  it('rejects a tag that does not name the full Node version', () => {
    const floating = parseFromLines(DOCKERFILE.replaceAll('24.22.1-', '24-'));
    expect(checkBase({ froms: floating, readme: README, probes: {} })).toMatchInlineSnapshot(`
      [
        "dhi.io/node:24-alpine3.24-dev@sha256:aaaa1111bbbb: the tag must read <node x.y.z>-alpine<x.y>[-dev], so the Node version shows in the Dockerfile and in Renovate's PRs.",
        "dhi.io/node:24-alpine3.24@sha256:cccc2222dddd: the tag must read <node x.y.z>-alpine<x.y>[-dev], so the Node version shows in the Dockerfile and in Renovate's PRs.",
        "README badge says 24.22.1-alpine3.24, the runtime FROM says 24-alpine3.24.",
      ]
    `);
  });
});

describe('renderReport', () => {
  const before = {
    from: parseFromLines('FROM dhi.io/node:24-alpine3.24@sha256:0b55cdd8c105b9823b26')[0],
    probe: {
      node: '24.22.0',
      openssl: '3.5.1',
      alpine: '3.24.0',
      packages: { musl: '1.2.5-r10', libcrypto3: '3.5.1-r0', zlib: '1.3.1-r2' },
    },
  };
  const after = {
    from: parseFromLines(DOCKERFILE).at(-1),
    probe: {
      node: '24.22.1',
      openssl: '3.5.2',
      alpine: '3.24.1',
      packages: { musl: '1.2.5-r10', libcrypto3: '3.5.2-r0', libssl3: '3.5.2-r0' },
    },
  };

  it('compares the runtime base before and after, packages included', () => {
    expect(renderReport({ before, after })).toMatchInlineSnapshot(`
      "<!-- base-image-report -->
      ### Container base image

      What the runtime stage of the image is built on, read from inside each image by the Base image workflow.

      | | Before | After |
      | --- | --- | --- |
      | Image | \`dhi.io/node:24-alpine3.24\` | \`dhi.io/node:24.22.1-alpine3.24\` |
      | Digest | \`sha256:0b55cdd8c105\` | \`sha256:cccc2222dddd\` |
      | Node.js | 24.22.0 | **24.22.1** |
      | OpenSSL | 3.5.1 | **3.5.2** |
      | Alpine | 3.24.0 | **3.24.1** |

      <details><summary>Alpine packages: 1 updated, 1 added, 1 removed</summary>

      | Package | Before | After |
      | --- | --- | --- |
      | libcrypto3 | 3.5.1-r0 | 3.5.2-r0 |
      | libssl3 | — | 3.5.2-r0 |
      | zlib | 1.3.1-r2 | — |

      </details>

      Node.js release notes: [24.22.1](https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V24.md#24.22.1). Image catalog: [dhi.io/node](https://hub.docker.com/hardened-images/catalog/dhi/node).
      "
    `);
  });

  it('describes the current base alone when there is nothing to compare', () => {
    const bare = { ...after, probe: { ...after.probe, packages: null } };
    expect(renderReport({ after: bare })).toMatchInlineSnapshot(`
      "<!-- base-image-report -->
      ### Container base image

      What the runtime stage of the image is built on, read from inside each image by the Base image workflow.

      | | Current |
      | --- | --- |
      | Image | \`dhi.io/node:24.22.1-alpine3.24\` |
      | Digest | \`sha256:cccc2222dddd\` |
      | Node.js | 24.22.1 |
      | OpenSSL | 3.5.2 |
      | Alpine | 3.24.1 |

      Alpine packages: not listed, the image carries no apk database.

      Image catalog: [dhi.io/node](https://hub.docker.com/hardened-images/catalog/dhi/node).
      "
    `);
  });
});
