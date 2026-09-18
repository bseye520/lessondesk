"""管理：校区/账号/课程/系统设置（super）；教师团队管理（manager 建 teacher）"""
from flask import (Blueprint, render_template, request, redirect, url_for,
                   flash)
from flask_login import current_user

from .models import db, Campus, User, Course, RegistrationEntry, SystemConfig
from .decorators import roles
from .utils import log_op
from werkzeug.security import generate_password_hash

bp = Blueprint('admin', __name__)


def _campus_scope():
    if current_user.role == 'super_admin':
        return None
    return current_user.campus_id


# ---------------- super_admin ----------------

@bp.route('/admin')
@roles('super_admin', 'manager')
def home():
    # 加固 2026-09-17：/admin 是超管的落地页，manager 的落地页是「概览」。
    # 以前 manager 误入 /admin（旧书签 / 浏览器恢复上次页面 / 切换账号 /
    # 从超管退出去再登 manager）会直接 403。现在自动送回他自己的首页。
    if current_user.role != 'super_admin':
        from . import audit
        audit.event('REDIRECT', 'manager -> /admin，已送回 /dashboard', level=20)
        return redirect(url_for('students.dashboard'))
    campuses = Campus.query.order_by(Campus.id).all()
    from .models import Student, ClassGroup
    return render_template('admin_home.html', campuses=campuses,
                           total_students=Student.query.filter(Student.status != 'archived').count(),
                           total_classes=ClassGroup.query.filter_by(is_archived=False).count())


@bp.route('/admin/campus/create', methods=['POST'])
@roles('super_admin')
def campus_create():
    name = (request.form.get('name') or '').strip()
    code = (request.form.get('code') or '').strip()
    if not name or not code:
        flash('校区名称和编码必填', 'danger')
    elif Campus.query.filter((Campus.name == name) | (Campus.code == code)).first():
        flash('校区名称或编码已存在', 'danger')
    else:
        c = Campus(name=name, code=code, display_name=request.form.get('display_name') or name,
                   remarks=request.form.get('remarks') or '')
        db.session.add(c)
        db.session.flush()
        log_op(current_user.id, 'campus', c.id, 'create', name)
        db.session.commit()
        flash(f'校区「{name}」已创建', 'success')
    return redirect(url_for('admin.home'))


@bp.route('/admin/campus/<int:cid>/toggle', methods=['POST'])
@roles('super_admin')
def campus_toggle(cid):
    c = db.session.get(Campus, cid)
    if not c:
        flash('校区不存在', 'danger')
    else:
        c.is_active = not c.is_active
        log_op(current_user.id, 'campus', c.id, 'toggle', f'is_active={c.is_active}')
        db.session.commit()
        flash(f'校区「{c.name}」已{"启用" if c.is_active else "停用"}', 'success')
    return redirect(url_for('admin.home'))


@bp.route('/admin/users')
@roles('super_admin')
def users():
    campuses = Campus.query.order_by(Campus.id).all()
    cid = request.args.get('campus_id', type=int)
    q = User.query
    if cid:
        q = q.filter_by(campus_id=cid)
    users = q.order_by(User.role, User.id).all()
    return render_template('admin_users.html', campuses=campuses, users=users, cid=cid)


@bp.route('/admin/user/create', methods=['POST'])
@roles('super_admin')
def user_create():
    username = (request.form.get('username') or '').strip()
    password = request.form.get('password') or ''
    role = request.form.get('role')  # manager | teacher
    campus_id = request.form.get('campus_id', type=int)
    if role not in ('manager', 'teacher'):
        flash('角色不合法', 'danger')
    elif not campus_id or not db.session.get(Campus, campus_id):
        flash('请选择有效校区', 'danger')
    elif len(username) < 3 or len(password) < 6:
        flash('账号至少3字符、密码至少6位', 'danger')
    elif User.query.filter_by(username=username).first():
        flash('账号已存在', 'danger')
    else:
        u = User(username=username, role=role, campus_id=campus_id)
        u.set_password(password)
        db.session.add(u)
        db.session.flush()
        log_op(current_user.id, 'user', u.id, 'create',
               f'{username}({role}) campus={campus_id}')
        db.session.commit()
        flash(f'账号「{username}」已创建', 'success')
    return redirect(url_for('admin.users'))


