"""核心业务规则服务：占座、报名原子提交等（唯一实现处）"""
from sqlalchemy import text

from .models import (db, Enrollment, Registration, Student, ClassGroup)


def occupy_components(cg_id):
    """返回 (active_enroll_count, pending_reg_count)"""
    active = Enrollment.query.filter_by(class_group_id=cg_id, status='active').count()
    pending = Registration.query.filter_by(class_group_id=cg_id, status='pending').count()
    return active, pending


def is_full(cg: ClassGroup):
    cap = cg.effective_capacity()
    if cap is None:
        return False
    a, p = occupy_components(cg.id)
    return (a + p) >= cap


def remaining_slots(cg: ClassGroup):
    cap = cg.effective_capacity()
    if cap is None:
        return None
    a, p = occupy_components(cg.id)
    return max(0, cap - (a + p))


def can_occupy(cg: ClassGroup):
    """原子占座校验+占座（写事务内调用；配合 BEGIN IMMEDIATE）"""
    return not is_full(cg)


def begin_immediate():
    """SQLite 立即写锁（多线程下防读改写竞态）"""
    db.session.execute(text('BEGIN IMMEDIATE'))


def enroll_or_reactivate(student_id, class_group_id, campus_id=None):
    """入班（加固 2026-09-17）：已存在的记录直接复用，不重复 INSERT。

    为什么要这个：enrollment 上有 UNIQUE(student_id, class_group_id)，
    但退班只是把 status 改成 'left' 而不是删行。所以"退班→再加同一个班"
    会撞唯一约束 → sqlalchemy IntegrityError → 未捕获时直接把 gunicorn
    worker 打挂（实测 2026-09-13 08:37 崩过一次，表现为"页面开小差"）。

    返回 (result, enrollment)：
      'active'     —— 已经在该班（调用方提示即可）
      'created'    —— 新建了记录
      'reactivated'—— 复用旧记录并改回 active
    """
    from .models import bj_now
    e = Enrollment.query.filter_by(student_id=student_id,
                                   class_group_id=class_group_id).first()
    if e is not None:
        if e.status == 'active':
            return 'active', e
        e.status = 'active'
        e.left_at = None
        e.joined_at = bj_now()
        if campus_id:
            e.campus_id = campus_id
        return 'reactivated', e
    e = Enrollment(campus_id=campus_id, student_id=student_id,
                   class_group_id=class_group_id, status='active')
    db.session.add(e)
    return 'created', e


def guard_student_paid(student: Student):
    """学生有无资金痕迹（供删除判断）"""
    from .models import PaymentRecord, LessonRecord
    if PaymentRecord.query.filter_by(student_id=student.id).first():
        return True
    if LessonRecord.query.filter_by(student_id=student.id).first():
        return True
    return False
