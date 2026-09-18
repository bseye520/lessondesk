#!/usr/bin/env python3
"""课时本 LessonDesk 全链路冒烟测试 v2"""
import re
import sys
import urllib.request
import urllib.parse
import http.cookiejar

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:28011'
jar = http.cookiejar.CookieJar()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(jar), NoRedirect)

PASS, FAIL = [], []


def req(path, data=None):
    body = urllib.parse.urlencode(data, doseq=True).encode() if data else None
    r = urllib.request.Request(BASE + path, data=body)
    try:
        resp = opener.open(r, timeout=15)
        return resp.status, resp.read().decode('utf-8', 'ignore')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'ignore')


def csrf(html):
    m = re.search(r'name="csrf_token" value="([^"]+)"', html)
    return m.group(1) if m else None


def req2(path, data=None):
    """同 req，但连响应头一起返回：-> (status, headers, body)"""
    url = BASE + path
    body = urllib.parse.urlencode(data).encode() if data else None
    r = urllib.request.Request(url, data=body)
    try:
        with opener.open(r, timeout=15) as resp:
            return resp.status, {k: v for k, v in resp.headers.items()}, resp.read().decode('utf-8', 'ignore')
    except urllib.error.HTTPError as e:
        return e.code, {k: v for k, v in e.headers.items()}, e.read().decode('utf-8', 'ignore')


def login_as(username, password):
    """先登出，再 GET login 拿 csrf 再 POST"""
    req('/logout')
    st, h = req('/login')
    tok = csrf(h)
    st, h = req('/login', {'csrf_token': tok, 'username': username,
                           'password': password})
    return st == 302


def check(name, cond, extra=''):
    (PASS if cond else FAIL).append(name)
    print(('  ✅ ' if cond else '  ❌ ') + name + (f'  [{extra}]' if extra else ''))