@bp.route('/admin/user/<int:uid>/toggle', methods=['POST'])
@roles('super_admin')
def user_toggle(uid):
    u = db.session.get(User, uid)
    if not u:
        flash('账号不存在', 'danger')
    elif u.id == current_user.id:
        flash('不能停用自己的账号', 'danger')
    else:
        u.is_active = not u.is_active
        log_op(current_user.id, 'user', u.id, 'toggle', f'is_active={u.is_active}')
        db.session.commit()
        flash(f'账号「{u.username}」已{"启用" if u.is_active else "停用"}', 'success')
    return redirect(url_for('admin.users'))


@bp.route('/admin/user/<int:uid>/reset', methods=['POST'])
@roles('super_admin')
def user_reset(uid):
    u = db.session.get(User, uid)
    pw = request.form.get('password') or ''
    if not u:
        flash('账号不存在', 'danger')
    elif len(pw) < 6:
        flash('新密码至少 6 位', 'danger')
    else:
        u.set_password(pw)
        log_op(current_user.id, 'user', u.id, 'reset_password')
        db.session.commit()
        flash(f'账号「{u.username}」密码已重置', 'success')
    return redirect(url_for('admin.users'))


# ---------------- manager 建 teacher ----------------

@bp.route('/team')
@roles('manager')
def team():
    cid = _campus_scope()
    q = User.query.filter(User.role == 'teacher')
    if cid:
        q = q.filter_by(campus_id=cid)
    teachers = q.order_by(User.id).all()
    return render_template('team.html', teachers=teachers)


@bp.route('/team/create', methods=['POST'])
@roles('manager')
def team_create():
    cid = _campus_scope() or request.form.get('campus_id', type=int)
    username = (request.form.get('username') or '').strip()
    password = request.form.get('password') or ''
    campus = db.session.get(Campus, cid)
    if not campus:
        flash('校区无效', 'danger')
    elif len(username) < 3 or len(password) < 6:
        flash('账号至少3字符、密码至少6位', 'danger')
    elif User.query.filter_by(username=username).first():
        flash('账号已存在', 'danger')
    else:
        u = User(username=username, role='teacher', campus_id=campus.id)
        u.set_password(password)
        db.session.add(u)
        db.session.flush()
        log_op(current_user.id, 'user', u.id, 'create', f'teacher {username}')
        db.session.commit()
        flash(f'教师账号「{username}」已创建', 'success')
    return redirect(url_for('admin.team'))


@bp.route('/team/<int:uid>/toggle', methods=['POST'])
@roles('manager')
def team_toggle(uid):
    u = db.session.get(User, uid)
    cid = _campus_scope()
    if not u or u.role != 'teacher':
        flash('账号不存在', 'danger')
    elif cid and u.campus_id != cid:
        flash('无权操作其他校区账号', 'danger')
    else:
        u.is_active = not u.is_active
        log_op(current_user.id, 'user', u.id, 'toggle', f'teacher is_active={u.is_active}')
        db.session.commit()
        flash(f'教师「{u.username}」已{"启用" if u.is_active else "停用"}', 'success')
    return redirect(url_for('admin.team'))


@bp.route('/team/<int:uid>/reset', methods=['POST'])
@roles('manager')
def team_reset(uid):
    u = db.session.get(User, uid)
    cid = _campus_scope()
    pw = request.form.get('password') or ''
    if not u or u.role != 'teacher':
        flash('账号不存在', 'danger')
    elif cid and u.campus_id != cid:
        flash('无权操作其他校区账号', 'danger')
    elif len(pw) < 6:
        flash('新密码至少 6 位', 'danger')
    else:
        u.set_password(pw)
        log_op(current_user.id, 'user', u.id, 'reset_password', 'teacher')
        db.session.commit()
        flash(f'教师「{u.username}」密码已重置', 'success')
    return redirect(url_for('admin.team'))


# ---------------- 课程（super 或 manager 本校）----------------

def _courses_scope():
    cid = _campus_scope()
    q = Course.query
    if cid:
        q = q.filter_by(campus_id=cid)
    return q


