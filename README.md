# 课时本 LessonDesk

给中小型培训机构（琴行、画室、舞蹈、书法、托管……）用的**课时管理系统**。核心解决一件事：**谁还有多少课时，上过几次课，都扣了没。**

单机部署、SQLite 存数据、零外部依赖服务，一个 Docker 容器就能跑。适合一个机构一台小主机（或一台 NAS）自建的场景。

> 课时本（LessonDesk）是一套多校区的「课时本 + 报名表 + 台账」：教师上课点名自动消课，家长扫码填报名表，管理员看汇总和流水。

---

## 功能

### 校区与账号
- **多校区**：一套系统管多个校区，数据互相隔离；支持校区 logo、二维码、备注
- **三级角色**
  - `super_admin` 系统管理员：建校区、建校区管理员、看全部数据、改系统设置
  - `manager` 校区管理员：管本校区学员/班级/教师/报名/财务
  - `teacher` 教师：看自己的课表、点名消课、查自己的消课记录
- **首次安装引导**：第一次访问 `/setup` 创建系统管理员，无需手工灌数据

### 学员与课时
- 学员档案：姓名、性别、家长、手机号、生日、年级、备注、状态（在读/试听/归档）
- 学员详情页：剩余课时、报名班级、交费记录、课时明细（每一笔加减都有据可查）
- 课时调整留痕：谁调的、调了多少、为什么，全部进操作日志
- Excel 导出（openpyxl）

### 班级与排课
- 班级归属「校区 + 课程」，可指定任课教师、星期、起止时间、教室、容量（0 = 不限）
- **每次点名扣除课时数可配**：常规课 1，活动课/大师课可设 2、3
- 支持「超额消课」白名单（`allow_override` + 额外课时），应对补课等特殊情况

### 点名消课
- 按班级批量点名：到课/缺勤/请假，一次提交
- 单学员批量补扣（`/students/lessons-batch`）
- 每个班级一份「点名记录」，可回溯到具体某天某节课

### 报名入口（家长端）
- 管理员创建「报名批次」→ 生成一个随机 token 链接 `/r/<token>`
- 家长扫码/点链接打开表单填孩子信息，**不需要注册账号**
- 支持报名截止时间、批次开关、家长事后自助修改（`/r/<token>/modify`，有频率限制）
- 管理员审核：转为正式学员 / 取消，报名明细导出 Excel
- 每个报名入口可配联系人

### 财务台账
- 交费记录（金额仅作备注，不参与计算）、课时调整、校区支出
- 按校区隔离的流水视图

### 安全与运维
- CSRF 全局保护（Flask-WTF）
- 登录失败锁定（同 IP 5 次失败锁 10 分钟）
- 报表/修改接口限流（基于 `RateLimit` 表）
- **真实客户端 IP 解析**：兼容 Cloudflare Tunnel / 反代（`CF-Connecting-IP` → `X-Real-IP` → `X-Forwarded-For` → `remote_addr`），避免所有请求挤在 docker 网关上导致「一个人连错密码全站锁死」
- 操作审计日志（`instance/security.log` + stdout，记录登录/越权/CSRF/限流/改数据）
- 公网强制 HTTPS（带 `CF-Connecting-IP` 的请求若走 http → 301 + HSTS；局域网直连不受影响）
- `/healthz` 健康检查，Dockerfile 自带 HEALTHCHECK

---

## 技术栈

| 层 | 选型 |
|---|---|
| Web | Flask 3.0 |
| ORM | Flask-SQLAlchemy 3.1 |
| 认证 | Flask-Login 0.6 |
| 表单/CSRF | Flask-WTF 1.2 |
| 服务 | gunicorn 22（1 worker + 8 threads，SQLite 友好） |
| 存储 | SQLite（WAL） |
| 前端 | 服务端渲染 Jinja2 + Bootstrap 5（本地 vendor，不依赖 CDN）+ Bootstrap Icons |
| 导出 | openpyxl 3.1 |

没有前端构建步骤，没有 Node，没有 Redis，没有 Celery。

---

## 快速开始

### 方式一：Docker Compose（推荐）

```bash
git clone https://github.com/<你的账号>/lessondesk.git
cd lessondesk

# 生成一个强随机 SECRET_KEY（务必改掉默认值）
cp .env.example .env
sed -i "s/^SECRET_KEY=.*/SECRET_KEY=$(openssl rand -hex 32)/" .env

docker compose up -d --build
```

打开 `http://<主机IP>:28001/setup`，创建第一个系统管理员账号，完事。

