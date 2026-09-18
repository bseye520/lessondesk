"""报名选课：家长公开页/修改/管理确认/入口管理（v2：原子占座+防重+confirm 转学员防重）"""
import time
import secrets
from sqlalchemy import text
from flask import (Blueprint, render_template, request, redirect, url_for,
                   flash, abort)
from flask_login import current_user, login_required
from werkzeug.security import generate_password_hash, check_password_hash

from .models import (db, Campus, ClassGroup, Student, Enrollment, Registration,
                     RegistrationEntry, RegistrationHistory, User)
from .decorators import roles
from .utils import (gen_token, log_op, validate_phone_last4,
                    client_ip, bj_now, fmt_money)
from .services import is_full, remaining_slots, enroll_or_reactivate

bp = Blueprint('register', __name__)

LIMITS = {'register': (10, 60), 'modify': (5, 60)}
MODIFY_MAX_USES = 3


def _rate_limited(bucket, ip, limit, window):
    now = int(time.time())
    row = db.session.execute(
        text('SELECT cnt, window_start FROM rate_limit WHERE bucket=:b AND ip=:i'),
        {'b': bucket, 'i': ip}).fetchone()
    if not row:
        db.session.execute(text('INSERT INTO rate_limit (bucket, ip, cnt, window_start) '
                                'VALUES (:b, :i, 1, :w)'),
                           {'b': bucket, 'i': ip, 'w': now})
        db.session.commit()
        return False
    cnt, ws = row
    if now - ws >= window:
        db.session.execute(text('UPDATE rate_limit SET cnt=1, window_start=:w '
                                'WHERE bucket=:b AND ip=:i'), {'w': now, 'b': bucket, 'i': ip})
        db.session.commit()
        return False
    if cnt >= limit:
        return True
    db.session.execute(text('UPDATE rate_limit SET cnt=cnt+1 WHERE bucket=:b AND ip=:i'),
                       {'b': bucket, 'i': ip})
    db.session.commit()
    return False


def _entry_or_404(token):
    e = RegistrationEntry.query.filter_by(token=token).first()
    if not e:
        abort(404)
    return e


def _entry_ctx(entry):
    groups = ClassGroup.query.filter_by(campus_id=entry.campus_id, is_archived=False).all()
    items = []
    for g in groups:
        r = remaining_slots(g)
        items.append({
            'id': g.id, 'name': g.name, 'weekday': g.weekday,
            'start_time': g.start_time, 'end_time': g.end_time, 'room': g.room,
            'teacher': g.teacher.username if g.teacher else '待定',
            'course': g.course.name if g.course else '',
            'full': is_full(g),
            'slots_text': '不限' if r is None else str(r),
            'low': (r is not None and r <= 3),
        })
    items.sort(key=lambda x: (x['weekday'], x['start_time']))
    return items


# ============ 家长公开页 ============

@bp.route('/r/<token>')
def register_home(token):
    entry = _entry_ctx_guard(token)
    if not entry.is_open():
        return render_template('reg_closed.html', entry=entry)
    return render_template('reg_home.html', entry=entry, items=_entry_ctx(entry))


def _entry_ctx_guard(token):
    e = RegistrationEntry.query.filter_by(token=token).first()
    if not e:
        abort(404)
    return e


