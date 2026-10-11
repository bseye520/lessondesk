#!/usr/bin/env python3
"""Convert an independently exported D1 SQL snapshot to a portable verified data-only archive.
The archive does NOT embed R2 photos; media-manifest.json records their expected object keys.
"""
import argparse, hashlib, io, json, pathlib, sqlite3, sys, zipfile
from datetime import datetime, timezone
TABLES = ['campus','user','course','class_group','student','enrollment','enrollment_event','lesson_record','payment_record','refund_record','campus_expense','operation_log','registration_entry','registration','registration_history','student_share','artwork','artwork_like','campus_brand','account_profile','lesson_batch','quick_deduct','system_config','session','login_attempt']

def summary(db):
    existing={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    counts={name:db.execute('SELECT COUNT(*) FROM "'+name+'"').fetchone()[0] for name in TABLES if name in existing}
    if not {'student','lesson_record','operation_log','user'}.issubset(existing):raise ValueError('Not a complete LessonDesk database backup')
    balances=[dict(zip(('id','lessons_remaining'),r)) for r in db.execute('SELECT id,lessons_remaining FROM student ORDER BY id')]
    invalid=list(db.execute('PRAGMA foreign_key_check'))
    if invalid:raise ValueError('Database contains broken foreign keys; repair original before archiving')
    keys=[]
    if 'artwork' in existing:keys.extend({'kind':'artwork','key':key} for (key,) in db.execute('SELECT image_key FROM artwork WHERE image_key IS NOT NULL ORDER BY id'))
    if 'campus_brand' in existing:
        for logo,qr in db.execute('SELECT logo_key,qr_key FROM campus_brand'):
            if logo:keys.append({'kind':'logo','key':logo})
            if qr:keys.append({'kind':'qr','key':qr})
    if 'account_profile' in existing:keys.extend({'kind':'avatar','key':key} for (key,) in db.execute('SELECT avatar_key FROM account_profile WHERE avatar_key IS NOT NULL'))
    contract=db.execute('SELECT major,minor FROM data_contract WHERE id=1').fetchone() if 'data_contract' in existing else None
    return counts,balances,keys,contract

def make(sql,out):
    text=pathlib.Path(sql).read_text(encoding='utf-8-sig')
    db=sqlite3.connect(':memory:');db.executescript(text)
    counts,balances,keys,contract=summary(db);db.close()
    if not contract or contract[0]!=7:raise ValueError('Archive requires LessonDesk V7 database contract; migration incomplete')
    files={'data.sql':text.encode(), 'balances.json':json.dumps(balances,ensure_ascii=False,separators=(',',':')).encode(), 'media-manifest.json':json.dumps(keys,ensure_ascii=False,indent=2).encode()}
    manifest={'format':'lessondesk-portable-backup','format_version':1,'schema_major':contract[0],'schema_minor':contract[1],'created_at':datetime.now(timezone.utc).isoformat(),'counts':counts,'photos_included':False,'files_sha256':{name:hashlib.sha256(content).hexdigest() for name,content in files.items()},'lesson_balance_sum':sum(r['lessons_remaining'] for r in balances)}
    files['manifest.json']=json.dumps(manifest,ensure_ascii=False,indent=2).encode()
    out=pathlib.Path(out);out.parent.mkdir(parents=True,exist_ok=True)
    if out.exists():raise FileExistsError('Backup filename already exists; refusing to overwrite')
    with zipfile.ZipFile(out,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=7) as z:
        for name,content in files.items():z.writestr(name,content)
    print('Backup created:',out,'Students:',counts.get('student'),'Balance:',manifest['lesson_balance_sum'],'Media keys:',len(keys))

def verify(path,extract=None):
    with zipfile.ZipFile(path) as z:
        if z.testzip():raise ValueError('Damaged ZIP')
        manifest=json.loads(z.read('manifest.json'))
        if manifest.get('format')!='lessondesk-portable-backup' or manifest.get('format_version')!=1:raise ValueError('Unsupported backup format')
        if manifest.get('schema_major')!=7:raise ValueError('Unmatched schema major version; use matching source version')
        for name,digest in manifest['files_sha256'].items():
            if hashlib.sha256(z.read(name)).hexdigest()!=digest:raise ValueError('File checksum mismatch: '+name)
        sql=z.read('data.sql').decode('utf-8');db=sqlite3.connect(':memory:');db.executescript(sql)
        counts,balances,keys,contract=summary(db);db.close()
        if counts!=manifest['counts'] or sum(r['lessons_remaining'] for r in balances)!=manifest['lesson_balance_sum']:raise ValueError('Restore rehearsal count/balance mismatch')
        if contract is None or contract[0]!=7:raise ValueError('Database contract mismatch')
        if len(keys)!=len(json.loads(z.read('media-manifest.json'))):raise ValueError('Media manifest count mismatch')
        if extract:
            dest=pathlib.Path(extract);dest.mkdir(parents=True,exist_ok=True)
            if (dest/'data.sql').exists():raise FileExistsError('Restore SQL already exists at destination')
            (dest/'data.sql').write_text(sql)
        print('VERIFIED',path,'Students',counts.get('student'),'Balance',manifest['lesson_balance_sum'],'Media references',len(keys))
        print('Note: R2 images are NOT part of this archive. Do not restore over existing live data.')

if __name__=='__main__':
    a=argparse.ArgumentParser(description='V7 D1 portable backup, integrity check and rehearsal')
    a.add_argument('--input',help='Wrangler D1 SQL export');a.add_argument('--output');a.add_argument('--verify');a.add_argument('--extract-sql')
    v=a.parse_args()
    try:
        if v.verify:verify(v.verify,v.extract_sql)
        elif v.input and v.output:make(v.input,v.output);verify(v.output)
        else:a.error('Use --input SQL --output ZIP or --verify ZIP [--extract-sql EMPTY_DIR]')
    except Exception as ex:print('ERROR:',ex,file=sys.stderr);sys.exit(2)
