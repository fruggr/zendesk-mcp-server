import * as cheerio from 'cheerio';
import type { Element } from 'hast';
import { toHtml } from 'hast-util-to-html';
import type { Handle } from 'hast-util-to-mdast';
import rehypeParse from 'rehype-parse';
import rehypeRaw from 'rehype-raw';
import rehypeRemark from 'rehype-remark';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';

export interface Section {
  index: number;
  heading: string;
  headingTag: string;
  level: number;
  html: string;
  wordCount: number;
}

const HEADING_LEVELS = new Set(['h1', 'h2', 'h3']);

const WHITESPACE_RUN = /\s+/;

const countWords = (text: string): number => {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(WHITESPACE_RUN).length;
};

const textOf = (html: string): string => {
  if (!html) return '';
  const $ = cheerio.load(`<div>${html}</div>`, null, false);
  return $('div').first().text();
};

export const parseSections = (html: string): Section[] => {
  if (!html?.trim()) return [];

  const $ = cheerio.load(html, null, false);
  const children = $.root().contents().toArray();

  const introParts: string[] = [];
  const sections: Array<{
    heading: string;
    headingTag: string;
    level: number;
    contentParts: string[];
  }> = [];
  let current: (typeof sections)[number] | null = null;

  for (const node of children) {
    const tagName = node.type === 'tag' ? node.name.toLowerCase() : '';

    if (HEADING_LEVELS.has(tagName)) {
      const level = Number.parseInt(tagName.slice(1), 10);
      current = {
        heading: $(node).text().trim(),
        headingTag: tagName,
        level,
        contentParts: [],
      };
      sections.push(current);
      continue;
    }

    const outer = $.html(node);
    if (current) {
      current.contentParts.push(outer);
    } else {
      introParts.push(outer);
    }
  }

  const result: Section[] = [];

  if (introParts.length > 0) {
    const introHtml = introParts.join('');
    result.push({
      index: 0,
      heading: 'intro',
      headingTag: '',
      level: 0,
      html: introHtml,
      wordCount: countWords(textOf(introHtml)),
    });
  }

  for (const s of sections) {
    const sectionHtml = s.contentParts.join('');
    result.push({
      index: result.length,
      heading: s.heading,
      headingTag: s.headingTag,
      level: s.level,
      html: sectionHtml,
      wordCount: countWords(textOf(sectionHtml)),
    });
  }

  return result;
};

export const replaceSectionContent = (
  html: string,
  sectionIndex: number,
  newHtml: string,
): string => {
  const sections = parseSections(html);
  if (sectionIndex < 0 || sectionIndex >= sections.length) {
    throw new Error(
      `Section index ${sectionIndex} out of range (valid: 0-${Math.max(0, sections.length - 1)})`,
    );
  }

  return sections
    .map((section, idx) => {
      const content = idx === sectionIndex ? newHtml : section.html;
      if (section.level === 0) return content;
      return `<${section.headingTag}>${section.heading}</${section.headingTag}>${content}`;
    })
    .join('');
};

export interface StrippedHeading {
  tag: string;
  text: string;
}

const LEADING_HEADING = /^\s*<(h[1-3])(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/i;

const normalizeText = (text: string): string => text.trim().split(WHITESPACE_RUN).join(' ');

// The section heading is re-emitted around whatever `content` a caller sends, so a
// caller that echoes the heading back (#328) would end up with it twice and split
// the section in two. Sliced on the string, not re-serialised, to leave the rest
// of the content byte for byte as sent.
export const stripLeadingDuplicateHeading = (
  html: string,
  sectionHeading: string,
): { html: string; stripped: StrippedHeading | null } => {
  const match = LEADING_HEADING.exec(html);
  const tag = match?.[1];
  // Stryker disable next-line LogicalOperator: `tag` is undefined exactly when `match` is
  // null, so `!tag` only narrows the type for noUncheckedIndexedAccess.
  if (!match || !tag) return { html, stripped: null };
  // Stryker disable next-line StringLiteral: group 2 always takes part in a match, so the
  // fallback is unreachable and only satisfies noUncheckedIndexedAccess.
  const text = normalizeText(textOf(match[2] ?? ''));
  if (text !== normalizeText(sectionHeading)) return { html, stripped: null };
  return {
    html: html.slice(match[0].length).trimStart(),
    stripped: { tag: tag.toLowerCase(), text },
  };
};

// Wraps `replaceSectionContent` with the guards a write needs. Only a heading-bearing
// section can echo its own heading; in the intro a heading is a structure change.
export const applySectionUpdate = (
  html: string,
  sectionIndex: number,
  newHtml: string,
): {
  body: string;
  stripped: StrippedHeading | null;
  contentHeadings: number;
  introLost: boolean;
} => {
  const target = parseSections(html)[sectionIndex];
  const { html: content, stripped } =
    target && target.level > 0
      ? stripLeadingDuplicateHeading(newHtml, target.heading)
      : { html: newHtml, stripped: null };
  const contentSections = parseSections(content);
  return {
    body: replaceSectionContent(html, sectionIndex, content),
    stripped,
    contentHeadings: contentSections.filter((s) => s.level > 0).length,
    // Heading-led content turns the intro into a heading section: the section count
    // can stay the same while index 0 changes meaning.
    introLost: target?.level === 0 && (contentSections[0]?.level ?? 0) > 0,
  };
};

// Keep structural HTML that markdown flattens lossily: <pre> with inline <br>
// collapses to a single line, and <table> cells with multiple <p> break GFM
// pipe tables. Leaving them as raw HTML is safer for round-trip.
const keepAsHtml: Handle = (_state, node) => ({
  type: 'html',
  value: toHtml(node as Element),
});

// No `fences` option: `pre` is handled above, so rehype-remark emits no code node for
// remark-stringify to format. Reinstate it if that handler ever goes -- the fallback
// is the indented form, which is ambiguous inside a list.
const htmlToMdProcessor = unified()
  .use(rehypeParse, { fragment: true })
  .use(rehypeRemark, { handlers: { table: keepAsHtml, pre: keepAsHtml } })
  .use(remarkGfm)
  .use(remarkStringify, { bullet: '-', emphasis: '_' });

const mdToHtmlProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeStringify);

export const htmlToMarkdown = (html: string): string => {
  if (!html) return '';
  return String(htmlToMdProcessor.processSync(html));
};

export const markdownToHtml = (markdown: string): string => {
  if (!markdown) return '';
  return String(mdToHtmlProcessor.processSync(markdown));
};
