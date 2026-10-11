#!/usr/bin/env python3
import sqlite3,sys,json
req=json.load(sys.stdin);db=sqlite3.connect(req['path']);db.row_factory=sqlite3.Row;db.execute('PRAGMA foreign_keys=ON')
def perform(item):
 sql=item['sql'];params=item.get('args',[]);prev=db.total_changes;cur=db.execute(sql,params)
 try:rows=[dict(x) for x in cur.fetchall()]
 except sqlite3.ProgrammingError:rows=[]
 return {'results':rows,'meta':{'changes':cur.rowcount if cur.rowcount>=0 else db.total_changes-prev,'last_row_id':cur.lastrowid}}
try:
 if req.get('schema'):
  db.executescript(open(req['schema']).read());db.commit();data={'ok':True}
 elif req.get('batch'):
  db.execute('BEGIN IMMEDIATE')
  results=[perform(item) for item in req['batch']];db.commit();data={'ok':True,'results':results}
 else:
  item=req['item'];res=perform(item);db.commit();data={'ok':True,'result':res}
except Exception as e:
 db.rollback();data={'ok':False,'error':str(e)}
finally:db.close()
print(json.dumps(data))
