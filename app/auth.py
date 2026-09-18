"""认证：登录/首装/登出/改密（无邀请码；首账号=超管由 setup 页创建）"""
from flask import (Blueprint, render_template, request, redirect, url_for,
                   flash, session)
from flask_login import login_user, logout_user, login_required, current_user
from werkzeug.security import generate_password_hash

from .models import db, User, SystemConfig
from .utils import log_op

bp = Blueprint('auth', __name__)


@bp.route('/setup', methods=['GET', 'POST'])
def setup():
    """首次安装：创建系统管理员 + 站点名。仅当没有任何用户时可访问"""
    if User.query.first():
        return redirect(url_for('auth.login'))
    if request.method == 'POST':
        username = (request.form.get('username') or '').strip()
        password = request.form.get('password') or ''
        password2 = request.form.get('password2') or ''
        site_name = (request.form.get('site_name') or '').strip() or '课时本'
        err = None
        if len(username) < 3:
            err = '账号至少 3 个字符'
        elif len(password) < 6:
            err = '密码至少 6 位'
        elif password != password2:
            err = '两次密码不一致'
        elif User.query.filter_by(username=username).first():
            err = '账号已存在'
        if err:
            flash(err, 'danger')
        else:
            u = User(username=username, role='super_admin', campus_id=None)
            u.set_password(password)
            db.session.add(u)
            cfg = SystemConfig.query.get(1)
            if not cfg:
                cfg = SystemConfig(id=1)
                db.session.add(cfg)
            cfg.site_name = site_name
            db.session.commit()
            login_user(u)
            flash('系统初始化完成，欢迎使用', 'success')
            return redirect(url_for('admin.home'))
    return render_template('setup.html')


@bp.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    if request.method == 'POST':
        username = (request.form.get('username') or '').strip()
        password = request.form.get('password') or ''
        # 失败锁定：同 ip 5 次失败锁 10 分钟（2026-09-05 修复：此前 ip 列误存 username，同 IP 换用户名可绕过锁定）
        # 2026-09-17 加固：ip 改用真实客户端 IP（见 app/netutil.py）。此前容器内 remote_addr
        # 恒为 docker 网关 172.23.0.1，导致"任何人错 5 次 → 全站所有人 10 分钟登不上"。
        import time as _t
        from sqlalchemy import text as _tx
        from .models import RateLimit
        from .utils import client_ip as _client_ip
        from . import audit
        ip = _client_ip()
        bk = f'login_fail:{ip}'
        row = db.session.execute(_tx('SELECT cnt, window_start FROM rate_limit WHERE bucket=:b AND ip=:i'),
                                 {'b': bk, 'i': ip}).fetchone()
        if row and _t.time() - row[1] < 600 and row[0] >= 5:
            audit.event('RATELIMIT', f'登录失败锁定中 cnt={row[0]} bucket={bk}')
            flash('失败次数过多，请 10 分钟后再试', 'danger')
            return render_template('login.html')
        u = User.query.filter_by(username=username).first()
        if u and u.check_password(password):
            if not u.is_active:
                audit.event('LOGIN_DISABLED', f'username={username} 已停用')
                flash('该账号已停用，请联系管理员', 'danger')
            else:
                login_user(u)
                db.session.execute(_tx('DELETE FROM rate_limit WHERE bucket=:b AND ip=:i'),
                                   {'b': bk, 'i': ip})
                session.pop('csrf_token', None)  # 登录后强制刷新 CSRF token
                log_op(u.id, 'auth', u.id, 'login')
                db.session.commit()
                audit.event('LOGIN_OK', f'username={u.username} role={u.role}', level=20)
                return redirect(url_for('index'))
        # 失败计数
        audit.event('LOGIN_FAIL', f'username={username!r}')
        db.session.execute(_tx(
            'INSERT INTO rate_limit (bucket, ip, cnt, window_start) VALUES (:b, :i, 1, :w) '
            'ON CONFLICT(bucket, ip) DO UPDATE SET cnt=cnt+1, '
            'window_start=CASE WHEN :now - window_start >= 600 THEN :now ELSE window_start END'),
            {'b': bk, 'i': ip, 'w': int(_t.time()), 'now': int(_t.time())})
        db.session.commit()
        flash('账号或密码错误', 'danger')
    return render_template('login.html')


@bp.route('/logout')
@login_required
def logout():
    logout_user()
    flash('已退出登录', 'info')
    return redirect(url_for('auth.login'))


@bp.route('/profile', methods=['GET', 'POST'])
@login_required
def profile():
    if request.method == 'POST':
        old = request.form.get('old_password') or ''
        new = request.form.get('new_password') or ''
        new2 = request.form.get('new_password2') or ''
        if not current_user.check_password(old):
            flash('原密码错误', 'danger')
        elif len(new) < 6:
            flash('新密码至少 6 位', 'danger')
        elif new != new2:
            flash('两次输入的新密码不一致', 'danger')
        else:
            current_user.set_password(new)
            log_op(current_user.id, 'user', current_user.id, 'change_password')
            db.session.commit()
            flash('密码已修改', 'success')
            return redirect(url_for('auth.profile'))
    return render_template('profile.html')