def main():
    # 0. setup
    st, h = req('/setup')
    check('setup 页 200', st == 200)
    tok = csrf(h)
    st, h = req('/setup', {'csrf_token': tok, 'site_name': '课时本测试',
                           'username': 'boss', 'password': 'boss123456',
                           'password2': 'boss123456'})
    check('首装创建超管 302', st == 302, f'st={st}')
    st, h = req('/admin')
    check('超管 /admin 200', st == 200)

    # 1. 校区
    tok = csrf(h)
    st, h = req('/admin/campus/create', {'csrf_token': tok, 'name': '示例校区A',
                                         'code': 'GG01'})
    check('建校区1', st == 302)
    st, h = req('/admin/campus/create', {'csrf_token': tok, 'name': '示例校区B',
                                         'code': 'HY01'})
    check('建校区2', st == 302)

    # 2. 账号
    st, h = req('/admin/users')
    tok = csrf(h)
    st, h = req('/admin/user/create', {'csrf_token': tok, 'username': 'mgr1',
                                       'password': 'mgr123456', 'role': 'manager',
                                       'campus_id': '1'})
    check('建 manager', st == 302)
    st, h = req('/admin/user/create', {'csrf_token': tok, 'username': 'tea1',
                                       'password': 'tea123456', 'role': 'teacher',
                                       'campus_id': '1'})
    check('建 teacher', st == 302)

    # 3. manager 登录 + 课程班次
    check('manager 登录', login_as('mgr1', 'mgr123456'))
    st, h = req('/dashboard')
    check('manager dashboard 200', st == 200)
    st, h = req('/admin/courses')
    tok = csrf(h)
    st, h = req('/admin/course/create', {'csrf_token': tok, 'name': '素描',
                                         'category': '素描'})
    check('建课程', st == 302)
    st, h = req('/classes')
    tok = csrf(h)
    st, h = req('/classes/new', {'csrf_token': tok, 'name': '素描一班周六',
                                 'course_id': '1', 'teacher_id': '3',
                                 'weekday': '周六', 'start_time': '09:00',
                                 'end_time': '10:30', 'room': '1号教室',
                                 'capacity': '10'})
    check('建班次1(容量10)', st == 302)
    st, h = req('/classes/new', {'csrf_token': tok, 'name': '素描二班周日',
                                 'course_id': '1', 'teacher_id': '3',
                                 'weekday': '周日', 'start_time': '14:00',
                                 'end_time': '15:30', 'room': '2号教室',
                                 'capacity': '2'})
    check('建班次2(容量2)', st == 302)

    # 4. 学员
    st, h = req('/students')
    tok = csrf(h)
    req('/students/new', {'csrf_token': tok, 'name': '小明', 'phone': '13800000001',
                          'grade': '三年级', 'class_group_id': '1'})
    req('/students/new', {'csrf_token': tok, 'name': '小红', 'phone': '13800000002',
                          'class_group_id': '2'})
    st, h = req('/students/new', {'csrf_token': tok, 'name': '小刚',
                                  'phone': '13800000003'})
    check('建档 小明/小红/小刚', st == 302)
    # 重复手机号
    req('/students/new', {'csrf_token': tok, 'name': '小明2',
                          'phone': '13800000001'})
    st, h = req('/students')
    check('重复手机号被拒', '该手机号' in h or '已有学员' in h)
    check('列表含三人', all(x in h for x in ['小明', '小红', '小刚']))

    # 5. 充值（小刚 id=3）
    req('/students/3/contract', {'csrf_token': tok, 'lessons': '20', 'bonus': '0',
                                 'amount': '100', 'remarks': '2026秋季班'})
    st, h = req('/students/3')
    check('小刚详情 20 节', '2026秋季班' in h and '20' in h, 'st=%s' % st)
    # 小刚入班2 → 班2满(2人)
    tok = csrf(h)
    st, h = req('/students/3/enroll', {'csrf_token': tok, 'class_group_id': '2'})
    check('小刚入班2', st == 302)
    # 班2(2人满)直接加人应被拒（后端 is_full）
    st, h = req('/classes')
    tok2 = csrf(h)
    st, h = req('/classes/2/enroll', {'csrf_token': tok2, 'student_id': '1'})
    st, h = req('/classes')
    check('班2 满员拒绝加人(仍2人)', '在班 2 人' in h)

    # 6. teacher 消课
    check('teacher 登录', login_as('tea1', 'tea123456'))
    st, h = req('/me')
    check('教师主页含班次', st == 200 and '素描二班' in h, 'st=%s' % st)
    st, h = req('/attendance/2')
    tok = csrf(h)
    check('点名页 200 含学生', st == 200 and '小红' in h and '小刚' in h, 'st=%s' % st)
    st, h = req('/lessons/batch', {'csrf_token': tok, 'class_group_id': '2',
                                   'duration': '60', 'student_ids': ['2', '3'],
                                   'status_2': 'present', 'status_3': 'present'})
    check('消课提交', st == 302, f'st={st}')
    st, h = req('/students/3')
    check('小刚 20→19', '19' in h, 'h=%s' % h[h.find('剩余'):h.find('剩余') + 60])
    # 消课记录页可见（撤销已改为「管理员在学员详情调整课时」，见第 9 节）
    st, h = req('/lessons')
    check('消课记录页有记录', st == 200 and '小刚' in h, 'st=%s' % st)

    # 7. 报名
    check('manager 登录', login_as('mgr1', 'mgr123456'))
    st, h = req('/admin/entries')
    tok = csrf(h)
    st, h = req('/admin/entries/create', {'csrf_token': tok, 'name': '2026秋季报名'})
    check('建报名入口', st == 302)
    st, h = req('/admin/entries')
    m = re.search(r'/r/([0-9a-f]{32})', h)
    token = m.group(1) if m else ''
    check('拿到入口 token', bool(token), h[-150:])
    # 家长报名（清空 cookie 模拟无登录）
    st, h = req(f'/r/{token}')
    check('家长选班页', st == 200 and '素描一班' in h, f'st={st}')
    tok = csrf(h)
    st, h = req(f'/r/{token}', {'csrf_token': tok, 'name': '王小明', 'grade': '二年级',
                                'phone_last4': '8888', 'class_group_id': '1'})
    check('家长报名成功页含修改码', st == 200 and '修改码' in h, f'st={st}')
    code = re.search(r'(\d{6})', h[h.find('修改码'):h.find('修改码') + 120])
    # 重复
    st, h = req(f'/r/{token}', {'csrf_token': tok, 'name': '王小明', 'grade': '二年级',
                                'phone_last4': '8888', 'class_group_id': '1'})
    check('重复报名被拒', '已报名' in h or '已存在' in h or '频繁' in h)
    # 满员班禁用
    st, h = req(f'/r/{token}')
    check('满员班(素描二班)禁用', 'disabled' in h)
    # 管理确认
    st, h = req('/register/manage')
    tok = csrf(h)
    check('待确认含王小明', '王小明' in h)
    m = re.search(r'/register/(\d+)/confirm', h)
    rid = m.group(1) if m else ''
    st, h = req(f'/register/{rid}/confirm', {'csrf_token': tok,
                                             'guardian_phone': '13900008888',
                                             'guardian_name': '王爸爸'})
    check('确认建档 302', st == 302, f'st={st}')
    st, h = req('/students')
    check('王小明已在学员列表', '王小明' in h)
    st, h = req('/register/manage?status=confirmed')
    check('确认列表有记录', '王小明' in h)

    # 8. 越权
    check('teacher 登录', login_as('tea1', 'tea123456'))
    st, h = req('/classes')
    check('teacher 访问班次管理 403', st == 403, f'st={st}')
    st, h = req('/finance')
    check('teacher 访问财务 403', st == 403, f'st={st}')
    st, h = req('/admin/users')
    check('teacher 访问账号管理 403', st == 403)

    # 9. 财务支出 + 管理员调整课时
    check('manager 登录', login_as('mgr1', 'mgr123456'))
    st, h = req('/students/3')
    tok = csrf(h)
    st, h = req('/students/3/adjust', {'csrf_token': tok, 'delta': '2',
                                       'remarks': '老师误扣 2 节，补回'})
    check('管理员调整课时 302', st == 302, f'st={st}')
    st, h = req('/students/3')
    check('小刚 19→21 节', '21' in h, 'st=%s' % st)

    st, h = req('/finance')
    tok = csrf(h)
    st, h = req('/finance/expense', {'csrf_token': tok, 'category': '耗材',
                                     'amount': '150.5', 'remarks': '画纸'})
    check('记支出 302', st == 302, f'st={st}')
    st, h = req('/finance')
    check('财务页含 150.50', '150.50' in h, f'st={st}')

    # 10. PWA（可安装 / 离线 / 图标 / 类型正确的 manifest）
    st, hd, body = req2('/manifest.webmanifest')
    ct = hd.get('Content-Type', '')
    check('PWA manifest 200', st == 200, f'st={st}')
    check('manifest MIME 正确', 'manifest+json' in ct, ct)
    check('manifest 内容完整', '"课时本"' in body and '"standalone"' in body and 'icon-512.png' in body)
    st, hd, body = req2('/sw.js')
    ct = hd.get('Content-Type', '')
    check('Service Worker 200', st == 200, f'st={st}')
    check('SW MIME 正确', 'javascript' in ct, ct)
    check('SW 作用域=全站', hd.get('Service-Worker-Allowed') == '/', str(hd.get('Service-Worker-Allowed')))
    check('SW 只缓存 /static/', "CACHEABLE_PREFIXES = ['/static/']" in body)
    check('SW 不缓存敏感路径', "'/students'" in body and 'NEVER_CACHE_EXACT' in body and 'NEVER_CACHE_PREFIX' in body)
    check('SW 导航 network-first', "req.mode === 'navigate'" in body)
    st, hd, body = req2('/offline')
    check('离线页(路由) 200', st == 200 and '网络好像断开了' in body, f'st={st}')
    st, hd, body = req2('/static/offline.html')
    check('离线页(静态) 200', st == 200 and '网络好像断开了' in body, f'st={st}')
    for ic in ('icon-192.png', 'icon-512.png', 'icon-maskable-192.png',
               'icon-maskable-512.png', 'apple-touch-icon.png', 'favicon-32.png'):
        st, hd, _ = req2('/static/icons/' + ic)
        check('图标 ' + ic, st == 200, f'st={st}')
    st, hd, _ = req2('/login')
    cc = hd.get('Cache-Control', '')
    check('登录页禁止缓存(no-store)', 'no-store' in cc, cc)

    print()
    print(f'==== 结果: {len(PASS)} 通过, {len(FAIL)} 失败 ====')
    if FAIL:
        print('失败项:')
        for f in FAIL:
            print('  -', f)
        sys.exit(1)


if __name__ == '__main__':
    main()