数据落在宿主机 `./data/`（`instance/app.db` + `uploads/`），容器删了数据还在。

### 方式二：直接跑（开发）

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

export SECRET_KEY=$(python3 -c "import secrets;print(secrets.token_hex(32))")
python3 -c "from app import create_app; create_app().run(port=5000)"
```

同样先访问 `/setup` 初始化。

---

## 配置

全部通过环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `SECRET_KEY` | `change-me-please` | **必须改**。会话签名密钥，短于 16 位或留占位符会在启动时打 critical 日志 |
| `TZ` | `Asia/Shanghai` | 时区 |
| `FORCE_HTTPS` | `1` | 公网（带 `CF-Connecting-IP`）走 http 时 301 到 https。设 `0` 关闭 |
| `HSTS_MAX_AGE` | `15552000` | HSTS max-age（秒），`0` 关闭 HSTS 头 |
| `TRUST_PROXY_HEADERS` | `1` | 是否采信反代注入的客户端 IP 头。设 `0` 只用 `remote_addr` |

---

## 生产部署建议

课时本本身只管 HTTP，**HTTPS 和公网暴露交给反向代理**。两种常见做法：

**A. 内网使用**：直接 `28001` 端口访问，或者前面挂 Nginx/Caddy 做 TLS。

**B. 公网访问（推荐 Cloudflare Tunnel）**：不起任何入站端口，直接映射到容器 5000/28001。

```bash
cloudflared tunnel --url http://127.0.0.1:28001
```

走 Cloudflare 的时候有两个细节课时本已经处理了：
1. `CF-Connecting-IP` 优先作为真实客户端 IP（限流、登录锁定才准）
2. 带 `CF-Connecting-IP` 的明文 http 请求自动 301 到 https

> ⚠️ 如果容器端口直接暴露在公网，请在宿主机防火墙或反代上限制来源；课时本的 CSRF / 限流只防脚本刷接口，不防扫描器。

---

## 目录结构

```
.
├── app/
│   ├── __init__.py      # 应用工厂、配置、HTTPS 与 SECRET_KEY 加固
│   ├── models.py        # 全部数据模型（Campus/User/Student/ClassGroup/...）
│   ├── auth.py          # 登录 / 首装 / 改密 / 失败锁定
│   ├── admin.py         # 校区、账号、课程、系统设置
│   ├── students.py      # 学员档案、课时调整、批量补扣
│   ├── classes.py       # 班级与报名入班
│   ├── lessons.py       # 教师课表、点名消课
│   ├── register.py      # 家长报名入口（token 链接）
│   ├── finance.py       # 收支台账
│   ├── decorators.py    # roles() 权限装饰器
│   ├── netutil.py       # 可信客户端 IP 解析
│   ├── audit.py         # 审计日志
│   ├── utils.py         # 时间/金额/token 工具
│   ├── templates/       # Jinja2 模板
│   └── static/          # CSS / 本地 vendor / 上传目录
├── scripts/
│   ├── smoke.py         # 全链路冒烟测试（HTTP 层）
│   └── run_test.sh      # 起测试实例 + 跑冒烟
├── Dockerfile
├── docker-compose.yml
└── requirements.txt
```

---

## 冒烟测试

不依赖 pytest，直接起一个临时实例打真实 HTTP 请求（覆盖首装 → 建校区 → 建账号 → 建班级 → 点名 → 报名 → 导出全链路）：

```bash
./scripts/run_test.sh 28012
```

---

## 数据与备份

- 唯一数据源是 `instance/app.db`（SQLite，WAL 模式）
- **备份就是复制这个文件**（连同 `-wal`/`-shm` 一起，或先 `sqlite3 app.db ".backup"`）
- 建议放到 crontab 每天跑一次，异地留几份

---

## 已知限制

- **单写者**：SQLite 决定了并发写入能力有限。gunicorn 固定 1 worker + 8 threads，够一个机构几十人日常用，不适合大流量
- **没有多租户**：一套部署 = 一个机构（多校区在机构内部）
- **没有在线支付**：交费金额只作台账备注，实际收款走线下/第三方
- **没有短信/微信通知**：报名结果靠管理员线下通知
- 前端是服务端渲染，没做 SPA / PWA

---

## 贡献

欢迎 issue 和 PR。改动前请：

1. 跑一遍 `./scripts/run_test.sh`，确认全绿
2. 涉及数据库结构的改动，请附带迁移脚本（参考 `scripts/` 下已有迁移的写法）
3. 不要把真实学员数据、生产库、`.env` 提交上来

详细见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## License

[MIT](LICENSE)