@bp.route('/r/<token>', methods=['POST'])
def register_submit(token):
    entry = _entry_ctx_guard(token)
    if not entry.is_open():
        return render_template('reg_closed.html', entry=entry)
    ip = client_ip()
    if _rate_limited('register', ip, *LIMITS['register']):
        flash('操作太频繁，请 1 分钟后再试', 'danger')
        return render_template('reg_home.html', entry=entry, items=_entry_ctx(entry))
    name = (request.form.get('name') or '').strip()
    grade = (request.form.get('grade') or '').strip()
    phone4 = (request.form.get('phone_last4') or '').strip()
    cg_id = request.form.get('class_group_id', type=int)
    err = None
    if not name or len(name) > 30:
        err = '请填写学生姓名'
    elif not validate_phone_last4(phone4):
        err = '手机尾号需为 4 位数字'
    cg = db.session.get(ClassGroup, cg_id) if cg_id else None
    if not err and (not cg or cg.campus_id != entry.campus_id or cg.is_archived):
        err = '请选择有效的班级'
    if not err:
        # 事务内：查重 + 占座
        try:
            db.session.execute(text('BEGIN IMMEDIATE'))
            dup = Registration.query.filter_by(entry_id=entry.id, student_name=name,
                                               grade=grade, phone_last4=phone4).filter(
                Registration.status != 'cancelled').first()
            if dup:
                err = '该同学已在本次报名中，请使用「修改报名」'
            elif is_full(cg):
                err = f'「{cg.name}」名额已满'
            if not err:
                code = f'{secrets.randbelow(1000000):06d}'
                r = Registration(entry_id=entry.id, campus_id=entry.campus_id,
                                 class_group_id=cg.id, student_name=name, grade=grade,
                                 phone_last4=phone4, status='pending',
                                 modify_code_hash=generate_password_hash(code))
                db.session.add(r)
                db.session.flush()
                db.session.add(RegistrationHistory(registration_id=r.id, action='created',
                                                   to_class_group_id=cg.id))
                db.session.commit()
                return render_template('reg_success.html', entry=entry, code=code,
                                       name=name, cg_name=cg.name)
        except Exception:
            db.session.rollback()
            err = '提交失败，请重试'
    if err:
        flash(err, 'danger')
    return render_template('reg_home.html', entry=entry, items=_entry_ctx(entry))


@bp.route('/r/<token>/modify', methods=['GET', 'POST'])
def register_modify(token):
    entry = _entry_ctx_guard(token)
    found = None
    action = request.form.get('action')
    if request.method == 'POST' and _rate_limited('modify', client_ip(), *LIMITS['modify']):
        flash('操作太频繁，请 1 分钟后再试', 'danger')
    elif action == 'query':
        name = (request.form.get('name') or '').strip()
        phone4 = (request.form.get('phone_last4') or '').strip()
        found = Registration.query.filter_by(entry_id=entry.id, student_name=name,
                                             phone_last4=phone4).order_by(
            Registration.created_at.desc()).first()
        if not found:
            flash('未找到报名记录，请核对姓名与手机尾号', 'warning')
    elif action == 'change':
        reg_id = request.form.get('reg_id', type=int)
        code = (request.form.get('code') or '').strip()
        new_cg_id = request.form.get('class_group_id', type=int)
        r = db.session.get(Registration, reg_id) if reg_id else None
        if not r or r.entry_id != entry.id:
            flash('报名记录不存在', 'danger')
        elif r.status != 'pending':
            flash('该报名已确认，不能修改（请联系老师）', 'danger')
        elif not code or not r.modify_code_hash or not check_password_hash(r.modify_code_hash, code):
            flash('修改码错误', 'danger')
        elif r.modify_uses >= MODIFY_MAX_USES:
            flash('修改次数已用完（3 次），请联系老师协助', 'danger')
        else:
            cg = db.session.get(ClassGroup, new_cg_id) if new_cg_id else None
            if not cg or cg.campus_id != entry.campus_id or cg.is_archived:
                flash('目标班级无效', 'danger')
            elif cg.id == r.class_group_id:
                flash('与当前班级相同，无需修改', 'warning')
            elif is_full(cg):
                flash(f'「{cg.name}」名额已满', 'danger')
            else:
                old_cg = r.class_group_id
                r.class_group_id = cg.id
                r.modify_uses += 1
                r.updated_at = bj_now()
                db.session.add(RegistrationHistory(
                    registration_id=r.id, action='modified',
                    from_class_group_id=old_cg, to_class_group_id=cg.id))
                db.session.commit()
                flash('已成功更换班级', 'success')
                return redirect(url_for('register.register_home', token=token))
    if found:
        items = _entry_ctx(entry)
        return render_template('reg_modify.html', entry=entry, found=found, items=items)
    return render_template('reg_modify.html', entry=entry, found=None, items=_entry_ctx(entry))


# ============ 管理端 ============

def _scoped_campus_ids():
    if current_user.role == 'super_admin':
        return [c.id for c in Campus.query.all()]
    return [current_user.campus_id] if current_user.campus_id else []


