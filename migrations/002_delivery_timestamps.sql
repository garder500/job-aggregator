ALTER TABLE notifications ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
