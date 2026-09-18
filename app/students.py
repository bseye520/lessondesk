"""学员管理：列表/详情/建档/编辑/归档/入班退班/交费登记/调整课时/批量课时"""
from datetime import datetime
from flask import (Blueprint, render_template, request, redirect, url_for,
                   flash)
from flask_login import current_user

from .models import (db, Campus, Student, Enrollment, ClassGroup,
                     PaymentRecord, LessonRecord, User, bj_today)
from .decorators import roles
from .utils import (log_op, money_cents)
from .services import is_full, guard_student_paid, enroll_or_reactivate
from . import audit
from sqlalchemy.exc import IntegrityError

bp = Blueprint('students', __name__)


def _scope():
    return None if current_user.role == 'super_admin' else current_user.campus_id


def _get_student_or_403(sid):
    st = db.session.get(Student, sid)
    s = _scope()
    if not st:
        flash('学员不存在', 'danger')
        return None
    if s and st.campus_id != s:
        flash('无权操作其他校区学员', 'danger')
        return None
    return st


@bp.route('/dashboard')
@roles('manager', 'super_admin')
def dashboard():
    s = _scope()
    qs = Student.query.filter(Student.status != 'archived')
    qc = ClassGroup.query.filter_by(is_archived=False)
    if s:
        qs = qs.filter_by(campus_id=s)
        qc = qc.filter_by(campus_id=s)
    students = qs.all()
    total_remaining = sum(st.total_remaining() for st in students)
    # 本月交费笔数（仅计数，金额只作备注）
    month_start = datetime(bj_today().year, bj_today().month, 1)
    month_charges = PaymentRecord.query
    if s:
        month_charges = month_charges.filter_by(campus_id=s)
    month_charges = month_charges.filter(PaymentRecord.type == 'charge',
                                         PaymentRecord.created_at >= month_start).count()
    return render_template('manager_dashboard.html',
                           student_count=qs.count(), class_count=qc.count(),
                           month_income=month_charges,
                           pending_reg=sum(1 for _ in ()),
                           total_remaining=total_remaining,
                           campus_count=1 if s else Campus.query.count())


@bp.route('/students')
@roles('manager', 'teacher', 'super_admin')
def list_students():
    s = _scope()
    q = Student.query
    if s:
        q = q.filter_by(campus_id=s)
    kw = (request.args.get('kw') or '').strip()
    if kw:
        q = q.filter(db.or_(Student.name.contains(kw), Student.phone.contains(kw),
                            Student.parent_name.contains(kw)))
    cg_id = request.args.get('class_group_id', type=int)
    if cg_id:
        q = q.join(Enrollment).filter(Enrollment.class_group_id == cg_id,
                                      Enrollment.status == 'active')
    status = request.args.get('status')
    if status in ('active', 'trial', 'archived'):
        q = q.filter_by(status=status)
    else:
        q = q.filter(Student.status != 'archived')
    students = q.order_by(Student.created_at.desc()).all()
    groups = ClassGroup.query.filter_by(is_archived=False).all()
    if s:
        groups = [g for g in groups if g.campus_id == s]
    campuses = Campus.query.all()
    return render_template('students.html', students=students, groups=groups,
                           campuses=campuses,
                           kw=kw, cg_id=cg_id, status=status,
                           is_teacher=current_user.role == 'teacher')


@bp.route('/students/<int:sid>')
@roles('manager', 'teacher', 'super_admin')
def detail(sid):
    st = _get_student_or_403(sid)
    if not st:
        return redirect(url_for('students.list_students'))
    enrolls = [e for e in st.enrollments if e.status == 'active']
    payments = PaymentRecord.query.filter_by(student_id=st.id).order_by(
        PaymentRecord.created_at.desc()).limit(100).all()
    records = LessonRecord.query.filter_by(student_id=st.id).order_by(
        LessonRecord.date.desc()).limit(100).all()
    qg = ClassGroup.query.filter(ClassGroup.campus_id == st.campus_id,
                                 ClassGroup.is_archived == False)
    open_groups = [g for g in qg.all() if not is_full(g)]
    return render_template('student_detail.html', st=st, enrolls=enrolls,
                           payments=payments, records=records,
                           open_groups=open_groups,
                           is_teacher=current_user.role == 'teacher')


