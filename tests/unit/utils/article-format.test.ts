import { describe, expect, it } from 'vitest';
import { loadArticleFormat, memoisedUntilFailure } from '../../../src/utils/article-format';

describe('memoisedUntilFailure', () => {
  it('loads once while the load succeeds', async () => {
    let calls = 0;
    const load = memoisedUntilFailure(async () => {
      calls += 1;
      return calls;
    });

    expect(await load()).toBe(1);
    expect(await load()).toBe(1);
    expect(calls).toBe(1);
  });

  it('retries on the next call after a failed load, instead of keeping the failure', async () => {
    let calls = 0;
    const load = memoisedUntilFailure(async () => {
      calls += 1;
      if (calls === 1) throw new Error('EMFILE');
      return calls;
    });

    await expect(load()).rejects.toThrow('EMFILE');
    expect(await load()).toBe(2);
    expect(await load()).toBe(2);
  });
});

describe('loadArticleFormat', () => {
  it('loads the article pipeline', async () => {
    const format = await loadArticleFormat();

    expect(typeof format.htmlToMarkdown).toBe('function');
    expect(await loadArticleFormat()).toBe(format);
  });
});
