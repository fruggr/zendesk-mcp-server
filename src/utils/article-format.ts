type ArticleFormat = typeof import('./article-sections');

/**
 * `load`, run once and shared while it succeeds. A failed load is forgotten so
 * the next call tries again: one transient error (EMFILE) must not disable
 * every later article call of a long-lived process.
 */
export const memoisedUntilFailure = <T>(load: () => Promise<T>): (() => Promise<T>) => {
  let loading: Promise<T> | undefined;
  return () => {
    loading ??= load().catch((err: unknown) => {
      loading = undefined;
      throw err;
    });
    return loading;
  };
};

/**
 * The HTML <-> Markdown pipeline (cheerio, unified, remark, rehype), loaded by
 * the first call that converts an article rather than by every start: most
 * processes never touch an article, and it is the heaviest code in the bundle.
 * `tests/unit/module-graph.test.ts` keeps it off the static graph.
 */
export const loadArticleFormat: () => Promise<ArticleFormat> = memoisedUntilFailure(
  () => import('./article-sections'),
);
