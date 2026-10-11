# 更新与升级说明（Cloudflare 版）

## 版本时间线

| 版本 | 日期 | 主要变化 |
|---|---|---|
| **V7** | 2026-10-11 | 首次完整 Cloudflare 化：Workers + D1 + 私有 R2；新增品牌资料、头像、数据与备份中心、退费、试听不扣费、回填历史授课日期；`migrations/0003_v7.sql`（增量、幂等） |
| V7.0.1 | 2026-10-11 | 作品上传：拆成「📷 拍照」「▣ 相册」两个入口；前端一次解码压缩（≤1600px、目标 ≤750KB）；显示压缩/整次/R2/D1 耗时；失败后可查上传状态不重复提交 |
| V7.0.2 | 2026-10-11 | 相册兼容：WebP 编码失败自动退 JPEG；后端按真实签名校验；JPEG 拒绝 EXIF/XMP/IPTC/注释，允许必要色彩配置 |
| V7.0.3 | 2026-10-11 | 服务端 **JPEG 元数据剥离**（`stripJpegMetadata`：校验结构后剥掉 APP0–APP15/COM 再写入 R2）；上传说明折叠、去嵌套边框；静态资源版本号更新 |
| **V7.1** | 2026-10-12 | **本版**：尾斜杠路由归一化；校区重命名；保存后成功提示；整合前几版上传修复 |

## V7.1 改了什么

1. **尾斜杠 404 修复**：`/students/1/`、`/classes/`、`/finance/` 等带尾斜杠的地址与不带尾斜杠**行为完全一致**。
   内部归一化，**GET/POST 都不做重定向**——避免浏览器重试导致重复写入（财务类接口尤其重要）。
2. **校区重命名**：系统管理员可重命名所有校区；校区管理员只能改自己校区。
   只写 `campus.name` 与审计日志，**不改** `id`、`code`、教师、班级、余额、分享链接。
3. **内部名称 / 品牌名称分离**：「管理 → 校区名称」改内部名；「管理 → 画室品牌」改网站与家长页展示名、Logo、二维码、联系资料。
4. **保存提示**：普通表单保存后显示短暂「已保存」，地址栏不残留标记。
5. 包含 V7.0.1–V7.0.3 的全部上传兼容改进。

## 升级既有部署（重要）

**本版没有数据库结构变更**（`migrations/` 与 V7.0.3 逐字节一致），升级 = 只换 Worker 代码与静态资源。

```bash
# 1) 备份（务必先做）
npx wrangler d1 export DB --remote --output backup-$(date +%Y%m%d).sql

# 2) 核对资源绑定：wrangler.jsonc 里的 Worker 名 / D1 ID / R2 桶名
#    （本仓库里是占位符，必须以你自己的实际 ID 为准）

# 3) 安全升级（会再次校验资源 → 导出 D1 → 只部署代码 → 复核计数）
export CONFIRM_LIVE_UPDATE=YES
export EXPECTED_WORKER_NAME='你的 Worker 名'
export EXPECTED_D1_ID='你的 D1 数据库 ID'
export EXPECTED_R2_BUCKET='你的 R2 桶名'
export EXPECTED_SITE_URL='https://你的域名'
bash scripts/upgrade_existing_v71.sh
```

脚本会校验资源标识、跑本地检查与测试、导出 D1、只部署代码，并**核对升级前后**的学员数/总余额/班级数/流水数/作品数是否一致；不一致会直接中止。

**从 Flask 旧版迁移**：先用 `scripts/export_legacy.py` 从旧 SQLite 只读导出（**离线、不上传**），再用生成的导入脚本写入**空** D1（`migrations/0001` 已建表）。旧密码（Werkzeug `pbkdf2`/`scrypt`）可直接沿用登录。

## 回滚

```bash
npx wrangler versions list                 # 找到升级前的版本 ID
npx wrangler rollback <version-id>         # 回滚代码
```

由于本版**不改数据库结构**，代码回滚是安全的。但**不要**用旧的 D1 快照整体覆盖——期间产生的真实课时流水会丢；必要时按操作日志逐笔核对修正。

## 注意

- 升级窗口内请让老师暂停消课、管理员暂停编辑，避免前后快照不一致。
- 若 `wrangler.jsonc` 仍是占位 `database_id`，`wrangler deploy` 会失败或绑到错误库，先填对再部署。
- Cloudflare 侧的四个坑（PBKDF2 上限、WebP 的 ICCP、D1 `meta.changes`、尾斜杠 POST 重定向）详见 [README](README.md#️-在-cloudflare-上务必注意踩过的坑)。
