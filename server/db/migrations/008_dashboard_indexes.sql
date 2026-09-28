-- 008: индексы для главной страницы — выборки за период и лента последних событий.
-- Таблицы небольшие, обычный CREATE INDEX накатывается мгновенно.
CREATE INDEX IF NOT EXISTS candidates_created_idx ON candidates (created_at DESC);
CREATE INDEX IF NOT EXISTS candidate_status_log_created_idx ON candidate_status_log (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);
