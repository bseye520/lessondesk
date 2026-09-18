"""课时本 LessonDesk - 应用工厂"""
import logging
import os
from flask import Flask, g, render_template, request, redirect, url_for
from flask_login import LoginManager, current_user
from flask_wtf.csrf import CSRFProtect

from .models import db, User, SystemConfig

# 加固版本标记（启动时打日志，便于确认线上跑的是哪一版）
APP_BUILD = '2026-09-17-harden-2'

# 强制 HTTPS（2026-09-17 老爹定：公网一律 https，局域网内保留 http）
#   判定“公网”= 请求经 Cloudflare 隧道进来（带 CF-Connecting-IP / X-Forwarded-Proto）。
#   局域网直连（http://<服务器IP>:28001）不带这些头，不受影响。
FORCE_HTTPS = os.environ.get('FORCE_HTTPS', '1') != '0'
HSTS_MAX_AGE = os.environ.get('HSTS_MAX_AGE', '15552000')  # 180 天；设 0 可关闭 HSTS

login_manager = LoginManager()
csrf = CSRFProtect()


def _role_landing(role):
    """每个角色登录后的首页（403 页面用它给"回我的首页"）。"""
    return {'super_admin': 'admin.home', 'teacher': 'lessons.my_home'}.get(
        role, 'students.dashboard')


def _edge_proto():
    """经 Cloudflare 进来时返回客户端→CF 那一段的协议（http/https）；
    局域网直连返回 None（表示“不是从公网进来的”）。"""
    if request.headers.get('CF-Connecting-IP'):
        return (request.headers.get('X-Forwarded-Proto') or 'https').split(',')[0].strip().lower()
    xfp = request.headers.get('X-Forwarded-Proto')
    if xfp:
        return xfp.split(',')[0].strip().lower()
    return None


