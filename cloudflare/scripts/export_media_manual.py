#!/usr/bin/env python3
"""On-demand R2 image export. Run after saving a V7 D1 archive; never cron this script."""
import argparse, json, pathlib, subprocess, sys, zipfile
p=argparse.ArgumentParser();p.add_argument('--backup',required=True);p.add_argument('--out',required=True);p.add_argument('--bucket',default='lesson-desk-artworks');args=p.parse_args()
out=pathlib.Path(args.out).resolve();out.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(args.backup) as z:media=json.loads(z.read('media-manifest.json'))
ok=[];fail=[]
for obj in media:
 key=obj['key']; parts=pathlib.PurePosixPath(key)
 if parts.is_absolute() or '..' in parts.parts or not key.strip() or '\\' in key:
  fail.append({'key':key,'error':'invalid key'});continue
 dest=out/'files'/parts
 if not dest.resolve().is_relative_to(out):fail.append({'key':key,'error':'unsafe destination'});continue
 dest.parent.mkdir(parents=True,exist_ok=True)
 if dest.exists():fail.append({'key':key,'error':'already exists; not overwriting'});continue
 cmd=['npx','wrangler','r2','object','get',args.bucket+'/'+key,'--remote','--file',str(dest)]
 r=subprocess.run(cmd,capture_output=True,text=True)
 if r.returncode:fail.append({'key':key,'error':r.stderr[-300:]});dest.unlink(missing_ok=True)
 else:ok.append(key)
(out/'media-export-result.json').write_text(json.dumps({'success':ok,'failed':fail},ensure_ascii=False,indent=2))
print('Images downloaded:',len(ok),'Failed:',len(fail),'Report:',out/'media-export-result.json')
if fail:sys.exit(2)
