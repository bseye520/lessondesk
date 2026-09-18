"""可信客户端 IP 解析（课时本加固 2026-09-17）

背景
----
课时本跑在 Cloudflare Tunnel + Docker 端口映射后面，容器内看到的
`request.remote_addr` 恒为 docker 网关（实测 172.23.0.1）。后果：

* 登录失败锁定变成"全站共享一个桶"：任何人连错 5 次密码，**所有人** 10 分钟登不上；
* 家长报名的限流（10 次/分）和修改限流（5 次/分）也变成**全站共享额度**。

做法
----
只有当直连对端是"可信代理"（回环 / 私有网段，也就是 docker-proxy 或本机反代）时，
才采信代理注入的头部；否则退回 `remote_addr`。

优先级：`CF-Connecting-IP` > `X-Real-IP` > `X-Forwarded-For`(第一段) > `remote_addr`。

安全说明
--------
`CF-Connecting-IP` 由 Cloudflare 边缘**覆盖写入**（客户端自己传的同名头会被丢弃），
所以经隧道进来时不可伪造。若有人能从本机直接访问容器端口并伪造该头，
最坏后果只是绕过/污染限流计数（不涉及鉴权），影响可控。
要彻底关门可把端口映射改成只绑回环：`127.0.0.1:28001:5000`。

关掉代理头解析：环境变量 `TRUST_PROXY_HEADERS=0`。
"""
import ipaddress
import os

from flask import request

TRUST_PROXY_HEADERS = os.environ.get('TRUST_PROXY_HEADERS', '1') != '0'
PROXY_HEADERS = ('CF-Connecting-IP', 'X-Real-IP', 'X-Forwarded-For')


def _is_trusted(addr):
    """直连对端是否是可信代理（docker-proxy / 本机反代）。"""
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    return ip.is_loopback or ip.is_private or ip.is_link_local


def _clean(value):
    """把头部值洗成一个合法 IP，失败返回 None。"""
    v = (value or '').strip()
    if not v:
        return None
    # XFF 可能是 "client, proxy1, proxy2"，只取第一段
    if ',' in v:
        v = v.split(',', 1)[0].strip()
    if v.startswith('[') and ']' in v:          # [::1]:1234
        v = v[1:v.index(']')]
    elif v.count(':') == 1 and '.' in v:        # 1.2.3.4:1234
        v = v.split(':', 1)[0]
    try:
        ipaddress.ip_address(v)
        return v
    except ValueError:
        return None


def resolve(peer, headers):
    """纯函数版（便于单测）：给定对端地址与头部映射，返回 (ip, 来源)。"""
    if TRUST_PROXY_HEADERS and _is_trusted(peer or ''):
        for name in PROXY_HEADERS:
            got = _clean(headers.get(name))
            if got:
                return got, name
    return (peer or 'unknown'), 'peer'


def client_ip():
    """本次请求的真实客户端 IP。"""
    ip, _ = resolve(request.remote_addr, request.headers)
    return ip


def client_ip_source():
    """调试用：IP 与它的来源头名。"""
    return resolve(request.remote_addr, request.headers)