def create_app(instance_dir=None):
    app = Flask(__name__, instance_relative_config=True)
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    instance = instance_dir or os.path.join(base, 'instance')
    pkg_dir = os.path.dirname(os.path.abspath(__file__))  # app/ 包目录
    upload_dir = os.path.join(pkg_dir, 'static', 'uploads')  # Flask 实际服务的 static 子目录
    os.makedirs(instance, exist_ok=True)
    os.makedirs(upload_dir, exist_ok=True)

    # 审计日志（stderr + instance/security.log 轮转）
    from . import audit
    audit.setup(app, instance)

    # SECRET_KEY 加固：未配置/占位符时大声报警（会话可被伪造）
    _secret = os.environ.get('SECRET_KEY') or ''
    if not _secret or _secret in ('change-me-please', 'testkey123') or len(_secret) < 16:
        app.logger.critical('SECRET_KEY 未正确配置（缺失/过短/占位符）—— 会话可被伪造，请检查 .env')

    app.config.update(
        SECRET_KEY=os.environ.get('SECRET_KEY', 'change-me-please'),
        SQLALCHEMY_DATABASE_URI='sqlite:///' + os.path.join(instance, 'app.db'),
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        # 并发写优化：busy timeout 10s（默认 5s 在多设备同时操作时易报 database is locked）
        SQLALCHEMY_ENGINE_OPTIONS={'connect_args': {'timeout': 10}},
        MAX_CONTENT_LENGTH=8 * 1024 * 1024,
        UPLOAD_FOLDER=upload_dir,
        WTF_CSRF_TIME_LIMIT=None,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE='Lax',
        # 经 Cloudflare 隧道走 HTTPS；若要开 Secure，把下面这行改成 True
        # （注意：开了之后 http://<服务器IP>:28001 直连就没法登录了）
        SESSION_COOKIE_SECURE=os.environ.get('SESSION_COOKIE_SECURE', '0') == '1',
        REMEMBER_COOKIE_HTTPONLY=True,
    )
    db.init_app(app)
    login_manager.init_app(app)
    login_manager.login_view = 'auth.login'
    login_manager.login_message = '请先登录'
    csrf.init_app(app)

    from .models import Campus
    from .utils import fmt_money

    @app.template_filter('money')
    def money_filter(cents):
        return fmt_money(cents)

    @app.context_processor
    def inject_globals():
        site = SystemConfig.query.get(1)
        me = current_user if not current_user.is_anonymous else None
        return {
            'site_name': site.site_name if site else '课时本',
            'site_logo': site.logo_path if site else None,
            'site_bg': site.login_bg_path if site else None,
            'me': me,
            'WEEKDAYS': ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
        }

    from . import auth, admin, classes, students, lessons, finance, register
    app.register_blueprint(auth.bp)
    app.register_blueprint(admin.bp)
    app.register_blueprint(classes.bp)
    app.register_blueprint(students.bp)
    app.register_blueprint(lessons.bp)
    app.register_blueprint(finance.bp)
    app.register_blueprint(register.bp)

    @app.route('/')
    def index():
        if current_user.is_authenticated:
            if current_user.role == 'super_admin':
                return redirect(url_for('admin.home'))
            if current_user.role == 'teacher':
                return redirect(url_for('lessons.my_home'))
            return redirect(url_for('students.dashboard'))
        return redirect(url_for('auth.login'))

    @app.route('/healthz')
    def healthz():
        return 'ok'

    @app.errorhandler(404)
    def e404(e):
        return render_template('error.html', code=404, message='页面不存在',
                               reason='', home=url_for('index')), 404

    @app.errorhandler(403)
    def e403(e):
        # 加固：403 记日志 + 告诉用户"为什么"、并给一条回自己首页的路
        reason = (getattr(e, 'description', '') or '').strip()
        audit.event('DENY', '403 ' + reason)
        home = url_for('index')
        if getattr(current_user, 'is_authenticated', False):
            home = url_for(_role_landing(getattr(current_user, 'role', '')))
        return render_template('error.html', code=403, message='没有权限执行此操作',
                               reason=reason, home=home), 403

    @app.errorhandler(400)
    def e400(e):
        # CSRF 失效（页面过期/多标签页/直接粘贴链接提交）以前只给一个英文 400，
        # 现在给中文提示 + 记日志，方便以后排查。
        desc = (getattr(e, 'description', '') or '').strip()
        if 'CSRF' in desc.upper() or 'token' in desc.lower():
            audit.event('CSRF', desc)
            return render_template(
                'error.html', code=400, message='页面已过期',
                reason='安全校验（CSRF）没通过：多半是这个页面放太久、或从别的窗口' 
                       '提交的。刷新页面重新操作即可。',
                home=url_for('index')), 400
        audit.event('BADREQ', desc)
        return render_template('error.html', code=400, message='请求不合法',
                               reason=desc, home=url_for('index')), 400

    @app.errorhandler(500)
    def e500(e):
        db.session.rollback()
        # 加固：500 以前完全不留痕，现在打出堆栈（含请求上下文）
        app.logger.exception('500 at %s', request.full_path)
        audit.event('ERROR', '500 ' + repr(getattr(e, 'original_exception', e)))
        return render_template('error.html', code=500, message='服务器开小差了，请重试',
                               reason='这一条已经写进日志了，可让春香查。',
                               home=url_for('index')), 500

    @app.after_request
    def _log_bad_status(resp):
        """兜底：把没被 errorhandler 记过的 4xx/5xx 记一行（403/400 已由
        errorhandler 记过，404 是扫描噪声，都跳过）。"""
        try:
            st = resp.status_code
            if st >= 400 and st not in (400, 403, 404):
                audit.event('HTTP%d' % st, resp.headers.get('Location', ''),
                            level=logging.ERROR if st >= 500 else logging.INFO)
        except Exception:
            pass
        return resp

    with app.app_context():
        db.create_all()
        # 增量加列（旧库升级）
        from sqlalchemy import text as _text
        _col_checks = [
            ('system_config', ('logo_path', 'login_bg_path'), 'VARCHAR(200)'),
            ('student', ('lessons_remaining',), 'INTEGER DEFAULT 0'),
            ('class_group', ('deduct_lessons',), 'INTEGER DEFAULT 1'),
            ('payment_record', ('lessons_bonus',), 'INTEGER DEFAULT 0'),
        ]
        for _tbl, _cols, _ddl in _col_checks:
            try:
                _exist = {r[1] for r in db.session.execute(_text(f'PRAGMA table_info({_tbl})')).fetchall()}
                for _col in _cols:
                    if _col not in _exist:
                        db.session.execute(_text(f'ALTER TABLE {_tbl} ADD COLUMN {_col} {_ddl}'))
                db.session.commit()
            except Exception:
                db.session.rollback()
        # 首次安装标记：无任何用户 → 跳 setup
        @app.before_request
        def _setup_gate():
            if request.endpoint in ('auth.setup', 'auth.login', 'static', 'healthz'):
                return None
            if not User.query.first():
                return redirect(url_for('auth.setup'))
            return None

    @app.before_request
    def _force_https_public():
        """公网一律 https；局域网直连（无 CF 头）不管。"""
        if not FORCE_HTTPS:
            return None
        proto = _edge_proto()
        if proto is None or proto == 'https' or request.is_secure:
            return None
        url = request.url.replace('http://', 'https://', 1)
        audit.event('HTTPS_UPGRADE', url, level=logging.INFO)
        return redirect(url, code=301)

    @app.after_request
    def _hsts(resp):
        """公网响应带上 HSTS：浏览器以后自己就走 https，不会再拿 http 试。"""
        try:
            if FORCE_HTTPS and HSTS_MAX_AGE != '0' and _edge_proto() is not None:
                resp.headers.setdefault('Strict-Transport-Security',
                                        'max-age=%s' % HSTS_MAX_AGE)
        except Exception:
            pass
        return resp

    @app.after_request
    def _no_cache(resp):
        # 管理端 HTML 禁止缓存：避免 iPad Safari 等用旧页面/旧交互（教训：2026-09-04 交互 bug 排查）
        if resp.mimetype == 'text/html':
            resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
            resp.headers['Pragma'] = 'no-cache'
            resp.headers['Expires'] = '0'
        return resp

    return app


@login_manager.user_loader
def load_user(uid):
    return db.session.get(User, int(uid))
