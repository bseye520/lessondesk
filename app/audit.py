"""安全审计日志（课时本加固 2026-09-17）

为什么需要
----------
之前 403 / 400 / 500 既不写库也不落日志，出问题只能靠猜（只能临时做一份库副本
+ 起一个临时容器去复现）。现在统一记到：

* 容器 stdout（`docker logs lessondesk` 能看到）
* `instance/security.log`（2 MB 轮转，留 5 份；instance 是 bind mount，重启不丢）

记录内容：时间 / 事件 / 状态码 / 用户名 / 角色 / 真实 IP / 路径 / 原因 / UA / Referer。
**不记录密码、不记录 cookie。**
"""
import logging
import os
from logging.handlers import RotatingFileHandler

LOG_NAME = 'lessondesk.security'
_logger = None


def setup(app, instance_dir=None):
    """挂上 handler（幂等）。"""
    global _logger
    _logger = logging.getLogger(LOG_NAME)
    if _logger.handlers:
        return _logger
    _logger.setLevel(logging.INFO)
    _logger.propagate = False
    fmt = logging.Formatter('%(asctime)s %(levelname)-7s %(message)s', '%Y-%m-%d %H:%M:%S')

    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    _logger.addHandler(sh)

    if instance_dir:
        try:
            fh = RotatingFileHandler(os.path.join(instance_dir, 'security.log'),
                                     maxBytes=2 * 1024 * 1024, backupCount=5,
                                     encoding='utf-8')
            fh.setFormatter(fmt)
            _logger.addHandler(fh)
        except OSError:
            pass  # 落不了盘也不能影响业务
    return _logger


def _logger_or_make():
    global _logger
    if _logger is None:
        _logger = setup(None)
    return _logger


def _who():
    """当前请求的身份 + 网络信息（任何异常都吞掉，日志不能拖垮请求）。"""
    try:
        from flask import request
        from flask_login import current_user
        from .netutil import client_ip_source
        ip, src = client_ip_source()
        authed = getattr(current_user, 'is_authenticated', False)
        return dict(
            user=(getattr(current_user, 'username', '-') if authed else '-'),
            role=(getattr(current_user, 'role', '-') if authed else '-'),
            ip=ip, ip_src=src,
            path=(request.full_path or request.path or '')[:200].rstrip('?'),
            ua=(request.headers.get('User-Agent') or '')[:140],
            ref=(request.headers.get('Referer') or '')[:200],
        )
    except Exception:
        return dict(user='?', role='?', ip='?', ip_src='?', path='?', ua='', ref='')


def event(kind, detail='', level=logging.WARNING):
    """记一条审计事件。kind 例：DENY / CSRF / ERROR / LOGIN_FAIL / LOGIN_OK / RATELIMIT。"""
    try:
        w = _who()
        _logger_or_make().log(
            level,
            '%-11s user=%-12s role=%-11s ip=%-15s via=%-18s path=%-40s %s ua=%r ref=%r',
            kind, w['user'], w['role'], w['ip'], w['ip_src'], w['path'],
            ('detail=' + detail[:300]) if detail else '', w['ua'], w['ref'])
    except Exception:
        pass
