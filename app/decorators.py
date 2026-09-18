"""权限装饰器（加固 2026-09-17）

改动：所有 `abort(403)` 都带上 `description`，403 页面会把原因显示给用户、
并写进安全日志——以前只给一句"没有权限执行此操作"，用户和你都看不出是哪条规则
拦的、该找谁开权限。
"""
from functools import wraps

from flask import abort, redirect, url_for, flash
from flask_login import current_user, login_required

_ROLE_CN = {'super_admin': '系统管理员', 'manager': '校区管理员', 'teacher': '教师'}


def _cn(role):
    return _ROLE_CN.get(role, role or '未设置')


def roles(*allowed):
    """角色白名单。super_admin 拥有全部权限。"""
    def deco(fn):
        @wraps(fn)
        @login_required
        def wrapper(*args, **kwargs):
            if not current_user.is_active:
                flash('账号已停用', 'danger')
                return redirect(url_for('auth.login'))
            if current_user.role not in allowed and current_user.role != 'super_admin':
                abort(403, description=(
                    f'这个页面需要「{" / ".join(_cn(r) for r in allowed)}」权限，'
                    f'当前账号的角色是「{_cn(current_user.role)}」。'))
            return fn(*args, **kwargs)
        return wrapper
    return deco


def same_campus_required(fn):
    """manager/teacher 必须有所属校区；无校区则拒绝。

    注意：目前没有任何路由使用它（保留给以后按校区分权的接口）。
    """
    @wraps(fn)
    @login_required
    def wrapper(*args, **kwargs):
        if current_user.role != 'super_admin' and not current_user.campus_id:
            abort(403, description='当前账号没有绑定校区，无法执行本操作，请联系系统管理员。')
        return fn(*args, **kwargs)
    return wrapper


def teacher_owns_class(fn):
    """teacher 只能操作自己任教的班（manager/super 放行）"""
    @wraps(fn)
    @login_required
    def wrapper(class_group_id, *args, **kwargs):
        if current_user.role == 'teacher':
            from .models import ClassGroup
            cg = ClassGroup.query.get_or_404(class_group_id)
            if cg.teacher_id != current_user.id:
                abort(403, description=(
                    f'「{cg.name}」不是你的任教班次，教师只能对自己任教的班做考勤/消课。'))
        return fn(class_group_id, *args, **kwargs)
    return wrapper


def campus_of(obj, attr='campus_id'):
    """给 lessons/students 复用的一句话原因。"""
    return f'该记录属于其他校区（#{getattr(obj, attr, "?")}），你不是那个校区的人。'
