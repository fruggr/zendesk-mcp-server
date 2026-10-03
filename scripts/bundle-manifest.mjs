/**
 * Build plugin: dist/ inlines its dependencies, so what it ships has to be
 * listed from the bundle itself. Emits THIRD-PARTY-NOTICES.md (license texts
 * the inlined code requires us to carry) and sbom.cdx.json (CycloneDX, read by
 * scanners and by scripts/security-release-analyzer.js). Built from the modules
 * Rolldown actually bundled, not the lockfile, so a dev-only package never
 * appears and a bundled one is never missed.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const NODE_MODULES = '/node_modules/';
const UNKNOWN_LICENSE = 'UNKNOWN';
const LICENSE_FILE = /^(licen[cs]e|copying)(\.|-|$)/i;

/** Directory of the package a module id belongs to, or undefined for project and virtual modules. */
export const packageRoot = (moduleId) => {
  const id = moduleId.replaceAll('\\', '/');
  const at = id.lastIndexOf(NODE_MODULES);
  if (id.startsWith('\0') || at === -1) return undefined;
  const segments = id.slice(at + NODE_MODULES.length).split('/');
  const nameLength = segments[0]?.startsWith('@') ? 2 : 1;
  return id.slice(0, at + NODE_MODULES.length) + segments.slice(0, nameLength).join('/');
};

const readLicenseText = (dir) => {
  const file = readdirSync(dir).find((entry) => LICENSE_FILE.test(entry));
  return file === undefined ? undefined : readFileSync(join(dir, file), 'utf8').trim();
};

const describePackage = (dir) => {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  return {
    name: manifest.name,
    version: manifest.version,
    license: typeof manifest.license === 'string' ? manifest.license : UNKNOWN_LICENSE,
    licenseText: readLicenseText(dir),
  };
};

const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version);

export const renderNotices = (packages) =>
  [
    '# Third-party notices',
    '',
    'dist/ bundles the following packages. Each is distributed under its own license, reproduced below.',
    ...[...packages]
      .sort(byName)
      .flatMap((pkg) => [
        '',
        `## ${pkg.name}@${pkg.version}`,
        '',
        `License: ${pkg.license}`,
        '',
        pkg.licenseText === undefined
          ? 'The package ships no license file; see its license identifier above.'
          : ['```', pkg.licenseText, '```'].join('\n'),
      ]),
    '',
  ].join('\n');

const purl = (name, version) => `pkg:npm/${name.replace(/^@/, '%40')}@${version}`;

// A name-based (v5-shaped) UUID over the document itself: actions/attest needs a
// serialNumber, and the same sources must still give the same bytes.
const contentSerial = (body) => {
  const hex = createHash('sha1').update(JSON.stringify(body)).digest('hex');
  const variant = ((Number.parseInt(hex[16], 16) % 4) + 8).toString(16);
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

// No timestamp: the same sources must give the same bytes.
export const renderSbom = (root, packages) => {
  const body = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: {
        type: 'application',
        'bom-ref': purl(root.name, root.version),
        name: root.name,
        version: root.version,
        purl: purl(root.name, root.version),
      },
    },
    components: [...packages].sort(byName).map((pkg) => ({
      type: 'library',
      'bom-ref': purl(pkg.name, pkg.version),
      name: pkg.name,
      version: pkg.version,
      purl: purl(pkg.name, pkg.version),
      // UNKNOWN is our fallback, not an SPDX expression: CycloneDX takes it as a name.
      licenses: [
        pkg.license === UNKNOWN_LICENSE
          ? { license: { name: UNKNOWN_LICENSE } }
          : { expression: pkg.license },
      ],
    })),
  };
  const { bomFormat, specVersion, ...rest } = body;
  return `${JSON.stringify(
    { bomFormat, specVersion, serialNumber: contentSerial(body), ...rest },
    null,
    2,
  )}\n`;
};

/** Rolldown plugin emitting both files next to the bundle. */
export const bundleManifest = (root) => ({
  name: 'bundle-manifest',
  generateBundle(_options, bundle) {
    const dirs = new Set(
      Object.values(bundle)
        .flatMap((output) => (output.type === 'chunk' ? output.moduleIds : []))
        .map(packageRoot)
        .filter((dir) => dir !== undefined),
    );
    // pnpm installs one package once per peer set; the bundle carries it once.
    const packages = [
      ...new Map(
        [...dirs].map(describePackage).map((pkg) => [`${pkg.name}@${pkg.version}`, pkg]),
      ).values(),
    ];
    this.emitFile({
      type: 'asset',
      fileName: 'THIRD-PARTY-NOTICES.md',
      source: renderNotices(packages),
    });
    this.emitFile({ type: 'asset', fileName: 'sbom.cdx.json', source: renderSbom(root, packages) });
  },
});
