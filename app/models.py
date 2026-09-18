"""课时本 LessonDesk - 数据模型"""
from datetime import datetime, timedelta
from flask_sqlalchemy import SQLAlchemy
from flask_login import UserMixin
from werkzeug.security import generate_password_hash, check_password_hash

db = SQLAlchemy()


def bj_now():
    return datetime.utcnow() + timedelta(hours=8)


def bj_today():
    return (datetime.utcnow() + timedelta(hours=8)).date()


class Campus(db.Model):
    __tablename__ = 'campus'
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), unique=True, nullable=False)
    code = db.Column(db.String(20), unique=True, nullable=False)
    display_name = db.Column(db.String(100))
    logo_path = db.Column(db.String(200))
    qr_path = db.Column(db.String(200))
    remarks = db.Column(db.Text)
    is_active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=bj_now)
    users = db.relationship('User', backref='campus', lazy=True)
    courses = db.relationship('Course', backref='campus', lazy=True)
    class_groups = db.relationship('ClassGroup', backref='campus', lazy=True)
    students = db.relationship('Student', backref='campus', lazy=True)

    def student_count(self):
        return Student.query.filter_by(campus_id=self.id, status='active').count()

    def class_count(self):
        return ClassGroup.query.filter_by(campus_id=self.id, is_archived=False).count()

    def pending_reg_count(self):
        return Registration.query.filter_by(campus_id=self.id, status='pending').count()


class User(UserMixin, db.Model):
    __tablename__ = 'user'
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(50), unique=True, nullable=False)
    password_hash = db.Column(db.String(200), nullable=False)
    role = db.Column(db.String(20), nullable=False)  # super_admin | manager | teacher
    campus_id = db.Column(db.Integer, db.ForeignKey('campus.id'), nullable=True)
    is_active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=bj_now)

    def set_password(self, pw):
        self.password_hash = generate_password_hash(pw)

    def check_password(self, pw):
        return check_password_hash(self.password_hash, pw)

    @property
    def role_name(self):
        return {'super_admin': '系统管理员', 'manager': '校区管理员', 'teacher': '教师'}.get(self.role, self.role)


class Course(db.Model):
    __tablename__ = 'course'
    id = db.Column(db.Integer, primary_key=True)
    campus_id = db.Column(db.Integer, db.ForeignKey('campus.id'), nullable=False)
    name = db.Column(db.String(100), nullable=False)
    category = db.Column(db.String(30), default='其他')
    is_archived = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=bj_now)
    class_groups = db.relationship('ClassGroup', backref='course', lazy=True)


class ClassGroup(db.Model):
    __tablename__ = 'class_group'
    id = db.Column(db.Integer, primary_key=True)
    campus_id = db.Column(db.Integer, db.ForeignKey('campus.id'), nullable=False)
    course_id = db.Column(db.Integer, db.ForeignKey('course.id'), nullable=False)
    name = db.Column(db.String(100), nullable=False)
    teacher_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=True)
    weekday = db.Column(db.String(10), nullable=False)      # 周一..周日
    start_time = db.Column(db.String(5), nullable=False)     # 09:00
    end_time = db.Column(db.String(5), nullable=False)
    room = db.Column(db.String(50), default='')
    capacity = db.Column(db.Integer, default=0)              # 0=不限
    deduct_lessons = db.Column(db.Integer, default=1)        # 每次点名扣除课时数（活动课可设 2/3）
    allow_override = db.Column(db.Boolean, default=False)
    override_extra = db.Column(db.Integer, default=0)
    is_archived = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=bj_now)
    teacher = db.relationship('User', foreign_keys=[teacher_id])
    enrollments = db.relationship('Enrollment', backref='class_group', lazy=True)
    lesson_records = db.relationship('LessonRecord', backref='class_group', lazy=True)

    def effective_capacity(self):
        if not self.capacity:
            return None
        return self.capacity + (self.override_extra if self.allow_override else 0)

    def active_enroll_count(self):
        return Enrollment.query.filter_by(class_group_id=self.id, status='active').count()

    def pending_count(self):
        return Registration.query.filter_by(class_group_id=self.id, status='pending').count()

    def occupied_count(self):
        return self.active_enroll_count() + self.pending_count()

    def is_full(self):
        cap = self.effective_capacity()
        return cap is not None and self.occupied_count() >= cap

    @property
    def time_label(self):
        return f'{self.weekday} {self.start_time}-{self.end_time}'


