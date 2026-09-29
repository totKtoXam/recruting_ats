-- Realtime-обновления доски: любая запись в candidates / candidate_resumes шлёт
-- NOTIFY с id кандидата (без персональных данных). Сервер слушает канал и раздаёт
-- события браузерам по SSE (server/services/realtime.js).
CREATE OR REPLACE FUNCTION notify_candidate_change() RETURNS trigger AS $$
DECLARE
  candidate uuid;
BEGIN
  IF TG_TABLE_NAME = 'candidates' THEN
    candidate := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    candidate := CASE WHEN TG_OP = 'DELETE' THEN OLD.candidate_id ELSE NEW.candidate_id END;
  END IF;

  PERFORM pg_notify('ats_candidate', json_build_object('id', candidate, 'op', lower(TG_OP))::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER candidates_notify
  AFTER INSERT OR UPDATE OR DELETE ON candidates
  FOR EACH ROW EXECUTE FUNCTION notify_candidate_change();

CREATE TRIGGER candidate_resumes_notify
  AFTER INSERT OR UPDATE OR DELETE ON candidate_resumes
  FOR EACH ROW EXECUTE FUNCTION notify_candidate_change();
