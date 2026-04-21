import * as cheerio from 'cheerio';
import { marked } from 'marked';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

export interface Section {
  index: number;
  heading: string;
  headingTag: string;
  level: number;
  html: string;
  wordCount: number;
}

const HEADING_LEVELS = new Set(['h1', 'h2', 'h3']);

const countWords = (text: string): number => {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
};

const textOf = (html: string): string => {
  if (!html) return '';
  const $ = cheerio.load(`<div>${html}</div>`, null, false);
  return $('div').first().text();
};

export const parseSections = (html: string): Section[] => {
  if (!html || !html.trim()) return [];

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

let turndownInstance: TurndownService | null = null;

const getTurndown = (): TurndownService => {
  if (turndownInstance) return turndownInstance;
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
  });
  td.use(gfm);
  turndownInstance = td;
  return td;
};

export const htmlToMarkdown = (html: string): string => {
  if (!html) return '';
  return getTurndown().turndown(html);
};

export const markdownToHtml = (markdown: string): string => {
  if (!markdown) return '';
  return marked.parse(markdown, { async: false });
};
