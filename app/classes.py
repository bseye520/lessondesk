"""班次管理：列表/新建/编辑/归档/入班（入班走占座校验）"""
from flask import (Blueprint, render_template, request, redirect, url_for,
                   flash)
from flask_login import current_user

from .models import db, Campus, Course, ClassGroup, User, Student, Enrollment
from .decorators import roles
from .utils import log_op, weekday_list
from .services import is_full, enroll_or_reactivate
from . import audit
from sqlalchemy.exc import IntegrityError

bp = Blueprint('classes', __name__)


def _scope():
    return None if current_user.role == 'super_admin' else current_user.campus_id


def _teachers():
    q = User.query.filter(User.role == 'teacher', User.is_active == True)
    s = _scope()
    if s:
        q = q.filter_by(campus_id=s)
    return q.order_by(User.id).all()


@bp.route('/classes')
@roles('manager', 'super_admin')
def list_cg():
    s = _scope()
    q = ClassGroup.query
    if s:
        q = q.filter_by(campus_id=s)
    cid = request.args.get('campus_id', type=int)
    if current_user.role == 'super_admin' and cid:
        q = q.filter_by(campus_id=cid)
    course_id = request.args.get('course_id', type=int)
    if course_id:
        q = q.filter_by(course_id=course_id)
    if request.args.get('archived') != '1':
        q = q.filter_by(is_archived=False)
    groups = q.order_by(ClassGroup.weekday, ClassGroup.start_time, ClassGroup.id).all()
    courses = Course.query.order_by(Course.id).all() if not s else \
        Course.query.filter_by(campus_id=s).all()
    campuses = Campus.query.all() if current_user.role == 'super_admin' else []
    from .models import Student
    sq = Student.query.filter(Student.status != 'archived')
    if s:
        sq = sq.filter_by(campus_id=s)
    all_students = sq.order_by(Student.name).all()
    return render_template('classes.html', groups=groups, courses=courses,
                           campuses=campuses, cid=cid, course_id=course_id,
                           teachers=_teachers(), all_students=all_students)


@bp.route('/classes/new', methods=['POST'])
@roles('manager', 'super_admin')
def create_cg():
    s = _scope() or request.form.get('campus_id', type=int)
    name = (request.form.get('name') or '').strip()
    course_id = request.form.get('course_id', type=int)
    teacher_id = request.form.get('teacher_id', type=int) or None
    weekday = request.form.get('weekday') or '周六'
    start_time = (request.form.get('start_time') or '09:00').strip()
    end_time = (request.form.get('end_time') or '10:30').strip()
    room = (request.form.get('room') or '').strip()
    capacity = request.form.get('capacity', type=int) or 0
    deduct_lessons = request.form.get('deduct_lessons', type=int) or 1
    if not db.session.get(Campus, s):
        flash('校区无效', 'danger')
    elif not name or not db.session.get(Course, course_id):
        flash('班次名称与课程必填', 'danger')
    elif weekday not in weekday_list():
        flash('星期不合法', 'danger')
    else:
        cg = ClassGroup(campus_id=s, course_id=course_id, name=name,
                        teacher_id=teacher_id, weekday=weekday,
                        start_time=start_time, end_time=end_time, room=room,
                        capacity=max(0, capacity),
                        deduct_lessons=max(1, deduct_lessons))
        db.session.add(cg)
        db.session.flush()
        log_op(current_user.id, 'class_group', cg.id, 'create', name)
        db.session.commit()
        flash(f'班次「{name}」已创建', 'success')
    return redirect(url_for('classes.list_cg'))


@bp.route('/classes/<int:gid>/update', methods=['POST'])
@roles('manager', 'super_admin')
def update_cg(gid):
    cg = db.session.get(ClassGroup, gid)
    s = _scope()
    if not cg or (s and cg.campus_id != s):
        flash('班次不存在或无权操作', 'danger')
    else:
        cg.name = (request.form.get('name') or cg.name).strip()
        cg.course_id = request.form.get('course_id', type=int) or cg.course_id
        cg.teacher_id = request.form.get('teacher_id', type=int) or None
        cg.weekday = request.form.get('weekday') or cg.weekday
        cg.start_time = request.form.get('start_time') or cg.start_time
        cg.end_time = request.form.get('end_time') or cg.end_time
        cg.room = (request.form.get('room') or '').strip()
        cg.capacity = request.form.get('capacity', type=int) if request.form.get('capacity') not in (None, '') else cg.capacity
        dl = request.form.get('deduct_lessons', type=int)
        if dl and dl > 0:
            cg.deduct_lessons = dl
        cg.allow_override = bool(request.form.get('allow_override'))
        cg.override_extra = request.form.get('override_extra', type=int) or 0
        log_op(current_user.id, 'class_group', cg.id, 'update', cg.name)
        db.session.commit()
        flash('班次已更新', 'success')
    return redirect(url_for('classes.list_cg'))


@bp.route('/classes/<int:gid>/archive', methods=['POST'])
@roles('super_admin')
def archive_cg(gid):
    cg = db.session.get(ClassGroup, gid)
    s = _scope()
    if not cg or (s and cg.campus_id != s):
        flash('班次不存在或无权操作', 'danger')
    else:
        cg.is_archived = not cg.is_archived
        log_op(current_user.id, 'class_group', cg.id, 'toggle_archive')
        db.session.commit()
        flash(f'班次「{cg.name}」已{"归档" if cg.is_archived else "恢复"}', 'success')
    return redirect(url_for('classes.list_cg'))


@bp.route('/classes/<int:gid>/enroll', methods=['POST'])
@roles('manager', 'super_admin')
def enroll_student(gid):
    """手动加学员入班（走占座校验，防超员）"""
    cg = db.session.get(ClassGroup, gid)
    s = _scope()
    if not cg or (s and cg.campus_id != s):
        flash('班次不存在或无权操作', 'danger')
        return redirect(url_for('classes.list_cg'))
    student_id = request.form.get('student_id', type=int)
    st = db.session.get(Student, student_id)
    if not st or st.campus_id != cg.campus_id or st.status == 'archived':
        flash('学员无效', 'danger')
    elif Enrollment.query.filter_by(student_id=st.id, class_group_id=cg.id, status='active').first():
        flash(f'「{st.name}」已在该班', 'warning')
    elif is_full(cg):
        flash(f'班次「{cg.name}」名额已满（含待确认报名）', 'danger')
    else:
        # 加固：复用已存在的 enrollment（退班→再加同一班会撞唯一约束）
        try:
            result, _e = enroll_or_reactivate(st.id, cg.id, cg.campus_id)
            if result == 'active':
                flash(f'「{st.name}」已在该班', 'warning')
            else:
                log_op(current_user.id, 'enrollment', st.id, 'enroll',
                       f'{st.name}->{cg.name}' + ('（重新入班）' if result == 'reactivated' else ''))
                db.session.commit()
                flash(f'「{st.name}」已加入班次「{cg.name}」', 'success')
        except IntegrityError:
            db.session.rollback()
            audit.event('ERROR', f'class enroll IntegrityError student={st.id} class={cg.id}')
            flash('入班失败：该学员已在该班', 'danger')
    return redirect(url_for('classes.list_cg'))
