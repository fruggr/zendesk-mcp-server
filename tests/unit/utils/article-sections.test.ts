import { describe, expect, it } from 'vitest';
import {
  applySectionUpdate,
  htmlToMarkdown,
  markdownToHtml,
  parseSections,
  replaceSectionContent,
  stripLeadingDuplicateHeading,
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

  it('treats whitespace-only html as empty', () => {
    expect(parseSections('   \n\t  ')).toEqual([]);
  });

  it('recognises headings whatever their tag case', () => {
    // cheerio preserves the source case; the split normalises it.
    const sections = parseSections('<H2>Upper</H2><p>body</p>');
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ heading: 'Upper', headingTag: 'h2', level: 2 });
  });

  it('counts a run of whitespace as a single separator', () => {
    // `\s+`, not `\s`: without the quantifier, "one  two" counts 3 words.
    const sections = parseSections('<h2>T</h2><p>one  two\n\nthree</p>');
    expect(sections[0]?.wordCount).toBe(3);
  });

  it('reports a zero word count for a heading with no content', () => {
    const sections = parseSections('<h2>Empty</h2>');
    expect(sections[0]).toMatchObject({ heading: 'Empty', html: '', wordCount: 0 });
  });

  it('ignores markup when counting words', () => {
    const sections = parseSections('<h2>T</h2><p><strong>one</strong> <em>two</em></p>');
    expect(sections[0]?.wordCount).toBe(2);
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

  it('names the offending index and the valid range in the error', () => {
    // The message is what the LLM sees and has to act on, so it is pinned in
    // full rather than merely required to throw.
    const html = '<h2>A</h2><p>1</p><h2>B</h2><p>2</p>';
    expect(() => replaceSectionContent(html, 7, '<p>x</p>')).toThrow(
      'Section index 7 out of range (valid: 0-1)',
    );
  });

  it('reports the range as 0-0 rather than 0--1 when there is no section', () => {
    expect(() => replaceSectionContent('', 0, '<p>x</p>')).toThrow(
      'Section index 0 out of range (valid: 0-0)',
    );
  });

  it('accepts the last valid index', () => {
    // Guards the `>= sections.length` bound against an off-by-one that would
    // reject a legitimate final section.
    const html = '<h2>A</h2><p>a</p><h2>B</h2><p>b</p>';
    expect(replaceSectionContent(html, 1, '<p>new</p>')).toBe(
      '<h2>A</h2><p>a</p><h2>B</h2><p>new</p>',
    );
  });

  it('rebuilds the document verbatim when replacing with identical content', () => {
    // Pins the join and the heading re-wrapping: any stray separator or
    // dropped tag shows up here.
    const html = '<p>intro</p><h2>A</h2><p>a</p><h3>B</h3><p>b</p>';
    expect(replaceSectionContent(html, 0, '<p>intro</p>')).toBe(html);
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

describe('heading markup is kept on update (issue #331)', () => {
  const HTML =
    '<p>intro</p><h2 id="setup" class="x">Fish &amp; <em>Chips</em></h2><p>old</p><h3>Sub &lt;i&gt;</h3><p>b</p>';

  it('keeps attributes, inline markup and escaping of every heading', () => {
    expect(replaceSectionContent(HTML, 1, '<p>new</p>')).toMatchInlineSnapshot(
      `"<p>intro</p><h2 id="setup" class="x">Fish &amp; <em>Chips</em></h2><p>new</p><h3>Sub &lt;i&gt;</h3><p>b</p>"`,
    );
  });

  it('leaves the headings alone whichever section is edited', () => {
    const sections = parseSections(HTML);
    for (const section of sections) {
      expect(replaceSectionContent(HTML, section.index, section.html)).toBe(HTML);
    }
  });

  it('keeps the heading of the edited section itself', () => {
    expect(replaceSectionContent(HTML, 2, '<p>new</p>')).toMatchInlineSnapshot(
      `"<p>intro</p><h2 id="setup" class="x">Fish &amp; <em>Chips</em></h2><p>old</p><h3>Sub &lt;i&gt;</h3><p>new</p>"`,
    );
  });

  it('exposes the heading outer HTML, empty for the intro', () => {
    expect(parseSections(HTML).map((s) => s.headingHtml)).toMatchInlineSnapshot(`
      [
        "",
        "<h2 id="setup" class="x">Fish &amp; <em>Chips</em></h2>",
        "<h3>Sub &lt;i&gt;</h3>",
      ]
    `);
  });

  it('keeps the text heading for the outline and translation comparison', () => {
    expect(parseSections(HTML).map((s) => s.heading)).toEqual(['intro', 'Fish & Chips', 'Sub <i>']);
  });

  it('re-emits the heading as the parser serialises it, like the rest of the body', () => {
    expect(replaceSectionContent('<H2 ID=a>Title</H2><p>x</p>', 0, '<p>y</p>')).toBe(
      '<h2 id="a">Title</h2><p>y</p>',
    );
  });

  it('writes named entities as characters but keeps the ones that carry markup escaped', () => {
    const html = '<h2>Caf&eacute; &copy; A&nbsp;B &lt;i&gt; &amp; &quot;q&quot;</h2><p>x</p>';
    expect(replaceSectionContent(html, 0, '<p>y</p>')).toMatchInlineSnapshot(
      `"<h2>Café © A&nbsp;B &lt;i&gt; &amp; "q"</h2><p>y</p>"`,
    );
  });

  it('leaves a heading nested in another element untouched', () => {
    const html = '<h2 id="a">A</h2><div><h2 id="n">inner</h2></div><h2>B</h2><p>b</p>';
    expect(replaceSectionContent(html, 1, '<p>nb</p>')).toBe(
      '<h2 id="a">A</h2><div><h2 id="n">inner</h2></div><h2>B</h2><p>nb</p>',
    );
  });

  it('keeps the original heading when a repeated heading is stripped from content', () => {
    const { body, stripped } = applySectionUpdate(
      '<h2 id="rel">Related</h2><ul><li>old</li></ul>',
      0,
      '<h2>Related</h2><ul><li>new</li></ul>',
    );
    expect(stripped).toEqual({ tag: 'h2', text: 'Related' });
    expect(body).toBe('<h2 id="rel">Related</h2><ul><li>new</li></ul>');
  });
});

const h = (heading: string, headingTag = 'h2') => ({ heading, headingTag });

describe('stripLeadingDuplicateHeading (issue #328)', () => {
  it('removes a leading heading that repeats the section heading', () => {
    expect(
      stripLeadingDuplicateHeading(
        '<h2>Related articles</h2>\n<ul><li>a</li></ul>',
        h('Related articles'),
      ),
    ).toMatchInlineSnapshot(`
      {
        "html": "<ul><li>a</li></ul>",
        "stripped": {
          "tag": "h2",
          "text": "Related articles",
        },
      }
    `);
  });

  it('keeps a leading heading whose text differs from the section heading', () => {
    const html = '<h2>Other</h2><p>x</p>';
    expect(stripLeadingDuplicateHeading(html, h('Related articles'))).toMatchInlineSnapshot(`
      {
        "html": "<h2>Other</h2><p>x</p>",
        "stripped": null,
      }
    `);
  });

  it('keeps a same-titled heading of another level, which reads as a sub-heading', () => {
    const html = '<h3>Setup</h3><p>x</p>';
    expect(stripLeadingDuplicateHeading(html, h('Setup'))).toMatchInlineSnapshot(`
      {
        "html": "<h3>Setup</h3><p>x</p>",
        "stripped": null,
      }
    `);
  });

  it('strips a same-level heading whatever the case of its tag', () => {
    expect(
      stripLeadingDuplicateHeading('<H3>Setup</H3><p>x</p>', h('Setup', 'h3')),
    ).toMatchInlineSnapshot(`
      {
        "html": "<p>x</p>",
        "stripped": {
          "tag": "h3",
          "text": "Setup",
        },
      }
    `);
  });

  it('ignores whitespace runs and surrounding whitespace when comparing', () => {
    expect(
      stripLeadingDuplicateHeading(
        '  \n<h2> Related\n  articles </h2><p>x</p>',
        h('Related  articles'),
      ).stripped,
    ).toMatchInlineSnapshot(`
      {
        "tag": "h2",
        "text": "Related articles",
      }
    `);
  });

  it('compares the text of the heading, not its inline markup or entities', () => {
    expect(
      stripLeadingDuplicateHeading(
        '<h2 id="x">Fish &amp; <em>Chips</em></h2><p>y</p>',
        h('Fish & Chips'),
      ).html,
    ).toBe('<p>y</p>');
  });

  it('is case sensitive, since a different case reads as an intended rename', () => {
    expect(
      stripLeadingDuplicateHeading('<h2>related articles</h2><p>x</p>', h('Related articles'))
        .stripped,
    ).toBeNull();
  });

  it('only looks at the very start of the content', () => {
    const html = '<p>x</p><h2>Setup</h2><p>y</p>';
    expect(stripLeadingDuplicateHeading(html, h('Setup'))).toMatchInlineSnapshot(`
      {
        "html": "<p>x</p><h2>Setup</h2><p>y</p>",
        "stripped": null,
      }
    `);
  });

  it('removes only the first of two identical leading headings', () => {
    expect(stripLeadingDuplicateHeading('<h2>A</h2><h2>A</h2><p>x</p>', h('A')).html).toBe(
      '<h2>A</h2><p>x</p>',
    );
  });

  it('only recognises h1 to h3, like parseSections', () => {
    const html = '<h4>Setup</h4><p>x</p>';
    expect(stripLeadingDuplicateHeading(html, h('Setup')).stripped).toBeNull();
  });

  it('returns an empty string when the content was only the heading', () => {
    expect(stripLeadingDuplicateHeading('<h2>Setup</h2>', h('Setup')).html).toBe('');
  });

  it('leaves the rest of the content byte for byte untouched', () => {
    const rest = '<p class="a">x &amp; y</p><pre>a<br>b</pre>';
    expect(stripLeadingDuplicateHeading(`<h2>Setup</h2>${rest}`, h('Setup')).html).toBe(rest);
  });
});

describe('applySectionUpdate (issue #328)', () => {
  it('does not duplicate the heading when the content repeats it', () => {
    const body = '<p>intro</p><h2>Related articles</h2><ul><li>old</li></ul>';
    const result = applySectionUpdate(body, 1, '<h2>Related articles</h2><ul><li>new</li></ul>');
    expect(result).toMatchInlineSnapshot(`
      {
        "body": "<p>intro</p><h2>Related articles</h2><ul><li>new</li></ul>",
        "contentHeadings": 0,
        "introLost": null,
        "sectionsBefore": 2,
        "stripped": {
          "tag": "h2",
          "text": "Related articles",
        },
      }
    `);
    expect(parseSections(result.body)).toHaveLength(2);
  });

  it('behaves like replaceSectionContent when the content carries no heading', () => {
    const body = '<h2>A</h2><p>a</p><h2>B</h2><p>b</p>';
    expect(applySectionUpdate(body, 1, '<p>new</p>')).toEqual({
      body: replaceSectionContent(body, 1, '<p>new</p>'),
      stripped: null,
      contentHeadings: 0,
      introLost: null,
      sectionsBefore: 2,
    });
  });

  it('keeps a same-titled sub-heading of another level instead of deleting it', () => {
    const body = '<h2>FAQ</h2><p>y</p>';
    const result = applySectionUpdate(body, 0, '<h3>FAQ</h3><p>n</p>');
    expect(result.body).toBe('<h2>FAQ</h2><h3>FAQ</h3><p>n</p>');
    expect(result.stripped).toBeNull();
    expect(result.contentHeadings).toBe(1);
  });

  it('reports how many sections the body had before the update', () => {
    expect(
      applySectionUpdate('<p>i</p><h2>A</h2><p>a</p><h2>B</h2>', 1, '<p>x</p>').sectionsBefore,
    ).toBe(3);
  });

  describe('introLost', () => {
    const body = '<p>intro</p><h2>A</h2><p>a</p>';

    it('is "heading-led" when heading-led content replaces the intro, whose count stays put', () => {
      const result = applySectionUpdate(body, 0, '<h2>X</h2><p>y</p>');
      expect(result.introLost).toBe('heading-led');
      expect(parseSections(result.body)).toHaveLength(parseSections(body).length);
    });

    it('is "empty" when the intro is emptied, which drops section 0 and shifts the rest', () => {
      const result = applySectionUpdate(body, 0, '');
      expect(result.introLost).toBe('empty');
      expect(parseSections(result.body)).toHaveLength(parseSections(body).length - 1);
    });

    it('treats whitespace-only content as empty', () => {
      expect(applySectionUpdate(body, 0, ' \n ').introLost).toBe('empty');
    });

    it('is null when the new intro keeps text before its first heading', () => {
      expect(applySectionUpdate(body, 0, '<p>t</p><h2>X</h2>').introLost).toBeNull();
    });

    it('is null when the intro is replaced by plain content', () => {
      expect(applySectionUpdate(body, 0, '<p>t</p>').introLost).toBeNull();
    });

    it('is null for a section that has its own heading, even when emptied', () => {
      expect(applySectionUpdate(body, 1, '<h3>S</h3><p>x</p>').introLost).toBeNull();
      expect(applySectionUpdate(body, 1, '').introLost).toBeNull();
    });
  });

  it('counts the headings that remain in the content', () => {
    const body = '<h2>A</h2><p>a</p><h2>B</h2><p>b</p>';
    const result = applySectionUpdate(body, 0, '<p>x</p><h3>Sub</h3><p>y</p><h3>Sub 2</h3>');
    expect(result.contentHeadings).toBe(2);
    expect(result.stripped).toBeNull();
    expect(parseSections(result.body)).toHaveLength(4);
  });

  it('strips the duplicate and still counts the other headings', () => {
    const body = '<h2>A</h2><p>a</p>';
    const result = applySectionUpdate(body, 0, '<h2>A</h2><p>x</p><h3>Sub</h3>');
    expect(result.stripped).toEqual({ tag: 'h2', text: 'A' });
    expect(result.contentHeadings).toBe(1);
  });

  it('never strips from the heading-less intro, where a heading is a structure change', () => {
    const body = '<p>intro</p><h2>Related articles</h2><p>x</p>';
    const result = applySectionUpdate(body, 0, '<h2>Related articles</h2><p>y</p>');
    expect(result.stripped).toBeNull();
    expect(result.contentHeadings).toBe(1);
  });

  it('leaves a heading titled like the intro placeholder alone in the intro', () => {
    // parseSections labels the intro "intro"; that is a label, not a heading to echo.
    const body = '<p>intro</p><h2>A</h2><p>a</p>';
    const result = applySectionUpdate(body, 0, '<h2>intro</h2><p>x</p>');
    expect(result.stripped).toBeNull();
    expect(result.contentHeadings).toBe(1);
  });

  it('does not count a heading nested in another element, which is not a section', () => {
    const body = '<h2>A</h2><p>a</p>';
    expect(applySectionUpdate(body, 0, '<div><h2>x</h2></div>').contentHeadings).toBe(0);
  });

  it('keeps the out-of-range error even when the content leads with a heading', () => {
    expect(() => applySectionUpdate('<h2>A</h2><p>1</p>', 4, '<h2>A</h2><p>x</p>')).toThrow(
      'Section index 4 out of range (valid: 0-0)',
    );
  });

  it('keeps the out-of-range error of replaceSectionContent', () => {
    expect(() => applySectionUpdate('<h2>A</h2><p>1</p>', 4, '<p>x</p>')).toThrow(
      'Section index 4 out of range (valid: 0-0)',
    );
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

  it('converts <del> to GFM strikethrough (~~...~~)', () => {
    expect(htmlToMarkdown('<p><del>gone</del></p>')).toContain('~~gone~~');
  });

  it('converts <s> and <strike> to GFM strikethrough', () => {
    expect(htmlToMarkdown('<p><s>a</s> <strike>b</strike></p>')).toMatch(/~~a~~.*~~b~~/);
  });

  it('converts GFM task list items with state', () => {
    const html =
      '<ul><li><input type="checkbox" checked="">done</li><li><input type="checkbox">todo</li></ul>';
    const md = htmlToMarkdown(html);
    expect(md).toMatch(/\[x\][^\n]*done/);
    expect(md).toMatch(/\[ \][^\n]*todo/);
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

  it('converts GFM strikethrough to <del>', () => {
    const html = markdownToHtml('~~gone~~');
    expect(html).toMatch(/<del>gone<\/del>/);
  });

  it('converts GFM task list items to checkbox inputs', () => {
    const html = markdownToHtml('- [x] done\n- [ ] todo\n');
    expect(html).toMatch(
      /<input[^>]*checked[^>]*type="checkbox"|<input[^>]*type="checkbox"[^>]*checked/,
    );
    expect(html).toMatch(/<li[^>]*>[^<]*<input(?:(?!checked)[^>])*>[^<]*todo/);
  });
});

describe('round-trip HTML ↔ Markdown', () => {
  it('preserves <del> through html → md → html', () => {
    const src = '<p><del>gone</del></p>';
    const roundTrip = markdownToHtml(htmlToMarkdown(src));
    expect(roundTrip).toMatch(/<del>gone<\/del>/);
  });

  it('preserves a checked task list item through html → md → html', () => {
    const src = '<ul><li><input type="checkbox" checked="">done</li></ul>';
    const roundTrip = markdownToHtml(htmlToMarkdown(src));
    expect(roundTrip).toMatch(
      /<input[^>]*checked[^>]*type="checkbox"|<input[^>]*type="checkbox"[^>]*checked/,
    );
  });
});

describe('parseSections, on the shapes a real article body takes', () => {
  it('counts words from trimmed text, not from the padding around it', () => {
    // Untrimmed, `split(/\s+/)` yields a leading and a trailing empty string, so the
    // count comes out two too high on any indented body.
    expect(parseSections('<p>  hello world  </p>')[0]?.wordCount).toBe(2);
  });

  it('trims the heading text, which Zendesk stores with the editor whitespace', () => {
    expect(parseSections('<h2>  Getting started  </h2><p>body</p>')[0]?.heading).toBe(
      'Getting started',
    );
  });

  it('treats a bare text node at the root as intro content', () => {
    // A bare text node has no `name`, so the tag test is all that stands between it and
    // `undefined.toLowerCase()`.
    const sections = parseSections('lead<h2>T</h2>body');
    expect(sections.map((s) => [s.heading, s.html])).toEqual([
      ['intro', 'lead'],
      ['T', 'body'],
    ]);
  });

  it('joins a multi-node intro and a multi-node section without a separator', () => {
    // A single-node fixture cannot see a separator, and one would land inside the
    // rendered article.
    const sections = parseSections('<p>a</p><p>b</p><h2>T</h2><p>c</p><p>d</p>');
    expect(sections.map((s) => s.html)).toEqual(['<p>a</p><p>b</p>', '<p>c</p><p>d</p>']);
  });

  it('returns nothing for a body Zendesk reported as absent', () => {
    // `body` is typed `string` but arrives from the API, which is what the `?.` guards.
    expect(parseSections(undefined as never)).toEqual([]);
  });
});

describe('htmlToMarkdown, on the syntax choices the processor is configured for', () => {
  it('writes list bullets as hyphens, not the default asterisk', () => {
    expect(htmlToMarkdown('<ul><li>a</li><li>b</li></ul>')).toMatchInlineSnapshot(`
      "- a
      - b
      "
    `);
  });

  it('writes emphasis with underscores, not the default asterisk', () => {
    // Asterisks collide with bold and with list bullets when the text is edited after.
    expect(htmlToMarkdown('<p>x <em>y</em> z</p>')).toMatchInlineSnapshot(`
      "x _y_ z
      "
    `);
  });

  it('leaves a <pre> as raw HTML rather than turning it into a code block', () => {
    // `keepAsHtml` handles `pre`, because markdown would collapse an inline `<br>`
    // inside it onto one line.
    expect(htmlToMarkdown('<pre><code>x = 1</code></pre>')).toMatchInlineSnapshot(`
      "<pre><code>x = 1</code></pre>
      "
    `);
  });

  it('parses the input as a fragment, so a stray table row keeps its cells', () => {
    // Parsed as a document, the HTML parser drops a `<tr>` with no `<table>` around it
    // and the cells collapse into loose text -- silent loss on a section cut mid-table.
    expect(htmlToMarkdown('<tr><td>c</td></tr>')).toMatchInlineSnapshot(`
      "| c |
      "
    `);
  });
});
