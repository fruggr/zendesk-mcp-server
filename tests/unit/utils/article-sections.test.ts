import { describe, expect, it } from 'vitest';
import {
  htmlToMarkdown,
  markdownToHtml,
  parseSections,
  replaceSectionContent,
} from '../../../src/utils/article-sections';

describe('parseSections', () => {
  it('returns a single intro section when there are no headings', () => {
    const html = '<p>Hello world</p>';
    const sections = parseSections(html);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      index: 0,
      heading: 'intro',
      headingTag: '',
      level: 0,
    });
    expect(sections[0]?.html).toContain('Hello world');
    expect(sections[0]?.wordCount).toBe(2);
  });

  it('creates an intro section with content before the first heading', () => {
    const html = '<p>Intro text</p><h2>First</h2><p>Body</p>';
    const sections = parseSections(html);
    expect(sections).toHaveLength(2);
    expect(sections[0]?.heading).toBe('intro');
    expect(sections[0]?.html).toContain('Intro text');
    expect(sections[1]?.heading).toBe('First');
    expect(sections[1]?.html).toContain('Body');
  });

  it('splits by h1, h2, h3 headings', () => {
    const html = '<h1>A</h1><p>1</p><h2>B</h2><p>2</p><h3>C</h3><p>3</p>';
    const sections = parseSections(html);
    expect(sections).toHaveLength(3);
    expect(sections[0]).toMatchObject({ heading: 'A', headingTag: 'h1', level: 1 });
    expect(sections[1]).toMatchObject({ heading: 'B', headingTag: 'h2', level: 2 });
    expect(sections[2]).toMatchObject({ heading: 'C', headingTag: 'h3', level: 3 });
  });

  it('does not split on h4, h5, h6', () => {
    const html = '<h2>A</h2><p>1</p><h4>sub</h4><p>2</p><h2>B</h2><p>3</p>';
    const sections = parseSections(html);
    expect(sections).toHaveLength(2);
    expect(sections[0]?.html).toContain('sub');
    expect(sections[0]?.html).toContain('2');
  });

  it('omits the intro section when the HTML begins with a heading', () => {
    const html = '<h2>Only</h2><p>Body</p>';
    const sections = parseSections(html);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.heading).toBe('Only');
    expect(sections[0]?.index).toBe(0);
  });

  it('computes wordCount from text content only', () => {
    const html = '<h2>Title</h2><p>one two three</p>';
    const sections = parseSections(html);
    expect(sections[0]?.wordCount).toBe(3);
  });

  it('extracts heading text even with inline markup', () => {
    const html = '<h2>Hello <em>world</em></h2><p>x</p>';
    const sections = parseSections(html);
    expect(sections[0]?.heading).toBe('Hello world');
  });

  it('handles empty html', () => {
    expect(parseSections('')).toEqual([]);
  });

  it('assigns sequential indexes starting at 0', () => {
    const html = '<p>I</p><h2>A</h2><p>1</p><h2>B</h2><p>2</p>';
    const sections = parseSections(html);
    expect(sections.map((s) => s.index)).toEqual([0, 1, 2]);
  });
});

describe('replaceSectionContent', () => {
  it('replaces the content of the intro section', () => {
    const html = '<p>Old intro</p><h2>A</h2><p>1</p>';
    const result = replaceSectionContent(html, 0, '<p>New intro</p>');
    expect(result).toContain('New intro');
    expect(result).not.toContain('Old intro');
    expect(result).toContain('<h2>A</h2>');
    expect(result).toContain('<p>1</p>');
  });

  it('replaces the content of a non-intro section without touching the heading', () => {
    const html = '<h2>A</h2><p>Old A</p><h2>B</h2><p>Old B</p>';
    const result = replaceSectionContent(html, 0, '<p>New A</p>');
    expect(result).toContain('<h2>A</h2>');
    expect(result).toContain('New A');
    expect(result).not.toContain('Old A');
    expect(result).toContain('<h2>B</h2>');
    expect(result).toContain('Old B');
  });

  it('preserves the heading tag level (h3)', () => {
    const html = '<h3>Sub</h3><p>old</p>';
    const result = replaceSectionContent(html, 0, '<p>new</p>');
    expect(result).toContain('<h3>Sub</h3>');
    expect(result).toContain('new');
  });

  it('throws when section_index is out of range', () => {
    const html = '<h2>A</h2><p>1</p>';
    expect(() => replaceSectionContent(html, 5, '<p>x</p>')).toThrow();
    expect(() => replaceSectionContent(html, -1, '<p>x</p>')).toThrow();
  });

  it('round-trips: parse, replace last, parse again', () => {
    const html = '<h2>A</h2><p>a</p><h2>B</h2><p>b</p>';
    const replaced = replaceSectionContent(html, 1, '<p>new b content</p>');
    const sections = parseSections(replaced);
    expect(sections).toHaveLength(2);
    expect(sections[1]?.heading).toBe('B');
    expect(sections[1]?.html).toContain('new b content');
  });
});

describe('htmlToMarkdown', () => {
  it('converts basic HTML to markdown', () => {
    expect(htmlToMarkdown('<p>Hello</p>').trim()).toBe('Hello');
  });

  it('converts headings', () => {
    expect(htmlToMarkdown('<h2>Title</h2>').trim()).toBe('## Title');
  });

  it('converts bold and italic', () => {
    const md = htmlToMarkdown('<p><strong>bold</strong> and <em>italic</em></p>');
    expect(md).toContain('**bold**');
    expect(md).toMatch(/[_*]italic[_*]/);
  });

  it('converts links', () => {
    expect(htmlToMarkdown('<a href="https://x">link</a>').trim()).toBe('[link](https://x)');
  });

  it('keeps tables as raw HTML (safer for round-trip than GFM conversion)', () => {
    const html =
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('<table>');
    expect(md).not.toContain('|');
  });

  it('returns an empty string for empty html', () => {
    expect(htmlToMarkdown('')).toBe('');
  });

  it('preserves <pre> blocks as raw HTML (keeps <br> intact)', () => {
    const html = '<pre><code>line1<br>line2</code></pre>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('<pre>');
    expect(md).toContain('<br>');
    expect(md).toContain('line1');
    expect(md).toContain('line2');
  });

  it('preserves <table> blocks as raw HTML (keeps multi-<p> cells intact)', () => {
    const html = '<table><tbody><tr><td><p>A1</p><p>A2</p></td><td>B</td></tr></tbody></table>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('<table>');
    expect(md).toContain('<p>A1</p>');
    expect(md).toContain('<p>A2</p>');
  });
});

describe('markdownToHtml', () => {
  it('converts markdown to HTML', () => {
    const html = markdownToHtml('# Title');
    expect(html).toContain('<h1>Title</h1>');
  });

  it('passes HTML through unchanged when it looks like HTML already', () => {
    const html = markdownToHtml('<p>already html</p>');
    expect(html).toContain('already html');
  });

  it('handles empty input', () => {
    expect(markdownToHtml('')).toBe('');
  });
});