class Student(db.Model):
    __tablename__ = 'student'
    id = db.Column(db.Integer, primary_key=True)
    campus_id = db.Column(db.Integer, db.ForeignKey('campus.id'), nullable=False)
    name = db.Column(db.String(50), nullable=False)
    gender = db.Column(db.String(10), default='')
    parent_name = db.Column(db.String(50), default='')
    phone = db.Column(db.String(20), nullable=False)
    birthday = db.Column(db.Date, nullable=True)
    grade = db.Column(db.String(50), default='')
    remarks = db.Column(db.Text, default='')
    status = db.Column(db.String(20), default='active')  # active|trial|archived
    source = db.Column(db.String(20), default='manual')  # manual|registration
    registration_id = db.Column(db.Integer, nullable=True)
    lessons_remaining = db.Column(db.Integer, default=0)  # 当前剩余总课时（简化模式）
    created_at = db.Column(db.DateTime, default=bj_now)
    __table_args__ = (db.UniqueConstraint('campus_id', 'phone', name='uq_campus_phone'),)
    enrollments = db.relationship('Enrollment', backref='student', lazy=True,
                                  primaryjoin="Enrollment.student_id==Student.id",
                                  foreign_keys='Enrollment.student_id')

    def active_enrollments(self):
        return [e for e in self.enrollments if e.status == 'active']

    def total_remaining(self):
        return self.lessons_remaining or 0

    def active_class_names(self):
        return '、'.join(e.class_group.name for e in self.active_enrollments())


class Enrollment(db.Model):
    __tablename__ = 'enrollment'
    id = db.Column(db.Integer, primary_key=True)
    campus_id = db.Column(db.Integer, db.ForeignKey('campus.id'), nullable=False)
    student_id = db.Column(db.Integer, db.ForeignKey('student.id'), nullable=False)
    class_group_id = db.Column(db.Integer, db.ForeignKey('class_group.id'), nullable=False)
    status = db.Column(db.String(20), default='active')  # active|left
    joined_at = db.Column(db.DateTime, default=bj_now)
    left_at = db.Column(db.DateTime, nullable=True)
    created_at = db.Column(db.DateTime, default=bj_now)
    __table_args__ = (db.UniqueConstraint('student_id', 'class_group_id', name='uq_enroll_pair'),)


class CampusExpense(db.Model):
    __tablename__ = 'campus_expense'
    id = db.Column(db.Integer, primary_key=True)
    campus_id = db.Column(db.Integer, db.ForeignKey('campus.id'), nullable=False)
    category = db.Column(db.String(20), nullable=False)
    amount_cents = db.Column(db.Integer, nullable=False)
    remarks = db.Column(db.Text, default='')
    operator_id = db.Column(db.Integer, db.ForeignKey('user.id'))
    created_at = db.Column(db.DateTime, default=bj_now)
    campus = db.relationship('Campus')
    # 财务流水页要显示经办人；缺这个 relationship 会让 /finance 500（有支出记录时）
    operator = db.relationship('User', backref='handled_expenses')


class PaymentRecord(db.Model):
    __tablename__ = 'payment_record'
    id = db.Column(db.Integer, primary_key=True)
    campus_id = db.Column(db.Integer, db.ForeignKey('campus.id'), nullable=False)
    student_id = db.Column(db.Integer, db.ForeignKey('student.id'), nullable=False)
    contract_id = db.Column(db.Integer, nullable=True)  # 废弃保留列
    type = db.Column(db.String(20), nullable=False)  # charge|adjust
    amount_cents = db.Column(db.Integer, default=0)  # 金额备注（仅展示，不参与计算）
    lessons_delta = db.Column(db.Integer, default=0)  # 购买/调整课时数（正=加 负=减）
    lessons_bonus = db.Column(db.Integer, default=0)  # 赠课数（仅交费时）
    operator_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=True)
    remarks = db.Column(db.Text, default='')
    created_at = db.Column(db.DateTime, default=bj_now)
    student = db.relationship('Student', backref='payments')
    operator = db.relationship('User', backref='handled_payments')