@bp.route('/register/manage')
@roles('manager', 'super_admin')
def manage():
    cids = _scoped_campus_ids()
    q = Registration.query.filter(Registration.campus_id.in_(cids))
    status = request.args.get('status')
    if status in ('pending', 'confirmed', 'cancelled'):
        q = q.filter_by(status=status)
    else:
        status = 'pending'
        q = q.filter_by(status='pending')
    entry_id = request.args.get('entry_id', type=int)
    if entry_id:
        q = q.filter_by(entry_id=entry_id)
    kw = (request.args.get('kw') or '').strip()
    if kw:
        q = q.filter(db.or_(Registration.student_name.contains(kw),
                            Registration.guardian_phone.contains(kw)))
    regs = q.order_by(Registration.created_at.desc()).all()
    entries = RegistrationEntry.query.filter(RegistrationEntry.campus_id.in_(cids)).all()
    # 已确认报名对应的学生 id（配对显示）
    students = {s.registration_id: s for s in Student.query.filter(
        Student.registration_id.isnot(None)).all()}
    return render_template('reg_manage.html', regs=regs, entries=entries,
                           entry_id=entry_id, status=status, kw=kw,
                           students=students, _status_cn={'pending': '待确认',
                                                          'confirmed': '已确认',
                                                          'cancelled': '已取消'})


@bp.route('/register/<int:rid>/confirm', methods=['POST'])
@roles('manager', 'super_admin')
def confirm(rid):
    r = db.session.get(Registration, rid)
    if not r or r.campus_id not in _scoped_campus_ids():
        flash('报名记录不存在或无权操作', 'danger')
        return redirect(url_for('register.manage'))
    if r.status != 'pending':
        flash('该报名已处理', 'warning')
        return redirect(url_for('register.manage'))
    phone = (request.form.get('guardian_phone') or '').strip()
    gname = (request.form.get('guardian_name') or '').strip()
    # 手机号选填：未补全时用报名尾号建档（格式不再限制 11 位）
    phone_filled = bool(phone)
    if not phone_filled:
        phone = r.phone_last4
    else:
        dup = Student.query.filter_by(campus_id=r.campus_id, phone=phone).first()
        if dup:
            flash(f'该手机号已有学员「{dup.name}」，如为同一学员请勿重复确认；'
                  f'如需第二学员请先改名或线下处理', 'danger')
            return redirect(url_for('register.manage'))
    cg = db.session.get(ClassGroup, r.class_group_id)
    if not cg:
        flash('班级不存在', 'danger')
        return redirect(url_for('register.manage'))
    # 原子：容量再校验 → 建档
    try:
        db.session.execute(text('BEGIN IMMEDIATE'))
        if is_full(cg):
            flash(f'「{cg.name}」名额已满，无法确认', 'danger')
            db.session.rollback()
            return redirect(url_for('register.manage'))
        st = Student(campus_id=r.campus_id, name=r.student_name, phone=phone,
                     parent_name=gname, grade=r.grade, status='active',
                     source='registration', registration_id=r.id)
        db.session.add(st)
        db.session.flush()
        # 加固：复用已存在的 enrollment（防 UNIQUE(student_id, class_group_id)）
        enroll_or_reactivate(st.id, cg.id, r.campus_id)
        r.status = 'confirmed'
        if phone_filled:
            r.guardian_phone = phone
        if gname:
            r.guardian_name = gname
        r.updated_at = bj_now()
        db.session.add(RegistrationHistory(registration_id=r.id, action='confirmed',
                                           to_class_group_id=cg.id,
                                           note=f'转为学员 #{st.id}'))
        log_op(current_user.id, 'registration', r.id, 'confirm',
               f'{r.student_name} -> {cg.name} (student#{st.id})')
        db.session.commit()
        flash(f'已确认并建档学员「{st.name}」加入「{cg.name}」', 'success')
    except Exception as e:
        db.session.rollback()
        flash(f'确认失败：{e}', 'danger')
    return redirect(url_for('register.manage'))


@bp.route('/register/<int:rid>/cancel', methods=['POST'])
@roles('manager', 'super_admin')
def cancel(rid):
    r = db.session.get(Registration, rid)
    if not r or r.campus_id not in _scoped_campus_ids():
        flash('报名记录不存在或无权操作', 'danger')
    elif r.status == 'cancelled':
        flash('该报名已取消', 'warning')
    elif r.status == 'confirmed':
        flash('已确认的报名不能直接取消：请先在学员管理归档对应学员', 'danger')
    else:
        r.status = 'cancelled'
        r.updated_at = bj_now()
        db.session.add(RegistrationHistory(registration_id=r.id, action='cancelled'))
        log_op(current_user.id, 'registration', r.id, 'cancel', r.student_name)
        db.session.commit()
        flash('报名已取消，名额已释放', 'success')
    return redirect(url_for('register.manage'))


