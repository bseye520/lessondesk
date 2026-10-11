#!/usr/bin/env python3
"""只读导出旧 SQLite 为 D1 导入 SQL；绝不在原数据库上修改。"""
import argparse, sqlite3, json, pathlib, datetime, hashlib, shlex, collections, sys
TABLES = [
 'campus','user','course','class_group','student','enrollment',
 'payment_record','campus_expense','lesson_record','registration_entry','registration',
 'registration_history','operation_log','system_config','quick_deduct','lesson_batch',
 'student_share','artwork'
]
COLS={
'campus':'id name code display_name logo_path qr_path remarks is_active created_at',
'user':'id username password_hash role campus_id is_active created_at',
'course':'id campus_id name category is_archived created_at',
'class_group':'id campus_id course_id name teacher_id weekday start_time end_time room capacity deduct_lessons allow_override override_extra is_archived created_at',
'student':'id campus_id name gender parent_name phone birthday grade remarks status source registration_id lessons_remaining created_at',
'enrollment':'id campus_id student_id class_group_id status joined_at left_at created_at',
'payment_record':'id campus_id student_id contract_id type amount_cents lessons_delta lessons_bonus operator_id remarks created_at',
'campus_expense':'id campus_id category amount_cents remarks operator_id created_at',
'lesson_record':'id campus_id class_group_id student_id contract_id teacher_id date duration_minutes status deducted_lessons revoked_at created_at',
'registration_entry':'id campus_id name token enabled deadline contact qr_path created_by created_at',
'registration':'id entry_id campus_id class_group_id student_name grade guardian_name guardian_phone phone_last4 status modify_code_hash modify_uses note created_at updated_at',
'registration_history':'id registration_id action from_class_group_id to_class_group_id note created_at',
'operation_log':'id user_id action_time target target_id action detail',
'system_config':'id site_name logo_path login_bg_path updated_at',
'quick_deduct':'id student_id class_group_id local_day lesson_record_id operator_id created_at',
'lesson_batch':'nonce class_group_id operator_id created_at',
'student_share':'id student_id token enabled public_name approved_at created_at',
'artwork':'id student_id campus_id uploader_id image_key title note is_public is_deleted created_at'}
COLS={k:v.split() for k,v in COLS.items()}
def literal(v):
 if v is None:return 'NULL'
 if isinstance(v,bool):return '1' if v else '0'
 if isinstance(v,(int,float)):return str(v)
 if isinstance(v,(bytes,bytearray)):return "X'"+bytes(v).hex()+"'"
 return "'"+str(v).replace("'","''").replace('\x00','')+"'"
