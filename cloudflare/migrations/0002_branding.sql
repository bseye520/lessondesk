-- Additive migration. Safe for existing production D1: no ALTER of existing balances or records.
CREATE TABLE IF NOT EXISTS campus_brand (
 campus_id INTEGER PRIMARY KEY REFERENCES campus(id),
 studio_name TEXT NOT NULL DEFAULT '',
 slogan TEXT NOT NULL DEFAULT '',
 address TEXT NOT NULL DEFAULT '',
 contact TEXT NOT NULL DEFAULT '',
 logo_key TEXT,
 qr_key TEXT,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS account_profile (
 user_id INTEGER PRIMARY KEY REFERENCES user(id),
 avatar_key TEXT,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_class_teacher ON class_group(teacher_id,is_archived,weekday);
CREATE INDEX IF NOT EXISTS idx_quick_deduct_day ON quick_deduct(local_day,class_group_id);
