-- Вложения к вопросам шаблонов и к ответам интервью. Файл загружается до сохранения формы,
-- поэтому у вложения есть отметка linked_at: её ставит первое сохранение, которое на файл
-- сослалось. Неиспользованные вложения (linked_at IS NULL) периодически удаляются.
ALTER TABLE files
  ADD COLUMN purpose     text NOT NULL DEFAULT 'resume' CHECK (purpose IN ('resume', 'attachment')),
  ADD COLUMN linked_at   timestamptz,
  ADD COLUMN uploaded_by uuid REFERENCES users (id);

CREATE INDEX files_unlinked_attachments_idx ON files (created_at)
  WHERE purpose = 'attachment' AND linked_at IS NULL;
