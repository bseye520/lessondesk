# 课时本 LessonDesk · Cloudflare Workers 版

给中小型培训机构（画室、琴行、舞蹈、书法、托管……）自建的**内部课时管理系统** —— Cloudflare 无服务器版本。

本项目是 [课栈开源版](../)（Flask + SQLite + Docker）的 **Cloudflare 版孪生实现**：同样的业务规则、同样的界面语言，但把运行环境换成了 **Cloudflare Workers + D1 + 私有 R2**。没有服务器要维护，不需要装 Docker，免费额度即可跑一个小机构。

> 两个版本可以并存。想要「一台小主机自己跑」选 [Flask 版](../)；想要「不运维、有公网 HTTPS、手机随时用」选这个。

## 它是什么（和多数同类系统不一样的地方）

- **给机构自己人用，不是给家长注册的。** 只有系统管理员 / 校区管理员 / 教师三种角色，全部由机构内部建号。
- **家长永远不用注册。** 报名用一次性链接（`/r/<token>`），家长填完即走；查课时/看作品用高熵分享链接（`/p/<token>`），可随时停用或轮换。
- **多校区隔离。** 一套系统管多个校区，数据互相隔离，总管理员看全局。
- **只算清一件事：谁还有多少课时、上过几次、扣了没。** 不塞商城、不做支付、不接短信微信。

## 技术栈

| 层 | 用了什么 |
|---|---|
| 运行时 | Cloudflare Workers（JavaScript ES Modules，SSR + 表单/Ajax） |
| 数据库 | Cloudflare D1（SQLite），消课/撤销/缴费等走事务与唯一约束兜底 |
| 图片 | 私有 R2 桶，只经权限检查的 Worker 接口读取，**不开放 public bucket** |
| 前端 | 原生 HTML/CSS/JS + Bootstrap（本地 vendor，不走 CDN） |
| 测试 | `node:test` + 内置 SQLite 模拟 D1，离线跑全部业务回归 |

## 快速开始（部署到你自己的 Cloudflare 账户）

前置：Node.js 22+、一个 Cloudflare 账户。

```bash
npm install
npx wrangler login

# 1) 建 D1 数据库（把输出的 database_id 填进 wrangler.jsonc）
npx wrangler d1 create lesson-desk-db

# 2) 建私有 R2 桶
npx wrangler r2 bucket create lesson-desk-artworks

# 3) 建表（远程）
npx wrangler d1 migrations apply DB --remote

# 4) 设置两个密钥（自己生成随机串，不要提交进仓库）
npx wrangler secret put SETUP_KEY          # 首次初始化用的部署密钥
npx wrangler secret put IP_HASH_SECRET     # 点赞/限速用的 IP 哈希盐

# 5) 部署
npx wrangler deploy
```

部署完访问 `https://<你的-worker>.workers.dev/setup`，用 `SETUP_KEY` 创建第一个系统管理员与校区。要绑自有域名，在 `wrangler.jsonc` 里加 `routes`（`custom_domain: true`）。

**本地开发**

```bash
npx wrangler d1 migrations apply DB --local   # 建本地库
cp .dev.vars.example .dev.vars                # 填本地用的 SETUP_KEY / IP_HASH_SECRET
npx wrangler dev                              # http://localhost:8787
```

**测试**

```bash
npm run check   # JS 语法
npm test        # 离线业务回归（不需要 Cloudflare 凭据）
```

## 目录结构

```
src/
  index.js      路由与页面渲染（含 GET/POST 全部分支）
  workflows.js  业务事务：消课/撤销/缴费/退费/班级/报名/作品/点赞
  auth.js       登录、会话、CSRF、校区权限隔离
  media.js      头像 / Logo / 二维码（私有 R2）
  ui.js         服务端模板（布局、表格、表单、移动端抽屉）
  lib.js        D1 辅助、哈希与密码校验、日期等
public/         前端静态资源（含本地 vendor）
migrations/     0001 首次建表 / 0002 品牌与头像 / 0003 V7 增量
scripts/        备份、恢复、旧库导出、远端冒烟与校验
tests/          离线回归测试（node:test）
```

## 安全与隐私设计

- **作品只进私有 R2**，经 `GET /media/:id`（带权限校验）读取；家长分享页只显示授权公开的作品。
- **元数据剥离**：上传的 JPEG 在写入 R2 前由服务端剥掉 `APP0–APP15` / `COM` 段（EXIF、GPS、XMP、ICC、注释一律不留）；WebP 侧拒绝含 `EXIF/XMP` 的文件。
- **分享链接是持链接即授权**，可停止/轮换；页面**不显示**电话、缴费与内部备注。
- **点赞**按「作品 + 隐私哈希 IP」每 24 小时一次（同一家庭网络会互相影响，不是实名防刷）。
- 登录：HttpOnly/SameSite Cookie 会话、CSRF、按 IP 哈希限速；兼容旧 Werkzeug `pbkdf2`/`scrypt` 密码哈希，便于从旧库迁移。

### ⚠️ 在 Cloudflare 上务必注意（踩过的坑）

1. **PBKDF2 迭代数硬上限 100000**。写 200000+ 会在生产直接抛 `NotSupportedError`（本地 `wrangler dev` 反而不报错）。
2. **WebP 的色彩配置块 `ICCP` 不是隐私数据**。`canvas.toBlob('image/webp')` 默认会写入 `ICCP`，校验器若把它和 `EXIF/XMP` 一起拒绝，Chromium/Safari 上传会全部 400。只拦 `EXIF/XMP`。
3. **D1 的 `meta.changes` 在触发器/被 `WHERE` 拦下的 upsert 场景不可靠**。要用 `INSERT … ON CONFLICT … WHERE … RETURNING` 判空，别拿 `changes` 判断“是否写成功”。
4. **路由要归一化尾斜杠**（`/students/1/` 视作 `/students/1`），但**POST 不要重定向**——重试可能重复写财务。

## 备份与迁移

- `scripts/backup_data.sh`：完整导出 D1（SQL）+ 校验和
- `scripts/restore_to_fresh_d1.sh`：从备份恢复到新 D1 演练
- `scripts/export_legacy.py` / `verify_remote.py`：从旧版 SQLite（Flask 版）导出并校验迁移
- `scripts/upgrade_existing_v71.sh`：既有部署的安全升级入口（资源校验 → 备份 → 只换代码 → 复核）

## 许可

MIT，见 [LICENSE](LICENSE)。