@bp.route('/students/new', methods=['POST'])
@roles('manager', 'super_admin')
def create_student():
    s = _scope() or request.form.get('campus_id', type=int)
    name = (request.form.get('name') or '').strip()
    phone = (request.form.get('phone') or '').strip()
    if not db.session.get(Campus, s):
        flash('校区无效', 'danger')
    elif not name:
        flash('请填写姓名', 'danger')
    elif not phone:
        flash('请填写手机号（完整号码或尾号均可）', 'danger')
    elif Student.query.filter_by(campus_id=s, phone=phone).first():
        flash('该手机号在本校区已有学员', 'danger')
    else:
        st = Student(campus_id=s, name=name, phone=phone,
                     gender=request.form.get('gender') or '',
                     parent_name=(request.form.get('parent_name') or '').strip(),
                     grade=(request.form.get('grade') or '').strip(),
                     remarks=request.form.get('remarks') or '')
        bd = request.form.get('birthday')
        if bd:
            try:
                st.birthday = datetime.strptime(bd, '%Y-%m-%d').date()
            except ValueError:
                st.birthday = None
        db.session.add(st)
        db.session.flush()
        # 可选同时入班（加固：复用已存在的 enrollment，防唯一约束崩进程）
        cg_id = request.form.get('class_group_id', type=int)
        if cg_id:
            cg = db.session.get(ClassGroup, cg_id)
            if cg and cg.campus_id == s and not is_full(cg):
                enroll_or_reactivate(st.id, cg.id, s)
        log_op(current_user.id, 'student', st.id, 'create', name)
        db.session.commit()
        flash(f'学员「{name}」已建档', 'success')
    return redirect(url_for('students.list_students'))


@bp.route('/students/<int:sid>/edit', methods=['POST'])
@roles('manager', 'super_admin')
def edit_student(sid):
    st = _get_student_or_403(sid)
    if not st:
        return redirect(url_for('students.list_students'))
    phone = (request.form.get('phone') or '').strip()
    dup = Student.query.filter(Student.campus_id == st.campus_id,
                               Student.phone == phone, Student.id != st.id).first()
    if not phone:
        flash('请填写手机号（完整号码或尾号均可）', 'danger')
    elif dup:
        flash('该手机号在本校区已有其他学员', 'danger')
    else:
        st.name = (request.form.get('name') or st.name).strip()
        st.phone = phone
        st.gender = request.form.get('gender') or st.gender
        st.parent_name = (request.form.get('parent_name') or '').strip()
        st.grade = (request.form.get('grade') or '').strip()
        st.remarks = request.form.get('remarks') or st.remarks
        st.status = request.form.get('status') if request.form.get('status') in (
            'active', 'trial', 'archived') else st.status
        bd = request.form.get('birthday')
        if bd:
            try:
                st.birthday = datetime.strptime(bd, '%Y-%m-%d').date()
            except ValueError:
                pass
        log_op(current_user.id, 'student', st.id, 'edit', st.name)
        db.session.commit()
        flash('学员资料已更新', 'success')
    return redirect(url_for('students.detail', sid=st.id))


@bp.route('/students/<int:sid>/archive', methods=['POST'])
@roles('manager', 'super_admin')
def archive_student(sid):
    st = _get_student_or_403(sid)
    if not st:
        return redirect(url_for('students.list_students'))
    if st.status == 'archived':
        st.status = 'active'
        log_op(current_user.id, 'student', st.id, 'restore')
    else:
        st.status = 'archived'
        for e in st.enrollments:
            if e.status == 'active':
                e.status = 'left'
                e.left_at = datetime.utcnow()
        log_op(current_user.id, 'student', st.id, 'archive')
    db.session.commit()
    flash('学员状态已更新', 'success')
    return redirect(url_for('students.detail', sid=st.id))


