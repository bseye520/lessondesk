#!/usr/bin/env python3
"""对 Cloudflare D1 的实际数据进行只读迁移前/后检查，严格阻止静默少导学员和余额。"""
import argparse, json, pathlib, subprocess, sys
SAFE_TABLES = ['campus','user','course','class_group','student','enrollment','payment_record','campus_expense','lesson_record','registration_entry','registration','registration_history','operation_log','system_config','quick_deduct','lesson_batch','student_share','artwork']

def query(sql):
    result=subprocess.run(['npx','wrangler','d1','execute','DB','--remote','--json','--command',sql],capture_output=True,text=True,timeout=90)
    if result.returncode:raise RuntimeError('Wrangler D1 查询失败：'+result.stderr[-1000:])
    try:payload=json.loads(result.stdout)
    except json.JSONDecodeError as e:raise RuntimeError('Wrangler 未返回纯 JSON，请先升级 Wrangler：'+result.stdout[-400:]) from e
    if isinstance(payload,dict):payload=[payload]
    if not payload or not payload[0].get('success',True):raise RuntimeError('D1 查询失败：'+str(payload)[:300])
    return payload[0].get('results',[])

def main():
    p=argparse.ArgumentParser();p.add_argument('--manifest',required=True);p.add_argument('--mode',choices=['before','after'],required=True);arg=p.parse_args()
    manifest=json.loads(pathlib.Path(arg.manifest).read_text(encoding='utf8'))
    expectations=manifest['counts']
    count_sql='SELECT '+','.join('(SELECT COUNT(*) FROM "'+t+'") AS "'+t+'"' for t in SAFE_TABLES)
    actual=query(count_sql)[0]
    problems=[]
    for table in SAFE_TABLES:
        want=0 if arg.mode=='before' else int(expectations.get(table,0))
        got=int(actual[table])
        if got!=want:problems.append(f'{table}: 期望 {want}, D1 实际 {got}')
    if arg.mode=='after':
        actual_balances={str(r['id']):int(r['lessons_remaining']) for r in query('SELECT id,lessons_remaining FROM student ORDER BY id')}
        expected_balances={str(k):int(v) for k,v in manifest['balances'].items()}
        for sid,rem in expected_balances.items():
            if actual_balances.get(sid)!=rem:problems.append('学员 ID '+sid+' 的课时余额不一致')
        for sid in actual_balances.keys()-expected_balances.keys():problems.append('D1 多出学员 ID '+sid)
    if problems:
        print('❌ 核对失败。禁止切换生产域名。',file=sys.stderr)
        for item in problems[:35]:print('  -',item,file=sys.stderr)
        sys.exit(2)
    print('✅ D1 '+('迁移前空库' if arg.mode=='before' else '迁移后表数和逐学员余额')+'核对通过。')

if __name__=='__main__':main()
