type ArticleFormat = typeof import('./article-sections');

let loading: Promise<ArticleFormat> | undefined;

/**
 * The HTML <-> Markdown pipeline (cheerio, unified, remark, rehype), loaded by
 * the first call that converts an article rather than by every start: most
 * processes never touch an article, and it is the heaviest code in the bundle.
 * `tests/unit/module-graph.test.ts` keeps it off the static graph.
 */
export const loadArticleFormat = (): Promise<ArticleFormat> => {
  loading ??= import('./article-sections');
  return loading;
};