def table_cols(db,table):return {r[1] for r in db.execute(f'PRAGMA table_info("{table}")')}
def main():
 parser=argparse.ArgumentParser(description='Read-only LessonDesk migration export');parser.add_argument('--db',required=True,help='legacy instance/app.db; SQLite consistent snapshot recommended');parser.add_argument('--photos',help='legacy instance/artworks (optional)');parser.add_argument('--output',required=True,help='new empty output directory');args=parser.parse_args()
 inp=pathlib.Path(args.db).resolve();out=pathlib.Path(args.output).resolve()
 if not inp.is_file():parser.error('旧数据库不存在')
 if out.exists() and any(out.iterdir()):parser.error('输出文件夹必须为空，防止覆盖先前导出的隐私数据')
 out.mkdir(parents=True,exist_ok=True);(out/'sql').mkdir();(out/'art_uploads').mkdir()
 db=sqlite3.connect('file:'+str(inp)+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
 existing={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
 if not {'student','user','class_group'}.issubset(existing):parser.error('源文件不是可识别的课时本 SQLite 数据库')
 result={'created_at':datetime.datetime.now().isoformat(),'source':inp.name,'counts':{},'balances':{},'warnings':[],'photos':[]}
 files=[]
 for t in TABLES:
  if t not in existing:result['counts'][t]=0;continue
  cols=[x for x in COLS[t] if x in table_cols(db,t)];rows=db.execute('SELECT '+','.join('"'+x+'"' for x in cols)+f' FROM "{t}" ORDER BY rowid').fetchall();result['counts'][t]=len(rows)
  if t=='student':result['balances']={str(r['id']):r['lessons_remaining'] for r in rows if 'lessons_remaining' in r.keys()}
  for idx in range(0,len(rows),200):
   file=out/'sql'/f'{len(files)+1:04d}_{t}.sql';lines=[f'-- {t} IDs preserved; never double-apply lesson deltas'];
   for r in rows[idx:idx+200]:
    d=dict(r)
    if t=='artwork':d.pop('likes_count',None)
    keys=list(d);lines.append('INSERT OR IGNORE INTO "'+t+'"('+','.join('"'+k+'"' for k in keys)+') VALUES('+','.join(literal(d[k]) for k in keys)+');')
   file.write_text('\n'.join(lines)+'\n',encoding='utf-8');files.append(file)
  if t=='artwork' and args.photos:
   pdir=pathlib.Path(args.photos).resolve()
   for r in rows:
    key=dict(r).get('image_key')
    if not key:continue
    rel=pathlib.Path(key)
    if rel.is_absolute() or '..' in rel.parts:result['warnings'].append('不安全的图片路径：'+str(key));continue
    candidate=pdir/rel
    if candidate.is_file():
     with candidate.open('rb') as fh:signature=fh.read(16)
     if signature[:4]==b'RIFF' and signature[8:12]==b'WEBP':result['photos'].append({'key':key,'local_path':str(candidate)})
     else:result['warnings'].append('不是 WebP 图片：'+str(key))
    else:result['warnings'].append('缺失作品图片：'+str(key))
 # Old V4 artwork_like records were time-bucket events; new model keeps 24h cooldown per hashed IP.
 if 'artwork_like' in existing:
  old_cols=table_cols(db,'artwork_like');totals=collections.Counter();latest={}
  if {'artwork_id','ip_hash','last_at'}.issubset(old_cols):
   iterable=((aid,key,int(ts or 0),int(count or 1)) for aid,key,ts,count in db.execute('SELECT artwork_id,ip_hash,last_at,count FROM artwork_like'))
  elif {'artwork_id','ip_hash','created_at'}.issubset(old_cols):
   def legacy_events():
    for aid,key,dt in db.execute('SELECT artwork_id,ip_hash,created_at FROM artwork_like'):
     try:ts=int(datetime.datetime.fromisoformat(str(dt).replace('Z','+00:00')).replace(tzinfo=datetime.timezone.utc).timestamp())
     except (ValueError,TypeError):ts=0
     yield aid,key,ts,1
   iterable=legacy_events()
  else:
   iterable=()
   result['warnings'].append('无法识别点赞表字段，未迁移点赞记录')
  for aid,key,ts,count in iterable:
   totals[aid]+=count
   latest[(aid,key)]=max(latest.get((aid,key),0),ts)
  lines=['-- imported historic likes: one row per hashed IP, preserving legacy like totals'];
  for (aid,key),ts in latest.items():lines.append(f'INSERT OR IGNORE INTO artwork_like(artwork_id,ip_hash,last_at,count) VALUES({literal(aid)},{literal(key)},{literal(ts)},{literal(1)});')
  for aid,n in totals.items():lines.append(f'UPDATE artwork SET likes_count={n} WHERE id={aid};')
  f=out/'sql'/f'{len(files)+1:04d}_artwork_like.sql';f.write_text('\n'.join(lines)+'\n');files.append(f)
 # Integrity findings: exact class/teacher references in source may be inconsistent from legacy拼接.
 try:
  bad=list(db.execute('PRAGMA foreign_key_check'))
  if bad:result['warnings'].append(f'原库存在 {len(bad)} 个外键引用问题（请人工处理后再迁移）')
 except sqlite3.DatabaseError:pass
 result['sql_files']=[p.name for p in files]
 (out/'migration_manifest.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
 lines=['#!/usr/bin/env bash','set -euo pipefail',
        'echo "Warning: source NAS must be read-only/frozen and target must be EMPTY"',
        'echo "Run this script FROM the LessonDesk-Cloudflare project root"',
        'python3 scripts/verify_remote.py --mode before --manifest='+shlex.quote(str(out/'migration_manifest.json')),
        'npx wrangler d1 execute DB --remote --command="UPDATE migration_control SET enabled=1 WHERE id=1;"',
        "trap 'npx wrangler d1 execute DB --remote --command=\"UPDATE migration_control SET enabled=0 WHERE id=1;\"' EXIT"]
 for f in files:lines.append('npx wrangler d1 execute DB --remote --file='+shlex.quote(str(f)))
 lines.append('npx wrangler d1 execute DB --remote --command="UPDATE migration_control SET enabled=0 WHERE id=1;"')
 lines.append('python3 scripts/verify_remote.py --mode after --manifest='+shlex.quote(str(out/'migration_manifest.json')))
 (out/'import_d1.sh').write_text('\n'.join(lines)+'\n');(out/'import_d1.sh').chmod(0o700)
 upload=['#!/usr/bin/env bash','set -euo pipefail']
 for pic in result['photos']:upload.append('npx wrangler r2 object put '+shlex.quote('lesson-desk-artworks/'+pic['key'])+' --remote --content-type image/webp --file='+shlex.quote(pic['local_path']))
 (out/'upload_r2.sh').write_text('\n'.join(upload)+'\n');(out/'upload_r2.sh').chmod(0o700)
 print('只读导出完成：',out);print('表计数：',result['counts']);print('作品数量：',len(result['photos']),'警告数量：',len(result['warnings']));print('重要：导出包含个人资料与密码哈希，仅限部署者本机使用，禁止上传 GitHub 或发到公共聊天。')
if __name__=='__main__':main()
