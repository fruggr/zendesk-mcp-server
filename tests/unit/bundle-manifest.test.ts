import { describe, expect, it } from 'vitest';
import {
  packageRoot,
  renderNotices,
  renderSbom,
  // @ts-expect-error - plain JS build plugin, no type declarations
} from '../../scripts/bundle-manifest.mjs';

const PNPM = '/repo/node_modules/.pnpm';

describe('packageRoot', () => {
  it('finds the package a pnpm module id belongs to, scoped or not', () => {
    expect(packageRoot(`${PNPM}/zod@4.6.5/node_modules/zod/v4/core/core.js`)).toBe(
      `${PNPM}/zod@4.6.5/node_modules/zod`,
    );
    expect(
      packageRoot(
        `${PNPM}/@modelcontextprotocol+server@2.1.0/node_modules/@modelcontextprotocol/server/dist/index.mjs`,
      ),
    ).toBe(`${PNPM}/@modelcontextprotocol+server@2.1.0/node_modules/@modelcontextprotocol/server`);
  });

  it('skips the project sources and virtual modules', () => {
    expect(packageRoot('/repo/src/index.ts')).toBeUndefined();
    expect(packageRoot('\0rolldown/runtime.js')).toBeUndefined();
  });
});

const PACKAGES = [
  { name: 'zod', version: '4.6.5', license: 'MIT', licenseText: 'MIT License\n\nCopyright zod' },
  { name: '@scope/no-text', version: '1.0.0', license: 'ISC', licenseText: undefined },
  { name: 'no-license', version: '2.0.0', license: 'UNKNOWN', licenseText: undefined },
];

describe('renderNotices', () => {
  it('lists every bundled package with its license, sorted by name', () => {
    expect(renderNotices(PACKAGES)).toMatchInlineSnapshot(`
      "# Third-party notices

      dist/ bundles the following packages. Each is distributed under its own license, reproduced below.

      ## @scope/no-text@1.0.0

      License: ISC

      The package ships no license file; see its license identifier above.

      ## no-license@2.0.0

      License: UNKNOWN

      The package ships no license file; see its license identifier above.

      ## zod@4.6.5

      License: MIT

      \`\`\`
      MIT License

      Copyright zod
      \`\`\`
      "
    `);
  });
});

describe('renderSbom', () => {
  const ROOT = { name: '@fruggr/zendesk-mcp-server', version: '3.0.2' };
  const serialOf = (root: typeof ROOT, packages: typeof PACKAGES): string =>
    JSON.parse(renderSbom(root, packages)).serialNumber;

  // actions/attest rejects a CycloneDX document without one, so the image's
  // SBOM attestation needs it. Derived from the content to keep builds reproducible.
  it('carries a content-derived RFC 4122 serial number', () => {
    const serial = serialOf(ROOT, PACKAGES);
    expect(serial).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(serialOf(ROOT, PACKAGES)).toBe(serial);
    expect(serialOf({ ...ROOT, version: '3.0.3' }, PACKAGES)).not.toBe(serial);
    expect(serialOf(ROOT, PACKAGES.slice(1))).not.toBe(serial);
  });

  it('describes the bundled packages as a CycloneDX document, without volatile fields', () => {
    const sbom = JSON.parse(
      renderSbom({ name: '@fruggr/zendesk-mcp-server', version: '3.0.2' }, PACKAGES),
    );
    expect(sbom).toMatchInlineSnapshot(`
      {
        "bomFormat": "CycloneDX",
        "components": [
          {
            "bom-ref": "pkg:npm/%40scope/no-text@1.0.0",
            "licenses": [
              {
                "expression": "ISC",
              },
            ],
            "name": "@scope/no-text",
            "purl": "pkg:npm/%40scope/no-text@1.0.0",
            "type": "library",
            "version": "1.0.0",
          },
          {
            "bom-ref": "pkg:npm/no-license@2.0.0",
            "licenses": [
              {
                "license": {
                  "name": "UNKNOWN",
                },
              },
            ],
            "name": "no-license",
            "purl": "pkg:npm/no-license@2.0.0",
            "type": "library",
            "version": "2.0.0",
          },
          {
            "bom-ref": "pkg:npm/zod@4.6.5",
            "licenses": [
              {
                "expression": "MIT",
              },
            ],
            "name": "zod",
            "purl": "pkg:npm/zod@4.6.5",
            "type": "library",
            "version": "4.6.5",
          },
        ],
        "metadata": {
          "component": {
            "bom-ref": "pkg:npm/%40fruggr/zendesk-mcp-server@3.0.2",
            "name": "@fruggr/zendesk-mcp-server",
            "purl": "pkg:npm/%40fruggr/zendesk-mcp-server@3.0.2",
            "type": "application",
            "version": "3.0.2",
          },
        },
        "serialNumber": "urn:uuid:6f99c62f-9891-561c-b883-434d4960130c",
        "specVersion": "1.6",
        "version": 1,
      }
    `);
  });
});
