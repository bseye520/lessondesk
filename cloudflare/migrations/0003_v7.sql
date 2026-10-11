-- V7: additive only; no destructive changes to existing business balances.
ALTER TABLE lesson_record ADD COLUMN lesson_date TEXT;
ALTER TABLE lesson_record ADD COLUMN actor_id INTEGER REFERENCES user(id);
ALTER TABLE lesson_record ADD COLUMN reason TEXT DEFAULT '';
UPDATE lesson_record SET lesson_date = date(date, '+8 hours') WHERE lesson_date IS NULL;
UPDATE lesson_record SET actor_id = teacher_id WHERE actor_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_lesson_local_date ON lesson_record(lesson_date,campus_id,revoked_at);
CREATE TABLE IF NOT EXISTS refund_record (
 id INTEGER PRIMARY KEY, campus_id INTEGER NOT NULL REFERENCES campus(id),
 student_id INTEGER NOT NULL REFERENCES student(id), amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),
 lessons_debited INTEGER NOT NULL DEFAULT 0 CHECK(lessons_debited>=0),
 reason TEXT NOT NULL, operator_id INTEGER NOT NULL REFERENCES user(id),
 nonce TEXT NOT NULL UNIQUE, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_refund_campus_time ON refund_record(campus_id,created_at);
CREATE TABLE IF NOT EXISTS enrollment_event (
 id INTEGER PRIMARY KEY, campus_id INTEGER NOT NULL REFERENCES campus(id),student_id INTEGER NOT NULL REFERENCES student(id),
 class_group_id INTEGER NOT NULL REFERENCES class_group(id),action TEXT NOT NULL CHECK(action IN ('join','leave')),
 operator_id INTEGER REFERENCES user(id),created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS data_contract (id INTEGER PRIMARY KEY CHECK(id=1),major INTEGER NOT NULL,minor INTEGER NOT NULL,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
INSERT INTO data_contract(id,major,minor) VALUES(1,7,0) ON CONFLICT(id) DO UPDATE SET major=7,minor=0,updated_at=CURRENT_TIMESTAMP;
-- Existing quick_deduct remains a once-per-student/class/day shortcut guard.
-- Additional lessons same day must use manual workflow with a unique nonce.
CREATE TRIGGER IF NOT EXISTS guard_enrollment_campus_insert BEFORE INSERT ON enrollment
WHEN (SELECT campus_id FROM student WHERE id=NEW.student_id)!=NEW.campus_id OR
 (SELECT campus_id FROM class_group WHERE id=NEW.class_group_id)!=NEW.campus_id
BEGIN SELECT RAISE(ABORT,'ENROLLMENT_CAMPUS_MISMATCH'); END;
CREATE TRIGGER IF NOT EXISTS guard_enrollment_campus_update BEFORE UPDATE OF campus_id,student_id,class_group_id ON enrollment
WHEN (SELECT campus_id FROM student WHERE id=NEW.student_id)!=NEW.campus_id OR
 (SELECT campus_id FROM class_group WHERE id=NEW.class_group_id)!=NEW.campus_id
BEGIN SELECT RAISE(ABORT,'ENROLLMENT_CAMPUS_MISMATCH'); END;
CREATE TRIGGER IF NOT EXISTS guard_class_capacity_update BEFORE UPDATE OF capacity,allow_override,override_extra ON class_group
WHEN NEW.capacity>0 AND (SELECT enabled FROM migration_control WHERE id=1)=0
AND (SELECT COUNT(*) FROM enrollment WHERE class_group_id=NEW.id AND status='active')
 + (SELECT COUNT(*) FROM registration WHERE class_group_id=NEW.id AND status='pending')
 > NEW.capacity + CASE WHEN NEW.allow_override=1 THEN NEW.override_extra ELSE 0 END
BEGIN SELECT RAISE(ABORT,'CLASS_RESERVED_CAPACITY'); END;