class LessonRecord(db.Model):
    __tablename__ = 'lesson_record'
    id = db.Column(db.Integer, primary_key=True)
    campus_id = db.Column(db.Integer, db.ForeignKey('campus.id'), nullable=False)
    class_group_id = db.Column(db.Integer, db.ForeignKey('class_group.id'), nullable=False)
    student_id = db.Column(db.Integer, db.ForeignKey('student.id'), nullable=False)
    contract_id = db.Column(db.Integer, nullable=True)  # 废弃保留列
    teacher_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    date = db.Column(db.DateTime, default=bj_now)
    duration_minutes = db.Column(db.Integer, default=60)
    status = db.Column(db.String(20), default='present')  # present|leave|absent_refund|absent_deduct
    deducted_lessons = db.Column(db.Integer, default=1)
    revoked_at = db.Column(db.DateTime, nullable=True)
    created_at = db.Column(db.DateTime, default=bj_now)
    student = db.relationship('Student', backref='lesson_records')
    teacher = db.relationship('User', backref='lesson_records')


class RegistrationEntry(db.Model):
    __tablename__ = 'registration_entry'
    id = db.Column(db.Integer, primary_key=True)
    campus_id = db.Column(db.Integer, db.ForeignKey('campus.id'), nullable=False)
    name = db.Column(db.String(100), nullable=False)
    token = db.Column(db.String(32), unique=True, nullable=False, index=True)
    enabled = db.Column(db.Boolean, default=True)
    deadline = db.Column(db.DateTime, nullable=True)
    contact = db.Column(db.Text, default='')
    qr_path = db.Column(db.String(200))
    created_by = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    created_at = db.Column(db.DateTime, default=bj_now)
    campus = db.relationship('Campus', backref='registration_entries')
    registrations = db.relationship('Registration', backref='entry', lazy=True)

    def is_open(self, now=None):
        now = now or bj_now()
        return self.enabled and (self.deadline is None or now <= self.deadline)


class Registration(db.Model):
    __tablename__ = 'registration'
    id = db.Column(db.Integer, primary_key=True)
    entry_id = db.Column(db.Integer, db.ForeignKey('registration_entry.id'), nullable=False)
    campus_id = db.Column(db.Integer, db.ForeignKey('campus.id'), nullable=False)
    class_group_id = db.Column(db.Integer, db.ForeignKey('class_group.id'), nullable=False)
    student_name = db.Column(db.String(50), nullable=False)
    grade = db.Column(db.String(50), default='')
    guardian_name = db.Column(db.String(50), default='')
    guardian_phone = db.Column(db.String(20), default='')
    phone_last4 = db.Column(db.String(4), nullable=False)
    status = db.Column(db.String(20), default='pending')  # pending|confirmed|cancelled
    modify_code_hash = db.Column(db.String(200))
    modify_uses = db.Column(db.Integer, default=0)
    note = db.Column(db.Text, default='')
    created_at = db.Column(db.DateTime, default=bj_now)
    updated_at = db.Column(db.DateTime, default=bj_now)
    class_group = db.relationship('ClassGroup', backref='registrations')
    __table_args__ = (db.UniqueConstraint('entry_id', 'student_name', 'grade', 'phone_last4',
                                          name='uq_reg_unique'),)


class RegistrationHistory(db.Model):
    __tablename__ = 'registration_history'
    id = db.Column(db.Integer, primary_key=True)
    registration_id = db.Column(db.Integer, db.ForeignKey('registration.id'), nullable=False)
    action = db.Column(db.String(20), nullable=False)
    from_class_group_id = db.Column(db.Integer)
    to_class_group_id = db.Column(db.Integer)
    note = db.Column(db.Text, default='')
    created_at = db.Column(db.DateTime, default=bj_now)
    registration = db.relationship('Registration', backref='history')


class OperationLog(db.Model):
    __tablename__ = 'operation_log'
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=True)
    action_time = db.Column(db.DateTime, default=bj_now)
    target = db.Column(db.String(50))
    target_id = db.Column(db.Integer)
    action = db.Column(db.String(100))
    detail = db.Column(db.Text, default='')
    user = db.relationship('User')


class SystemConfig(db.Model):
    __tablename__ = 'system_config'
    id = db.Column(db.Integer, primary_key=True)
    site_name = db.Column(db.String(100), default='课时本')
    logo_path = db.Column(db.String(200))        # 品牌 logo（侧栏/登录卡）
    login_bg_path = db.Column(db.String(200))    # 登录页封面
    updated_at = db.Column(db.DateTime, default=bj_now)


class RateLimit(db.Model):
    __tablename__ = 'rate_limit'
    bucket = db.Column(db.String(50), primary_key=True)
    ip = db.Column(db.String(64), primary_key=True)
    cnt = db.Column(db.Integer, default=1)
    window_start = db.Column(db.Integer, nullable=False)
