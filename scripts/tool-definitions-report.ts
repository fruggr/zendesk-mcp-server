// Prints, as Markdown, what the deterministic tool-definition checks know about
// `tools/list` (every namespace, `all` mode): blocking problems, then the leads
// a reviewer starts from. Read by the `tool-definition-review` skill.
import { reviewToolDefinitions } from '../tests/tool-definitions/checks';
import { listSurface } from '../tests/tool-definitions/surface';

const { problems, shadowCandidates, tools } = reviewToolDefinitions(
  'zendesk',
  await listSurface('all'),
);
const list = (items: readonly string[]): string =>
  items.length ? items.map((item) => `- ${item}`).join('\n') : '- none';

process.stdout.write(
  [
    `# Tool definitions: ${tools.length} tools, every namespace, \`all\` mode`,
    '',
    '## Problems (fail `pnpm test`)',
    list(problems.map(({ message }) => message)),
    '',
    '## Leads (non-blocking)',
    '',
    'Tools whose description names no other tool. Check whether a sibling could be mistaken for it; if none could, leave it be.',
    list(tools.filter(({ namesASibling }) => !namesASibling).map(({ name }) => `\`${name}\``)),
    '',
    'Shadow candidates (tdqs prefilter by invocation cost; confirm only if both tools could answer the same request).',
    list(
      shadowCandidates.map(({ tool, cheaperSibling }) => `\`${tool}\` by \`${cheaperSibling}\``),
    ),
    '',
    '## Per tool',
    '',
    '| Tool | Bytes | inputHash |',
    '| --- | --- | --- |',
    ...tools.map(
      ({ name, definitionBytes, inputHash }) =>
        `| \`${name}\` | ${definitionBytes} | \`${inputHash}\` |`,
    ),
    '',
  ].join('\n'),
);
