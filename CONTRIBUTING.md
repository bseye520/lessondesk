# 贡献指南

## 提交前

```bash
# 全链路冒烟（会起一个临时实例，用独立的临时数据库，不动你自己的数据）
./scripts/run_test.sh 28012
```

必须全绿再提 PR。

## 红线

- ❌ 不要把 `instance/`、`data/`、任何 `*.db` 提交上来 —— 那里面有真实学员的手机号
- ❌ 不要提交 `.env`、`SECRET_KEY`、机构自己的 logo/二维码
- ❌ 不要在代码里硬编码机构名、校区名、人名、手机号

## 代码风格

- Python：跟随现有文件风格（4 空格、单引号、模块顶部写清楚「为什么」的中文注释）
- 涉及权限的路由**必须**加 `@roles(...)` 装饰器，不要只靠模板隐藏按钮
- 涉及写操作的路由**必须**有 CSRF token（全局已开）并调 `log_op()` 留痕
- 模板：Bootstrap 5 类名 + 现有 `card-ld` / `stat-card` 组件，别引入新的 CSS 框架

## 数据库改动

SQLite 没有迁移框架。改表结构的做法是：

1. 改 `app/models.py`
2. 在 `scripts/` 下加一个幂等的迁移脚本（`ALTER TABLE ... ADD COLUMN` 前先查 `PRAGMA table_info`，可重复执行）
3. PR 描述里写清楚：改了什么、老库怎么升级、怎么回滚

## 报告问题

Issue 里请带上：

- 部署方式（直接跑 / Docker / 反代类型）
- `/healthz` 返回
- 复现步骤
- 相关日志（`docker logs` 或 gunicorn stderr）—— **记得打码手机号和学员姓名**
