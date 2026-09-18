"""工具函数"""
import secrets
import re
from datetime import datetime
from .models import bj_now


def gen_token(n=16):
    return secrets.token_hex(n)


def money_cents(yuan_str):
    """'123.45' 元 -> 分。失败返回 None"""
    try:
        v = round(float(str(yuan_str).strip()) * 100)
        return v if v >= 0 else None
    except (TypeError, ValueError):
        return None


def fmt_money(cents):
    if cents is None:
        return '0.00'
    return f'{cents / 100:.2f}'


def validate_phone_full(p):
    return bool(re.fullmatch(r'1[3-9]\d{9}', str(p or '').strip()))


def validate_phone_last4(p):
    return bool(re.fullmatch(r'\d{4}', str(p or '').strip()))


def weekday_list():
    return ['周一', '周二', '周三', '周四', '周五', '周六', '周日']


def client_ip():
    """真实客户端 IP。

    课时本在 Cloudflare Tunnel + Docker 端口映射后面，容器内 `remote_addr` 恒为
    docker 网关（172.23.0.1），直接用它会让登录失败锁与报名限流变成"全站共享
    一个桶"。详见 app/netutil.py（2026-09-17 加固）。
    """
    from .netutil import client_ip as _cip
    return _cip()


def client_ip_source():
    """调试/日志用：返回 (ip, 来源头名)。"""
    from .netutil import client_ip_source as _cips
    return _cips()


def log_op(user_id, target, target_id, action, detail=''):
    """写操作日志（调用方自行 commit）"""
    from .models import OperationLog, db
    db.session.add(OperationLog(user_id=user_id, target=target, target_id=target_id,
                                action=action, detail=detail[:2000]))
