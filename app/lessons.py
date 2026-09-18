"""课时：教师首页/点名消课/记录时间线"""
from flask import (Blueprint, render_template, request, redirect, url_for,
                   flash, abort)
from flask_login import current_user

from .models import (db, ClassGroup, Enrollment, Student, LessonRecord, bj_now)
from .decorators import roles, login_required
from .utils import log_op, weekday_list

bp = Blueprint('lessons', __name__)

STATUS_CN = {'present': '出勤', 'leave': '请假(不扣)', 'absent_refund': '缺勤(退课时)',
             'absent_deduct': '缺勤(扣课时)'}
DEDUCT_MAP = {'present': True, 'leave': False, 'absent_refund': False,
              'absent_deduct': True}


def _scope():
    return None if current_user.role == 'super_admin' else current_user.campus_id


def _teacher_group_ids():
    return [g.id for g in ClassGroup.query.filter_by(teacher_id=current_user.id).all()]


@bp.route('/me')
@login_required
def my_home():
    """教师首页"""
    if current_user.role != 'teacher':
        return redirect(url_for('index'))
    today_wd = weekday_list()[bj_now().weekday()]
    groups = ClassGroup.query.filter_by(teacher_id=current_user.id,
                                        is_archived=False).all()
    recent = LessonRecord.query.filter_by(teacher_id=current_user.id).order_by(
        LessonRecord.date.desc()).limit(10).all()
    return render_template('teacher_home.html', groups=groups, today_wd=today_wd,
                           recent=recent)


@bp.route('/attendance/<int:gid>')
@roles('manager', 'teacher', 'super_admin')
def attendance(gid):
    cg = db.session.get(ClassGroup, gid)
    s = _scope()
    if not cg:
        abort(404)
    if s and cg.campus_id != s:
        abort(403, description=f'「{cg.name}」属于其他校区，你不是那个校区的人。')
    if current_user.role == 'teacher' and cg.teacher_id != current_user.id:
        abort(403, description=(f'「{cg.name}」的任教老师不是你。教师只能对自己任教的班做考勤；'
                                f'若这一班应交给你，请让校区管理员在「班次管理」里把任教老师改成你。'))
    students = [e.student for e in cg.enrollments if e.status == 'active'
                and e.student.status != 'archived']
    data = []
    for st in students:
        data.append({'student': st,
                     'remaining': st.lessons_remaining or 0,
                     'enough': (st.lessons_remaining or 0) >= (cg.deduct_lessons or 1)})
    return render_template('attendance.html', cg=cg, data=data)


@bp.route('/lessons/batch', methods=['POST'])
@roles('manager', 'teacher', 'super_admin')
def batch():
    gid = request.form.get('class_group_id', type=int)
    cg = db.session.get(ClassGroup, gid)
    s = _scope()
    if not cg:
        abort(404)
    if s and cg.campus_id != s:
        abort(403, description=f'「{cg.name}」属于其他校区，你不是那个校区的人。')
    if current_user.role == 'teacher' and cg.teacher_id != current_user.id:
        abort(403, description=(f'「{cg.name}」的任教老师不是你，不能给这一班消课。'
                                f'若应交给你，请让校区管理员改「班次管理 → 任教老师」。'))
    duration = request.form.get('duration', type=int) or 60
    deduct_n = cg.deduct_lessons or 1  # 本次每次扣课数（班次设置，活动课可 >1）
    st_ids = request.form.getlist('student_ids', type=int)
    if not st_ids:
        flash('请至少选择一名学员', 'warning')
        return redirect(url_for('lessons.attendance', gid=gid))
    # 单事务（单 worker 已串行；仍防异常）
    done, skipped = [], []
    try:
        for sid in st_ids:
            st = db.session.get(Student, sid)
            if not st or st.campus_id != cg.campus_id:
                continue
            status = request.form.get(f'status_{sid}') or 'present'
            if status not in DEDUCT_MAP:
                status = 'present'
            deduct = DEDUCT_MAP[status]
            deducted = 0
            if deduct:
                if (st.lessons_remaining or 0) < deduct_n:
                    skipped.append((st.name, f'课时不足（余 {st.lessons_remaining or 0} 节）'))
                    continue
                st.lessons_remaining = (st.lessons_remaining or 0) - deduct_n
                deducted = deduct_n
            rec = LessonRecord(campus_id=cg.campus_id, class_group_id=cg.id,
                               student_id=st.id, contract_id=None,
                               teacher_id=current_user.id, duration_minutes=duration,
                               status=status, deducted_lessons=deducted)
            db.session.add(rec)
            done.append(st.name)
        log_op(current_user.id, 'lesson_record', cg.id, 'batch',
               f'{cg.name} {len(done)}人 {" ".join(done[:10])}')
        db.session.commit()
    except Exception as e:
        import logging
        logging.getLogger(__name__).error('batch fail: %s', e, exc_info=True)
        db.session.rollback()
        flash(f'消课失败：{e}', 'danger')
        return redirect(url_for('lessons.attendance', gid=gid))
    msg = f'已记录 {len(done)} 人（每人扣 {deduct_n} 节）'
    if skipped:
        msg += '；跳过：' + '、'.join(f'{n}({r})' for n, r in skipped)
    flash(msg, 'success' if not skipped else 'warning')
    return redirect(url_for('lessons.records'))


@bp.route('/lessons')
@roles('manager', 'teacher', 'super_admin')
def records():
    s = _scope()
    q = LessonRecord.query
    if s:
        q = q.filter_by(campus_id=s)
    if current_user.role == 'teacher':
        q = q.filter_by(teacher_id=current_user.id)
    cg_id = request.args.get('class_group_id', type=int)
    if cg_id:
        q = q.filter_by(class_group_id=cg_id)
    date_str = request.args.get('date') or ''
    records = q.order_by(LessonRecord.date.desc()).limit(300).all()
    groups = ClassGroup.query.filter_by(is_archived=False).all()
    if s:
        groups = [g for g in groups if g.campus_id == s]
    return render_template('lessons.html', records=records, groups=groups,
                           cg_id=cg_id, STATUS_CN=STATUS_CN,
                           now=bj_now())