@bp.route('/register/manage/export')
@roles('manager', 'super_admin')
def export():
    """导出报名明细 xlsx"""
    import io
    from flask import send_file
    from openpyxl import Workbook
    cids = _scoped_campus_ids()
    q = Registration.query.filter(Registration.campus_id.in_(cids))
    entry_id = request.args.get('entry_id', type=int)
    if entry_id:
        q = q.filter_by(entry_id=entry_id)
    regs = q.order_by(Registration.created_at).all()
    wb = Workbook()
    ws = wb.active
    ws.title = '报名明细'
    ws.append(['序号', '批次', '学生姓名', '年级', '家长', '手机尾号', '班级',
               '状态', '提交时间'])
    cn = {'pending': '待确认', 'confirmed': '已确认', 'cancelled': '已取消'}
    for i, r in enumerate(regs, 1):
        ws.append([i, r.entry.name if r.entry else '', r.student_name, r.grade,
                   r.guardian_name, r.phone_last4,
                   r.class_group.name if r.class_group else '', cn.get(r.status),
                   r.created_at.strftime('%Y-%m-%d %H:%M')])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    fname = f'报名明细_{bj_now().strftime("%Y%m%d_%H%M")}.xlsx'
    return send_file(buf, as_attachment=True, download_name=fname,
                     mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')


# ============ 入口管理（super 全校 / manager 本校）============

@bp.route('/admin/entries')
@roles('manager', 'super_admin')
def entries():
    cids = _scoped_campus_ids()
    items = RegistrationEntry.query.filter(
        RegistrationEntry.campus_id.in_(cids)).order_by(
        RegistrationEntry.id.desc()).all()
    campuses = Campus.query.all()
    return render_template('admin_entries.html', items=items, campuses=campuses)


@bp.route('/admin/entries/create', methods=['POST'])
@roles('manager', 'super_admin')
def entry_create():
    cid = current_user.campus_id or request.form.get('campus_id', type=int)
    name = (request.form.get('name') or '').strip()
    deadline = request.form.get('deadline') or ''
    if not name or not db.session.get(Campus, cid):
        flash('请填写批次名称并选择有效校区', 'danger')
    else:
        e = RegistrationEntry(campus_id=cid, name=name, token=gen_token(16),
                              contact=request.form.get('contact') or '')
        if deadline:
            from datetime import datetime
            try:
                e.deadline = datetime.strptime(deadline, '%Y-%m-%dT%H:%M')
            except ValueError:
                e.deadline = None
        e.created_by = current_user.id
        db.session.add(e)
        db.session.flush()
        log_op(current_user.id, 'registration_entry', e.id, 'create', name)
        db.session.commit()
        flash(f'入口「{name}」已创建，链接已生成', 'success')
    return redirect(url_for('register.entries'))


@bp.route('/admin/entries/<int:eid>/toggle', methods=['POST'])
@roles('manager', 'super_admin')
def entry_toggle(eid):
    e = db.session.get(RegistrationEntry, eid)
    if not e or e.campus_id not in _scoped_campus_ids():
        flash('入口不存在或无权操作', 'danger')
    else:
        e.enabled = not e.enabled
        log_op(current_user.id, 'registration_entry', e.id, 'toggle',
               f'enabled={e.enabled}')
        db.session.commit()
        flash(f'入口「{e.name}」已{"开启" if e.enabled else "关闭"}', 'success')
    return redirect(url_for('register.entries'))


@bp.route('/admin/entries/<int:eid>/delete', methods=['POST'])
@roles('manager', 'super_admin')
def entry_delete(eid):
    e = db.session.get(RegistrationEntry, eid)
    if not e or e.campus_id not in _scoped_campus_ids():
        flash('入口不存在或无权操作', 'danger')
    elif e.registrations:
        flash('该入口已有报名记录，不能删除（可关闭）', 'danger')
    else:
        db.session.delete(e)
        log_op(current_user.id, 'registration_entry', eid, 'delete')
        db.session.commit()
        flash('入口已删除', 'success')
    return redirect(url_for('register.entries'))
