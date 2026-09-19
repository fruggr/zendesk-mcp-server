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
  // Stryker disable next-line ConditionalExpression: `html` is a `string`, so this
  // only fires on `''` -- and loading `<div></div>` yields `''` too. A shortcut, not
  // a behaviour, and no input separates the two. The waiver also takes the inverse
  // mutant, which IS killed (always returning `''` zeroes every word count); that
  // assertion stays.
  if (!html) return '';
  // Stryker disable next-line BooleanLiteral: document mode changes nothing
  // observable here. The content is already wrapped in a `<div>` whose text is all
  // that is read back, so the html/head/body scaffolding a document parse adds is
  // never visited -- checked against tables, stray cells, <title>, <script>,
  // <style>, comments and bare text.
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
    // Stryker disable next-line StringLiteral: the `''` arm only feeds the
    // HEADING_LEVELS lookup below, which no marker string can satisfy either, and a
    // non-tag node never reaches the branch that stores `tagName` as `headingTag`.
    // The waiver also takes `'tag'`, which IS killed, by the bare-text-node case in
    // tests/unit/utils/article-sections.test.ts -- that assertion stays.
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

// Keep structural HTML that markdown flattens lossily: <pre> with inline <br>
// collapses to a single line, and <table> cells with multiple <p> break GFM
// pipe tables. Leaving them as raw HTML is safer for round-trip.
const keepAsHtml: Handle = (_state, node) => ({
  type: 'html',
  value: toHtml(node as Element),
});

// Stryker disable BooleanLiteral: `fences` has no reachable input -- `pre` is handed
// to `keepAsHtml` below, so a `<pre><code>` stays raw HTML and no markdown code block
// is ever produced for the option to format. A region over the whole chain, because a
// directive between two `.use()` calls is not a leading comment of any node and is
// silently dropped; it therefore also covers `fragment: true`, which IS killed, by the
// stray-table-row case in tests/unit/utils/article-sections.test.ts. That assertion
// stays; only the gate accounting is waived.
const htmlToMdProcessor = unified()
  .use(rehypeParse, { fragment: true })
  .use(rehypeRemark, { handlers: { table: keepAsHtml, pre: keepAsHtml } })
  .use(remarkGfm)
  .use(remarkStringify, { bullet: '-', emphasis: '_', fences: true });
// Stryker restore BooleanLiteral

const mdToHtmlProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeStringify);

export const htmlToMarkdown = (html: string): string => {
  // Stryker disable next-line ConditionalExpression: as in `textOf` -- a `string`
  // input means this only fires on `''`, and the processor returns `''` for `''`.
  // Also takes the killed inverse, whose assertions (the conversion cases) stay.
  if (!html) return '';
  return String(htmlToMdProcessor.processSync(html));
};

export const markdownToHtml = (markdown: string): string => {
  // Stryker disable next-line ConditionalExpression: same as `htmlToMarkdown`,
  // killed inverse included.
  if (!markdown) return '';
  return String(mdToHtmlProcessor.processSync(markdown));
};
