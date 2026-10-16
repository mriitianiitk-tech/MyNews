CREATE TABLE IF NOT EXISTS query_articles (
  query_id TEXT NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  matched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (query_id, article_id)
);
CREATE INDEX IF NOT EXISTS idx_query_articles_user ON query_articles(user_id, query_id, matched_at DESC);