@bp.route('/students/<int:sid>/delete', methods=['POST'])
@roles('manager', 'super_admin')
def delete_student(sid):
    st = _get_student_or_403(sid)
    if not st:
        return redirect(url_for('students.list_students'))
    if st.enrollments or guard_student_paid(st):
        flash('该学员有班级/课时/流水记录，不可删除，请使用归档', 'danger')
    else:
        sid_ = st.id
        db.session.delete(st)
        log_op(current_user.id, 'student', sid_, 'delete')
        db.session.commit()
        flash('学员已删除', 'success')
    return redirect(url_for('students.list_students'))


@bp.route('/students/<int:sid>/enroll', methods=['POST'])
@roles('manager', 'super_admin')
def enroll(sid):
    st = _get_student_or_403(sid)
    if not st:
        return redirect(url_for('students.list_students'))
    if st.status == 'archived':
        flash('归档学员需先恢复', 'danger')
        return redirect(url_for('students.detail', sid=st.id))
    cg = db.session.get(ClassGroup, request.form.get('class_group_id', type=int))
    if not cg or cg.campus_id != st.campus_id or cg.is_archived:
        flash('班次无效', 'danger')
    elif Enrollment.query.filter_by(student_id=st.id, class_group_id=cg.id,
                                    status='active').first():
        flash('已在该班', 'warning')
    elif is_full(cg):
        flash(f'班次「{cg.name}」名额已满', 'danger')
    else:
        # 加固：退班后重新入同一个班会撞 UNIQUE(student_id, class_group_id)，
        # 以前直接 IntegrityError 把 gunicorn worker 打挂（表现为"页面开小差"）。
        try:
            result, _e = enroll_or_reactivate(st.id, cg.id, st.campus_id)
            if result == 'active':
                flash('已在该班', 'warning')
            else:
                log_op(current_user.id, 'enrollment', st.id, 'enroll',
                       f'{st.name}->{cg.name}' + ('（重新入班）' if result == 'reactivated' else ''))
                db.session.commit()
                flash(f'已加入「{cg.name}」', 'success')
        except IntegrityError:
            db.session.rollback()
            audit.event('ERROR', f'enroll IntegrityError student={st.id} class={cg.id}')
            flash('入班失败：该学员已在该班（刷新後重试）', 'danger')
        except Exception as e:
            db.session.rollback()
            audit.event('ERROR', f'enroll failed: {e!r}')
            flash('入班失败，请重试', 'danger')
    return redirect(url_for('students.detail', sid=st.id))


@bp.route('/students/<int:sid>/unenroll/<int:eid>', methods=['POST'])
@roles('manager', 'super_admin')
def unenroll(sid, eid):
    st = _get_student_or_403(sid)
    e = db.session.get(Enrollment, eid)
    if not st or not e or e.student_id != st.id:
        flash('记录不存在', 'danger')
    else:
        e.status = 'left'
        e.left_at = datetime.utcnow()
        log_op(current_user.id, 'enrollment', st.id, 'unenroll',
               f'{st.name} <- {e.class_group.name}')
        db.session.commit()
        flash('已退出班级', 'success')
    return redirect(url_for('students.detail', sid=st.id))