@bp.route('/admin/courses')
@roles('manager', 'super_admin')
def courses():
    cid = _campus_scope()
    campuses = Campus.query.order_by(Campus.id).all() if current_user.role == 'super_admin' else []
    q = _courses_scope()
    if current_user.role == 'super_admin' and request.args.get('campus_id', type=int):
        q = q.filter_by(campus_id=request.args.get('campus_id', type=int))
        cid = request.args.get('campus_id', type=int)
    show_archived = request.args.get('archived') == '1'
    if not show_archived:
        q = q.filter_by(is_archived=False)
    courses = q.order_by(Course.id.desc()).all()
    return render_template('admin_courses.html', courses=courses, campuses=campuses,
                           show_archived=show_archived, cid=cid)


@bp.route('/admin/course/create', methods=['POST'])
@roles('manager', 'super_admin')
def course_create():
    cid = _campus_scope() or request.form.get('campus_id', type=int)
    name = (request.form.get('name') or '').strip()
    category = request.form.get('category') or '其他'
    if not db.session.get(Campus, cid):
        flash('校区无效', 'danger')
    elif not name:
        flash('课程名称必填', 'danger')
    else:
        c = Course(campus_id=cid, name=name, category=category)
        db.session.add(c)
        db.session.flush()
        log_op(current_user.id, 'course', c.id, 'create', name)
        db.session.commit()
        flash(f'课程「{name}」已创建', 'success')
    return redirect(url_for('admin.courses'))


@bp.route('/admin/course/<int:cid>/archive', methods=['POST'])
@roles('manager', 'super_admin')
def course_archive(cid):
    c = db.session.get(Course, cid)
    scope = _campus_scope()
    if not c:
        flash('课程不存在', 'danger')
    elif scope and c.campus_id != scope:
        flash('无权操作其他校区课程', 'danger')
    else:
        c.is_archived = not c.is_archived
        log_op(current_user.id, 'course', c.id, 'toggle_archive')
        db.session.commit()
        flash(f'课程「{c.name}」已{"归档" if c.is_archived else "恢复"}', 'success')
    return redirect(url_for('admin.courses'))


# ---------------- 报名入口（super 全局 / manager 本校，见 register.py）----------------

@bp.route('/admin/system', methods=['GET', 'POST'])
@roles('super_admin')
def system():
    cfg = SystemConfig.query.get(1)
    if request.method == 'POST':
        import os, secrets as _s
        from flask import current_app
        if not cfg:
            cfg = SystemConfig(id=1)
            db.session.add(cfg)
        cfg.site_name = (request.form.get('site_name') or '').strip() or '课时本'
        # logo 上传
        f = request.files.get('logo')
        if f and f.filename:
            fn = f.filename.lower()
            if not (fn.endswith('.png') or fn.endswith('.jpg') or fn.endswith('.jpeg') or fn.endswith('.svg') or fn.endswith('.webp')):
                flash('Logo 仅支持 png/jpg/svg/webp', 'danger')
                return redirect(url_for('admin.system'))
            ext = fn.rsplit('.', 1)[-1]
            name = 'logo_' + _s.token_hex(4) + '.' + ext
            f.save(os.path.join(current_app.config['UPLOAD_FOLDER'], name))
            cfg.logo_path = '/static/uploads/' + name
        # 登录封面上传
        f = request.files.get('login_bg')
        if f and f.filename:
            fn = f.filename.lower()
            if not (fn.endswith('.png') or fn.endswith('.jpg') or fn.endswith('.jpeg') or fn.endswith('.webp')):
                flash('封面仅支持 png/jpg/webp', 'danger')
                return redirect(url_for('admin.system'))
            ext = fn.rsplit('.', 1)[-1]
            name = 'bg_' + _s.token_hex(4) + '.' + ext
            f.save(os.path.join(current_app.config['UPLOAD_FOLDER'], name))
            cfg.login_bg_path = '/static/uploads/' + name
        # 重置封面
        if request.form.get('reset_bg'):
            cfg.login_bg_path = None
        if request.form.get('reset_logo'):
            cfg.logo_path = None
        log_op(current_user.id, 'system', 1, 'update', cfg.site_name)
        db.session.commit()
        flash('设置已保存', 'success')
        return redirect(url_for('admin.system'))
    return render_template('admin_system.html', cfg=cfg)