@bp.route('/students/<int:sid>/contract', methods=['POST'])
@roles('manager', 'super_admin')
def new_contract(sid):
    """交费登记：记录交费时间/购买课时/赠课/金额（金额仅备注，不参与计算），自动累加总课时"""
    st = _get_student_or_403(sid)
    if not st:
        return redirect(url_for('students.list_students'))
    if st.status == 'archived':
        flash('归档学员不可登记交费', 'danger')
        return redirect(url_for('students.detail', sid=st.id))
    lessons = request.form.get('lessons', type=int)
    bonus = request.form.get('bonus', type=int) or 0
    amount_yuan = request.form.get('amount') or ''
    remarks = (request.form.get('remarks') or '').strip()
    amount_cents = money_cents(amount_yuan) if amount_yuan else 0
    if lessons is None or lessons <= 0:
        flash('购买课时数必须大于 0', 'danger')
    elif bonus < 0 or amount_cents is None:
        flash('赠课数或金额不合法', 'danger')
    else:
        st.lessons_remaining = (st.lessons_remaining or 0) + lessons + bonus
        db.session.add(PaymentRecord(campus_id=st.campus_id, student_id=st.id,
                                     type='charge', amount_cents=amount_cents,
                                     lessons_delta=lessons, lessons_bonus=bonus,
                                     operator_id=current_user.id,
                                     remarks=remarks or '交费登记'))
        log_op(current_user.id, 'student', st.id, 'charge',
               f'{st.name} 购{lessons}节 赠{bonus}节 金额备注{amount_yuan}元')
        db.session.commit()
        flash(f'已登记交费：{lessons} 节 + 赠 {bonus} 节，当前剩余 {st.lessons_remaining} 节', 'success')
    return redirect(url_for('students.detail', sid=st.id))


@bp.route('/students/<int:sid>/adjust', methods=['POST'])
@roles('manager', 'super_admin')
def adjust(sid):
    """调整课时（仅管理员）：扣错/多扣补回。delta 可正可负，必须填备注。"""
    st = _get_student_or_403(sid)
    if not st:
        return redirect(url_for('students.list_students'))
    delta = request.form.get('delta', type=int)
    remarks = (request.form.get('remarks') or '').strip()
    if delta is None or delta == 0:
        flash('调整课时数不能为 0', 'danger')
    elif not remarks:
        flash('调整必须填写备注（依据/原因）', 'danger')
    elif delta < 0 and (st.lessons_remaining or 0) + delta < 0:
        flash(f'扣减后课时为负（当前剩余 {st.lessons_remaining or 0} 节）', 'danger')
    else:
        st.lessons_remaining = (st.lessons_remaining or 0) + delta
        db.session.add(PaymentRecord(campus_id=st.campus_id, student_id=st.id,
                                     type='adjust', amount_cents=0,
                                     lessons_delta=delta, lessons_bonus=0,
                                     operator_id=current_user.id, remarks=remarks))
        log_op(current_user.id, 'student', st.id, 'adjust',
               f'{st.name} 课时{delta:+d} 节（现余 {st.lessons_remaining}）备注：{remarks[:50]}')
        db.session.commit()
        flash(f'已调整课时 {delta:+d} 节，当前剩余 {st.lessons_remaining} 节', 'success')
    return redirect(url_for('students.detail', sid=st.id))


@bp.route('/students/lessons-batch', methods=['GET', 'POST'])
@roles('manager', 'super_admin')
def batch_lessons():
    """课时管理：批量查看/设置本校区学员剩余课时（初始化录入/整体修正）"""
    s = _scope()
    q = Student.query.filter(Student.status != 'archived')
    if s:
        q = q.filter_by(campus_id=s)
    kw = (request.args.get('kw') or '').strip()
    if kw:
        q = q.filter(db.or_(Student.name.contains(kw), Student.phone.contains(kw)))
    students = q.order_by(Student.name).all()
    if request.method == 'POST':
        changed = []
        total_old = total_new = 0
        for st in students:
            v = request.form.get(f'v_{st.id}', type=int)
            old = st.lessons_remaining or 0
            total_old += old
            if v is not None and v >= 0 and v != old:
                st.lessons_remaining = v
                changed.append(f'{st.name}:{old}→{v}')
                total_new += v
            else:
                total_new += old
        if changed:
            log_op(current_user.id, 'student', 0, 'batch_set_lessons',
                   f'批量设置课时：{len(changed)} 人（{"；".join(changed[:30])}）')
            db.session.commit()
            flash(f'已更新 {len(changed)} 名学员的剩余课时', 'success')
        else:
            flash('没有变化', 'warning')
        return redirect(url_for('students.batch_lessons'))
    return render_template('batch_lessons.html', students=students, kw=kw,
                           total=sum(st.total_remaining() for st in students))
