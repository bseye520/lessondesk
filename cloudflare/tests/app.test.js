import {scryptSync} from 'node:crypto';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';
import app from '../src/index.js';import {hashPassword,verifyPassword} from '../src/lib.js';import {cleanWebp,cleanJpeg,safeImageInfo,stripJpegMetadata} from '../src/workflows.js';
const schema=fs.readFileSync(new URL('../migrations/0001_schema.sql',import.meta.url),'utf8')+'\n'+fs.readFileSync(new URL('../migrations/0002_branding.sql',import.meta.url),'utf8')+'\n'+fs.readFileSync(new URL('../migrations/0003_v7.sql',import.meta.url),'utf8');
class TestDB{constructor(){this.db=new DatabaseSync(':memory:');this.db.exec('PRAGMA foreign_keys=ON');this.db.exec(schema);}prepare(sql){const db=this.db;return{bind(...args){return{sql,args,async all(){return {results:db.prepare(sql).all(...args)}},async first(){return db.prepare(sql).get(...args)||null},async run(){const v=db.prepare(sql).run(...args);return{meta:{changes:Number(v.changes),last_row_id:Number(v.lastInsertRowid)}}}}}}}async batch(cmds){this.db.exec('BEGIN IMMEDIATE');try{let rs=[];for(const s of cmds){const st=this.db.prepare(s.sql);if(/^\s*SELECT/i.test(s.sql))rs.push({results:st.all(...s.args)});else{let v=st.run(...s.args);rs.push({meta:{changes:Number(v.changes),last_row_id:Number(v.lastInsertRowid)}})}}this.db.exec('COMMIT');return rs;}catch(e){this.db.exec('ROLLBACK');throw e;}}}
function env(){const db=new TestDB(),bucket=new Map();return{DB:db,ARTWORKS:{async put(k,v){bucket.set(k,v)},async get(k){return bucket.has(k)?{body:bucket.get(k)}:null},async delete(k){bucket.delete(k)}},IP_HASH_SECRET:'test-secret-unique-987654321',SETUP_KEY:'test-key',TZ:'Asia/Shanghai',SITE_NAME:'课时本'};}
async function send(e,p,method='GET',data=null,cookie='',accept='text/html'){
 const url='http://localhost:8787'+p;let headers={'Accept':accept,'CF-Connecting-IP':'1.2.3.4'},body;
 if(cookie)headers.Cookie=cookie;if(data instanceof FormData)body=data;
 else if(data){headers['Content-Type']='application/x-www-form-urlencoded';body=new URLSearchParams(data)}
 return app.fetch(new Request(url,{method,headers,body,redirect:'manual'}),e);
}
async function loggedIn(e){let r=await send(e,'/setup','POST',{setup_key:'test-key',campus_name:'画室',username:'admin',password:'a-very-long-test-password'});assert.equal(r.status,303);r=await send(e,'/login','POST',{username:'admin',password:'a-very-long-test-password'});assert.equal(r.status,303);let ck=r.headers.get('Set-Cookie').split(';')[0];const session=e.DB.db.prepare('SELECT csrf_token FROM session ORDER BY created_at DESC LIMIT 1').get();return {cookie:ck,csrf:session.csrf_token};}
function auth(data,s){return {...data,csrf_token:s.csrf};}
async function submit(e,s,p,data){let r=await send(e,p,'POST',auth(data,s),s.cookie,'application/json');return {r,v:await r.json()};}
function row(e,sql,args=[]){return e.DB.db.prepare(sql).get(...args)}
test('password hashing and legacy hash verification',async()=>{const pw='this is a reasonable password';const h=await hashPassword(pw);assert.equal(await verifyPassword(pw,h),true);assert.equal(await verifyPassword('no',h),false);});
test('complete server-side workflow, scoped parents and idempotence',async()=>{const e=env();const s=await loggedIn(e);
 let x=await submit(e,s,'/api/courses',{campus_id:'1',name:'素描基础',category:'绘画'});assert.equal(x.r.status,200,x.v.error);assert.equal(x.v.ok,true);
 const course=row(e,'SELECT id FROM course LIMIT 1').id;
 x=await submit(e,s,'/api/classes',{campus_id:'1',course_id:course,name:'周六班',weekday:'周六',start_time:'09:00',end_time:'11:00',capacity:'10',deduct_lessons:'1'});assert.equal(x.r.status,200,x.v.error);
 x=await submit(e,s,'/api/students',{campus_id:'1',name:'小明',phone:'13800000000',grade:'三年级',class_group_id:'1'});assert.equal(x.r.status,200,x.v.error);const sid=row(e,'SELECT id FROM student LIMIT 1').id;
 x=await submit(e,s,`/api/students/${sid}/payment`,{type:'charge',lessons:'10',bonus:'2',amount:'250.50',nonce:'payment-nonce-1234567890000000'});assert.equal(x.r.status,200,x.v.error);assert.equal(row(e,'SELECT lessons_remaining FROM student WHERE id=?',[sid]).lessons_remaining,12);
 x=await submit(e,s,`/api/quick/1/${sid}`,{});assert.equal(x.r.status,200,x.v.error);assert.equal(x.v.remaining,11);const rec=row(e,'SELECT id FROM lesson_record LIMIT 1').id;
 x=await submit(e,s,`/api/quick/1/${sid}`,{});assert.equal(x.r.status,400);assert.equal(row(e,'SELECT lessons_remaining FROM student WHERE id=?',[sid]).lessons_remaining,11);
 x=await submit(e,s,`/api/undo/${rec}`,{reason:'误点消课'});assert.equal(x.r.status,200,x.v.error);assert.equal(x.v.remaining,12);
 x=await submit(e,s,`/api/undo/${rec}`,{reason:'误点消课'});assert.equal(x.r.status,400);assert.equal(row(e,'SELECT lessons_remaining FROM student WHERE id=?',[sid]).lessons_remaining,12);
 x=await submit(e,s,`/api/students/${sid}/manual`,{class_group_id:'1',count:'3',reason:'补记三节',nonce:'1234567890abcdefghijklmnop'});assert.equal(x.r.status,200,x.v.error);assert.equal(row(e,'SELECT lessons_remaining FROM student WHERE id=?',[sid]).lessons_remaining,9);
 x=await submit(e,s,`/api/students/${sid}/manual`,{class_group_id:'1',count:'3',reason:'补记三节',nonce:'1234567890abcdefghijklmnop'});assert.equal(x.r.status,400);assert.equal(row(e,'SELECT lessons_remaining FROM student WHERE id=?',[sid]).lessons_remaining,9);
 let res=await send(e,'/');assert.equal(res.status,401);res=await send(e,'/', 'GET',null,s.cookie);assert.equal(res.status,200);assert.match(await res.text(),/周六班/);
 // Share disabled until consent confirmation
 x=await submit(e,s,`/api/students/${sid}/share`,{enabled:'1',public_name:'小明'});assert.equal(x.r.status,400);
 x=await submit(e,s,`/api/students/${sid}/share`,{enabled:'1',consent:'1',public_name:'小明'});assert.equal(x.r.status,200,x.v.error);
 const token=row(e,'SELECT token FROM student_share').token;
 res=await send(e,`/p/${token}`);assert.equal(res.status,200);let html=await res.text();assert.match(html,/剩余课时/);assert.doesNotMatch(html,/13800000000/);
 const webp=Buffer.from('RIFFxxxxWEBPVP8 \x08\x00\x00\x00abcdefgh','binary');const webpValid=Buffer.concat([webp,Buffer.alloc(120)]);webpValid.writeUInt32LE(webpValid.length-8,4);webpValid.writeUInt32LE(webpValid.length-20,16);assert.equal(cleanWebp(webpValid),true);
 res=await send(e,`/students/${sid}/upload`,'GET',null,s.cookie);assert.equal(res.status,200);
 const artFormHtml=await res.text();
 assert.match(artFormHtml,/id="art-camera"[^>]*capture="environment"/);
 assert.match(artFormHtml,/id="art-file"[^>]*name="photo"[^>]*accept="image\/\*"/);
 const form=new FormData();form.set('csrf_token',s.csrf);form.set('title','静物');form.set('upload_nonce','upload-nonce-abcdefghijklmnop');form.set('photo',new Blob([webpValid],{type:'image/webp'}),'work.webp');
 res=await send(e,`/api/students/${sid}/upload`,'POST',form,s.cookie,'application/json');const upload=await res.json();assert.equal(upload.ok,true,upload.error);
 assert.ok(upload.upload_metrics&&upload.upload_metrics.bytes===webpValid.length);
 assert.ok(upload.upload_metrics.r2_ms>=0&&upload.upload_metrics.d1_ms>=0);
 let check=await send(e,`/api/students/${sid}/upload-state/upload-nonce-abcdefghijklmnop`,'GET',null,s.cookie,'application/json');
 assert.equal(check.status,200);assert.equal((await check.json()).completed,true);
 check=await send(e,`/api/students/${sid}/upload-state/unused-nonce-abcdefghijklmnop`,'GET',null,s.cookie,'application/json');
 assert.equal((await check.json()).completed,false);
 check=await send(e,`/api/students/${sid}/upload-state/upload-nonce-abcdefghijklmnop`,'GET',null,'','application/json');
 assert.equal(check.status,401,'unauthenticated users cannot probe upload state');
 const art=row(e,'SELECT id FROM artwork LIMIT 1').id;
 res=await send(e,`/p/${token}/img/${art}`);assert.equal(res.status,200);
 x=await submit(e,s,`/api/artworks/${art}`,{op:'publish',is_public:'1'});assert.equal(x.r.status,200,x.v.error);
 res=await send(e,`/p/${token}/img/${art}`);assert.equal(res.status,200);assert.equal(res.headers.get('Content-Type'),'image/webp');
 res=await send(e,`/p/${token}/like/${art}`,'POST',{},'','application/json');assert.equal((await res.json()).likes,1);
 res=await send(e,`/p/${token}/like/${art}`,'POST',{},'','application/json');assert.equal(res.status,429);
 assert.equal(row(e,'SELECT likes_count FROM artwork WHERE id=?',[art]).likes_count,1);
 x=await submit(e,s,`/api/students/${sid}/share`,{enabled:'0',public_name:'小明'});assert.equal(x.r.status,200);
 res=await send(e,`/p/${token}`);assert.equal(res.status,404);
 res=await send(e,`/p/${token}/img/${art}`);assert.equal(res.status,404);
});
test('public registration: pending -> change class with code -> confirm once',async()=>{
 const env1=env(),sess=await loggedIn(env1);
 for (const name of ['素描','水粉']){let t=await submit(env1,sess,'/api/courses',{campus_id:'1',name});assert.equal(t.v.ok,true,t.v.error)}
 for (let k=1;k<=2;k++){let t=await submit(env1,sess,'/api/classes',{campus_id:'1',course_id:String(k),name:`班${k}`,weekday:'周六',start_time:'10:00',end_time:'11:00',capacity:'1',deduct_lessons:'1'});assert.equal(t.v.ok,true,t.v.error)}
 let t=await submit(env1,sess,'/api/entries',{campus_id:'1',name:'秋季公开报名'});assert.equal(t.v.ok,true,t.v.error);
 const token=row(env1,'SELECT token FROM registration_entry').token;
 let r=await send(env1,`/r/${token}`);assert.equal(r.status,200);
 r=await send(env1,`/r/${token}`,'POST',{class_group_id:'1',student_name:'小林',grade:'三年级',guardian_name:'父亲',guardian_phone:'13812345678'});
 assert.equal(r.status,200);const html=await r.text();const match=html.match(/letter-spacing:5px">(\d{6})<\/h2>/);assert.ok(match,'应返回一次性修改码');const code=match[1];
 assert.equal(row(env1,"SELECT status FROM registration").status,'pending');
 r=await send(env1,`/r/${token}/modify`);assert.equal(r.status,200);
 r=await send(env1,`/r/${token}/modify`,'POST',{action:'change',student_name:'小林',phone_last4:'5678',code:'000000',class_group_id:'2'});
 assert.equal(r.status,400,'错误修改码必须拒绝');
 r=await send(env1,`/r/${token}/modify`,'POST',{action:'change',student_name:'小林',phone_last4:'5678',code,class_group_id:'2'});
 assert.equal(r.status,303,'修改成功跳转');assert.equal(row(env1,'SELECT class_group_id FROM registration').class_group_id,2);
 t=await submit(env1,sess,'/api/registrations/1',{status:'confirmed'});assert.equal(t.r.status,200,t.v.error);
 assert.equal(row(env1,'SELECT status FROM registration').status,'confirmed');
 assert.equal(row(env1,'SELECT class_group_id FROM enrollment').class_group_id,2);
 assert.equal(row(env1,'SELECT lessons_remaining FROM student').lessons_remaining,0);
 t=await submit(env1,sess,'/api/registrations/1',{status:'confirmed'});assert.equal(t.r.status,400);
 // The class is full after one approved registration
 r=await send(env1,`/r/${token}`,'POST',{class_group_id:'2',student_name:'小赵',guardian_phone:'13800005678'});assert.equal(r.status,400);
});

test('role isolation, capacity and payment replay protection',async()=>{
 const env1=env(),admin=await loggedIn(env1);
 let t=await submit(env1,admin,'/api/courses',{campus_id:'1',name:'基础画室'});assert.equal(t.r.status,200);
 t=await submit(env1,admin,'/api/users',{campus_id:'1',username:'teacher1',role:'teacher',password:'teacher-long-passphrase'});assert.equal(t.r.status,200,t.v.error);
 t=await submit(env1,admin,'/api/classes',{campus_id:'1',course_id:'1',name:'周日美术',weekday:'周日',start_time:'10:00',end_time:'11:00',capacity:'1',deduct_lessons:'1',teacher_id:'2'});assert.equal(t.r.status,200,t.v.error);
 t=await submit(env1,admin,'/api/students',{campus_id:'1',name:'小甲',class_group_id:'1',phone:'13899999999'});assert.equal(t.r.status,200,t.v.error);
 t=await submit(env1,admin,'/api/students',{campus_id:'1',name:'小乙',class_group_id:'1',phone:'13899999999'});assert.equal(t.r.status,400,'班额不能超限');assert.equal(row(env1,'SELECT COUNT(*) n FROM student').n,1,'创建失败不能留下幽灵学员');
 const nonce='money-idempotent-nonce-000000001';
 t=await submit(env1,admin,'/api/students/1/payment',{type:'charge',lessons:'2',amount:'20',nonce});assert.equal(t.r.status,200,t.v.error);
 t=await submit(env1,admin,'/api/students/1/payment',{type:'charge',lessons:'2',amount:'20',nonce});assert.equal(t.r.status,400);
 assert.equal(row(env1,'SELECT lessons_remaining FROM student WHERE id=1').lessons_remaining,2);
 const r=await send(env1,'/login','POST',{username:'teacher1',password:'teacher-long-passphrase'});assert.equal(r.status,303);const cookie=r.headers.get('Set-Cookie').split(';')[0];
 const teacherId=row(env1,"SELECT id FROM user WHERE username='teacher1'").id;
 const csrfToken=row(env1,'SELECT csrf_token FROM session WHERE user_id=?',[teacherId]).csrf_token;
 let response=await send(env1,'/students/1','GET',null,cookie);assert.equal(response.status,200);
 response=await send(env1,'/finance','GET',null,cookie);assert.equal(response.status,403);
 response=await send(env1,'/api/students/1/payment','POST',{csrf_token:csrfToken,type:'charge',lessons:'50',nonce:'new-idempotent-nonce-0000001'},cookie,'application/json');assert.equal(response.status,403);
 response=await send(env1,'/api/users','POST',{csrf_token:csrfToken,username:'hacker',role:'teacher',password:'a-password-should-not-be-here',campus_id:'1'},cookie,'application/json');assert.equal(response.status,403);
 assert.equal(row(env1,'SELECT lessons_remaining FROM student WHERE id=1').lessons_remaining,2);
});

test('editing classes/courses without changing UI, archive and restore, deadline enforced',async()=>{
 const e=env(),s=await loggedIn(e);
 let v=await submit(e,s,'/api/courses',{campus_id:'1',name:'素描'});assert.equal(v.r.status,200);
 v=await submit(e,s,'/api/classes',{campus_id:'1',course_id:'1',name:'旧班名',weekday:'周一',start_time:'09:00',end_time:'11:00',capacity:'5',deduct_lessons:'1'});assert.equal(v.r.status,200);
 v=await submit(e,s,'/api/courses/1',{name:'创意素描',category:'美术',is_archived:'0'});assert.equal(v.r.status,200,v.v.error);
 assert.equal(row(e,'SELECT name FROM course WHERE id=1').name,'创意素描');
 v=await submit(e,s,'/api/classes/1',{name:'新班名',course_id:'1',weekday:'周二',start_time:'10:30',end_time:'12:00',capacity:'6',deduct_lessons:'2',room:'A2',is_archived:'1'});assert.equal(v.r.status,200,v.v.error);
 let g=row(e,'SELECT * FROM class_group WHERE id=1');assert.equal(g.name,'新班名');assert.equal(g.is_archived,1);assert.equal(g.deduct_lessons,2);
 let r=await send(e,'/classes','GET',null,s.cookie);assert.equal(r.status,200);assert.match(await r.text(),/新班名/);
 v=await submit(e,s,'/api/classes/1',{name:'新班名',course_id:'1',weekday:'周二',start_time:'10:30',end_time:'12:00',capacity:'6',deduct_lessons:'2',room:'A2',is_archived:'0'});assert.equal(v.r.status,200,v.v.error);
 assert.equal(row(e,'SELECT is_archived FROM class_group WHERE id=1').is_archived,0);
 v=await submit(e,s,'/api/entries',{campus_id:'1',name:'截止测试'});assert.equal(v.r.status,200,v.v.error);
 e.DB.db.prepare("UPDATE registration_entry SET deadline='2000-01-01 00:00:00'").run();const token=row(e,'SELECT token FROM registration_entry').token;
 r=await send(e,`/r/${token}`,'POST',{class_group_id:'1',student_name:'乙',guardian_phone:'13000000000'});assert.equal(r.status,403,'过期后端必须拒绝提交');
});


test('legacy Werkzeug scrypt account can sign in after import',async()=>{
 const e=env(),s=await loggedIn(e);
 const pw='old-flask-password-example';const salt='legacy-salt-abc';const hex=scryptSync(pw,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024}).toString('hex');
 const stored='scrypt:32768:8:1$'+salt+'$'+hex;
 assert.equal(await verifyPassword(pw,stored),true);
 assert.equal(await verifyPassword('incorrect',stored),false);
 e.DB.db.prepare('UPDATE user SET password_hash=? WHERE id=1').run(stored);
 const r=await send(e,'/login','POST',{username:'admin',password:pw});assert.equal(r.status,303);
});

test('public like is repeatable after 24h, but never before',async()=>{
 const e=env(),s=await loggedIn(e);
 await submit(e,s,'/api/students',{campus_id:'1',name:'画作归档测试'});
 await submit(e,s,'/api/students/1/share',{enabled:'1',consent:'1',public_name:'画作归档测试'});
 const token=row(e,'SELECT token FROM student_share').token;
 e.DB.db.prepare("INSERT INTO artwork(student_id,campus_id,uploader_id,image_key,title,is_public) VALUES(1,1,1,'test.webp','绘画',1)").run();
 let response=await send(e,`/p/${token}/like/1`,'POST',{},'','application/json');assert.equal(response.status,200);
 response=await send(e,`/p/${token}/like/1`,'POST',{},'','application/json');assert.equal(response.status,429);
 e.DB.db.prepare('UPDATE artwork_like SET last_at=last_at-86500').run();
 response=await send(e,`/p/${token}/like/1`,'POST',{},'','application/json');assert.equal(response.status,200);
 assert.equal(row(e,'SELECT likes_count FROM artwork').likes_count,2);
});

test('real mobile quick POST has no body: deduct, refresh, prevent duplicate, undo, like',async()=>{
 const e=env(),s=await loggedIn(e);
 let x=await submit(e,s,'/api/courses',{campus_id:'1',name:'素描'});assert.equal(x.r.status,200);
 x=await submit(e,s,'/api/classes',{campus_id:'1',course_id:'1',name:'周六素描班',weekday:'周六',start_time:'09:00',end_time:'11:00',capacity:'20',deduct_lessons:'1'});assert.equal(x.r.status,200);
 x=await submit(e,s,'/api/students',{campus_id:'1',name:'小明',class_group_id:'1'});assert.equal(x.r.status,200);
 x=await submit(e,s,'/api/students/1/payment',{type:'charge',lessons:'12',bonus:'0',amount:'100',nonce:'mobile-no-body-charge-1234567'});assert.equal(x.r.status,200);
 const noBody=(p,csrf=s.csrf,cookie=s.cookie)=>app.fetch(new Request('http://localhost:8787'+p,{method:'POST',headers:{Accept:'application/json','X-CSRF-Token':csrf,Cookie:cookie,'CF-Connecting-IP':'1.2.3.4'},redirect:'manual'}),e);
 let r=await noBody('/api/quick/1/1');let result=await r.json();assert.equal(r.status,200,result.error);assert.equal(result.remaining,11);
 let dash=await send(e,'/','GET',null,s.cookie);assert.equal(dash.status,200);const page=await dash.text();assert.match(page,/✓ 已消/);assert.match(page,/余 11 节/);
 // The quick button is directly in the student row, NOT behind an expanded details panel.
 assert.match(page,/<div class="roster-student-line">[\s\S]*?<form[^>]*class="js-quick roster-inline-quick"/);
 r=await noBody('/api/quick/1/1');assert.equal(r.status,400);assert.equal(row(e,'SELECT lessons_remaining FROM student').lessons_remaining,11);
 r=await send(e,result.undo,'POST',auth({reason:'撤销一次测试'},s),s.cookie,'application/json');assert.equal(r.status,200,(await r.clone().json()).error);assert.equal((await r.json()).remaining,12);
 r=await noBody(result.undo);assert.equal(r.status,400);assert.equal(row(e,'SELECT lessons_remaining FROM student').lessons_remaining,12);
 dash=await send(e,'/','GET',null,s.cookie);assert.doesNotMatch(await dash.text(),/✓ 已消/);
 await submit(e,s,'/api/students/1/share',{enabled:'1',consent:'1',public_name:'小明'});
 const token=row(e,'SELECT token FROM student_share').token;
 e.DB.db.prepare("INSERT INTO artwork(student_id,campus_id,uploader_id,image_key,title,is_public) VALUES(1,1,1,'mobile-test.webp','素描',1)").run();
 r=await noBody(`/p/${token}/like/1`,'','');assert.equal(r.status,200,(await r.clone().json()).error);assert.equal((await r.json()).likes,1);
 r=await noBody(`/p/${token}/like/1`,'','');assert.equal(r.status,429);
});

test('production incident: anonymous home shows a usable login, never a homepage loop',async()=>{
 const e=env();const response=await send(e,'/');assert.equal(response.status,401);
 const doc=await response.text();assert.match(doc,/action="\/login"/);assert.match(doc,/name="password"/);assert.doesNotMatch(doc,/返回首页/);
 const health=await send(e,'/health');assert.equal(health.status,200);
});

test('assigning teachers to classes saves and enforces campus and teacher roles',async()=>{
 const e=env(),a=await loggedIn(e);
 let z=await submit(e,a,'/api/users',{campus_id:'1',username:'artteacher',password:'a-secure-teacher-password',role:'teacher'});assert.equal(z.r.status,200,z.v.error);
 z=await submit(e,a,'/api/courses',{campus_id:'1',name:'演示课程'});assert.equal(z.r.status,200,z.v.error);
 z=await submit(e,a,'/api/classes',{campus_id:'1',course_id:'1',name:'周三素描',weekday:'周三',start_time:'09:00',end_time:'11:00',capacity:'20',deduct_lessons:'1'});assert.equal(z.r.status,200,z.v.error);
 const teacher=row(e,'SELECT id FROM user WHERE username=?',['artteacher']).id;
 z=await submit(e,a,'/api/classes/1',{name:'周三素描',course_id:'1',teacher_id:String(teacher),weekday:'周三',start_time:'09:00',end_time:'11:00',capacity:'20',deduct_lessons:'1',room:'一教室',is_archived:'0'});
 assert.equal(z.r.status,200,z.v.error);assert.equal(row(e,'SELECT teacher_id FROM class_group WHERE id=1').teacher_id,teacher);
 let res=await send(e,'/classes','GET',null,a.cookie);assert.equal(res.status,200);assert.match(await res.text(),/artteacher/);
 z=await submit(e,a,'/api/classes/1',{name:'周三素描',course_id:'1',teacher_id:'1',weekday:'周三',start_time:'09:00',end_time:'11:00',capacity:'20',deduct_lessons:'1',is_archived:'0'});
 assert.equal(z.r.status,400);assert.match(z.v.error,/教师/);assert.equal(row(e,'SELECT teacher_id FROM class_group WHERE id=1').teacher_id,teacher);
});

test('R2 avatar and campus branding, public share footer and permission isolation',async()=>{
 const e=env(),a=await loggedIn(e);
 let t=await submit(e,a,'/api/users',{username:'teachertest',password:'long-teacher-password-abc',role:'teacher',campus_id:'1'});assert.equal(t.r.status,200,t.v.error);
 const loginResp=await send(e,'/login','POST',{username:'teachertest',password:'long-teacher-password-abc'});assert.equal(loginResp.status,303);
 const c=loginResp.headers.get('Set-Cookie').split(';')[0],csrfToken=row(e,'SELECT csrf_token FROM session WHERE user_id=2').csrf_token;
 const webp=Buffer.from('RIFFxxxxWEBPVP8 \x08\x00\x00\x00abcdefgh','binary');const data=Buffer.concat([webp,Buffer.alloc(120)]);data.writeUInt32LE(data.length-8,4);data.writeUInt32LE(data.length-20,16);
 const upload=async(route,cookie,csrf,extra={})=>{const f=new FormData();f.set('csrf_token',csrf);for(const [k,v] of Object.entries(extra))f.set(k,v);f.set('photo',new Blob([data],{type:'image/webp'}),'pic.webp');let response=await send(e,route,'POST',f,cookie,'application/json');return{response,result:await response.json()};};
 let x=await upload('/api/profile/avatar',c,csrfToken);assert.equal(x.response.status,200,x.result.error);
 let res=await send(e,'/avatar/2','GET',null,c);assert.equal(res.status,200);
 x=await upload('/api/branding/logo',c,csrfToken,{campus_id:'1'});assert.equal(x.response.status,403);
 let t2=await submit(e,a,'/api/branding',{campus_id:'1',studio_name:'演示艺术馆',slogan:'画出你的想象',address:'虚构路 88 号',contact:'请联系画室'});assert.equal(t2.r.status,200,t2.v.error);
 x=await upload('/api/branding/logo',a.cookie,a.csrf,{campus_id:'1'});assert.equal(x.response.status,200,x.result.error);
 x=await upload('/api/branding/qr',a.cookie,a.csrf,{campus_id:'1'});assert.equal(x.response.status,200,x.result.error);
 res=await send(e,'/branding/logo/1');assert.equal(res.status,200);assert.equal(res.headers.get('Content-Type'),'image/webp');
 res=await send(e,'/branding/qr/1');assert.equal(res.status,200);
 res=await send(e,'/branding','GET',null,a.cookie);assert.equal(res.status,200);assert.match(await res.text(),/演示艺术馆/);
 let z=await submit(e,a,'/api/students',{campus_id:'1',name:'作品展示学生'});assert.equal(z.r.status,200,z.v.error);
 z=await submit(e,a,'/api/students/1/share',{enabled:'1',consent:'1',public_name:'展示学生'});assert.equal(z.r.status,200,z.v.error);
 const token=row(e,'SELECT token FROM student_share WHERE student_id=1').token;
 res=await send(e,`/p/${token}`);assert.equal(res.status,200);const doc=await res.text();
 assert.match(doc,/画出你的想象/);assert.match(doc,/虚构路 88 号/);assert.match(doc,/branding\/qr\/1/);
 assert.doesNotMatch(doc,/13800000000/);
});

test('quick state reconciles response loss without another deduction',async()=>{
 const e=env(),a=await loggedIn(e);
 let z=await submit(e,a,'/api/courses',{campus_id:'1',name:'素描'});assert.equal(z.r.status,200);
 z=await submit(e,a,'/api/classes',{campus_id:'1',course_id:'1',name:'班级',weekday:'周六',start_time:'09:00',end_time:'11:00'});assert.equal(z.r.status,200);
 z=await submit(e,a,'/api/students',{campus_id:'1',name:'测试小朋友',class_group_id:'1'});assert.equal(z.r.status,200);
 z=await submit(e,a,'/api/students/1/payment',{type:'charge',lessons:'3',bonus:'0',amount:'0',nonce:'state-unique-nonce-1234567890'});assert.equal(z.r.status,200,z.v.error);
 let res=await send(e,'/api/quick/state/1/1','GET',null,a.cookie,'application/json');let state=await res.json();assert.equal(state.done,false);assert.equal(state.remaining,3);
 z=await submit(e,a,'/api/quick/1/1',{});assert.equal(z.r.status,200,z.v.error);
 res=await send(e,'/api/quick/state/1/1','GET',null,a.cookie,'application/json');state=await res.json();assert.equal(state.done,true);assert.equal(state.remaining,2);
});

test('additive migration remains idempotent without touching real lesson balances',async()=>{
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(fs.readFileSync(new URL('../migrations/0001_schema.sql',import.meta.url),'utf8'));
 sqlite.exec("INSERT INTO campus(id,name,code) VALUES(1,'现有校区','MAIN');INSERT INTO student(id,campus_id,name,lessons_remaining) VALUES(42,1,'真实课时测试',17)");
 const upgrade=fs.readFileSync(new URL('../migrations/0002_branding.sql',import.meta.url),'utf8');sqlite.exec(upgrade);sqlite.exec(upgrade);sqlite.exec(fs.readFileSync(new URL('../migrations/0003_v7.sql',import.meta.url),'utf8'));
 assert.equal(sqlite.prepare('SELECT lessons_remaining FROM student WHERE id=42').get().lessons_remaining,17);
 assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='campus_brand'").get().n,1);
 assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='account_profile'").get().n,1);
 sqlite.close();
});

test('manager can edit own school branding; teacher cannot change roles or access other campus',async()=>{
 const e=env(),admin=await loggedIn(e);
 let z=await submit(e,admin,'/api/campuses',{name:'第二校区',code:'SECOND'});assert.equal(z.r.status,200,z.v.error);
 z=await submit(e,admin,'/api/users',{username:'schoolmanager',password:'manager-password-112233',campus_id:'2',role:'manager'});assert.equal(z.r.status,200,z.v.error);
 const loginResp=await send(e,'/login','POST',{username:'schoolmanager',password:'manager-password-112233'});assert.equal(loginResp.status,303);
 const cookie=loginResp.headers.get('Set-Cookie').split(';')[0],managerId=row(e,"SELECT id FROM user WHERE username='schoolmanager'").id;
 const managerCsrf=row(e,'SELECT csrf_token FROM session WHERE user_id=?',[managerId]).csrf_token;
 z=await submit(e,{cookie,csrf:managerCsrf},'/api/branding',{campus_id:'1',studio_name:'不能改别的校区'});assert.equal(z.r.status,200,z.v.error);
 // Manager's campus ID is authoritative: forged campus_id is ignored.
 assert.equal(row(e,'SELECT COUNT(*) AS n FROM campus_brand WHERE campus_id=1').n,0);
 assert.equal(row(e,'SELECT studio_name FROM campus_brand WHERE campus_id=2').studio_name,'不能改别的校区');
 z=await submit(e,{cookie,csrf:managerCsrf},'/api/users',{username:'newmanager',password:'long-long-password',role:'manager',campus_id:'2'});assert.equal(z.r.status,403);
 z=await submit(e,{cookie,csrf:managerCsrf},'/api/users',{username:'secondteacher',password:'long-long-password',role:'teacher',campus_id:'2'});assert.equal(z.r.status,200,z.v.error);
 z=await submit(e,{cookie,csrf:managerCsrf},'/api/users/1',{op:'role',role:'teacher'});assert.equal(z.r.status,403);
 const rootCheck=row(e,'SELECT role FROM user WHERE id=1');assert.equal(rootCheck.role,'super_admin');
});

test('class save state endpoint accurately reconciles a submitted teacher assignment',async()=>{
 const e=env(),admin=await loggedIn(e);
 let x=await submit(e,admin,'/api/users',{username:'teacherB',password:'secure-password-teacher-b',role:'teacher',campus_id:'1'});assert.equal(x.r.status,200,x.v.error);
 x=await submit(e,admin,'/api/courses',{campus_id:'1',name:'创意绘画'});assert.equal(x.r.status,200,x.v.error);
 x=await submit(e,admin,'/api/classes',{campus_id:'1',course_id:'1',name:'周一创意班',weekday:'周一',start_time:'13:00',end_time:'15:00',capacity:'10',deduct_lessons:'1'});assert.equal(x.r.status,200,x.v.error);
 x=await submit(e,admin,'/api/classes/1',{name:'周一创意班',course_id:'1',teacher_id:'2',weekday:'周一',start_time:'13:00',end_time:'15:00',capacity:'10',deduct_lessons:'1',room:'二号教室',is_archived:'0'});
 assert.equal(x.r.status,200,x.v.error);
 const r=await send(e,'/api/classes/state/1','GET',null,admin.cookie,'application/json');assert.equal(r.status,200);
 const state=await r.json();assert.equal(state.group.teacher_id,2);assert.equal(state.group.room,'二号教室');
 const unauthorized=await send(e,'/api/classes/state/1','GET',null,'','application/json');assert.equal(unauthorized.status,401);
});

test('class capacity cannot be reduced below the current active enrollment',async()=>{
 const e=env(),admin=await loggedIn(e);
 let x=await submit(e,admin,'/api/courses',{campus_id:'1',name:'素描'});assert.equal(x.r.status,200,x.v.error);
 x=await submit(e,admin,'/api/classes',{campus_id:'1',course_id:'1',name:'周六素描',weekday:'周六',start_time:'09:00',end_time:'11:00',capacity:'2',deduct_lessons:'1'});assert.equal(x.r.status,200,x.v.error);
 for(const name of ['甲','乙']){x=await submit(e,admin,'/api/students',{campus_id:'1',name,class_group_id:'1'});assert.equal(x.r.status,200,x.v.error)}
 x=await submit(e,admin,'/api/classes/1',{name:'周六素描',course_id:'1',weekday:'周六',start_time:'09:00',end_time:'11:00',capacity:'1',deduct_lessons:'1',room:'',is_archived:'0'});
 assert.equal(x.r.status,400);assert.match(x.v.error,/班额/);assert.equal(row(e,'SELECT capacity FROM class_group WHERE id=1').capacity,2);
});

test('same student in several classes has safe quick-deduct shared balance',async()=>{
 const e=env(),admin=await loggedIn(e);
 for(const name of ['素描','水粉']){let x=await submit(e,admin,'/api/courses',{campus_id:'1',name});assert.equal(x.r.status,200,x.v.error)}
 for(let i=1;i<=2;i++){let x=await submit(e,admin,'/api/classes',{campus_id:'1',course_id:String(i),name:'班'+i,weekday:'周日',start_time:'09:00',end_time:'11:00',capacity:'10',deduct_lessons:'1'});assert.equal(x.r.status,200,x.v.error)}
 let x=await submit(e,admin,'/api/students',{campus_id:'1',name:'同人多班',class_group_id:'1'});assert.equal(x.r.status,200,x.v.error);
 x=await submit(e,admin,'/api/students/1/enroll',{class_group_id:'2'});assert.equal(x.r.status,200,x.v.error);
 x=await submit(e,admin,'/api/students/1/payment',{type:'charge',lessons:'1',bonus:'0',amount:'0',nonce:'test-multiclass-payment-unique'});assert.equal(x.r.status,200,x.v.error);
 x=await submit(e,admin,'/api/quick/1/1',{});assert.equal(x.r.status,200,x.v.error);
 x=await submit(e,admin,'/api/quick/2/1',{});assert.equal(x.r.status,400);assert.equal(row(e,'SELECT lessons_remaining FROM student WHERE id=1').lessons_remaining,0);
 const html=(await (await send(e,'/','GET',null,admin.cookie)).text());assert.match(html,/data-student-id="1" data-used=/);assert.match(html,/data-deduct="1"/);
});

test('separate campus accounts cannot retrieve another campus class save state',async()=>{
 const e=env(),admin=await loggedIn(e);
 let x=await submit(e,admin,'/api/campuses',{name:'第二校区',code:'BRANCH2'});assert.equal(x.r.status,200,x.v.error);
 x=await submit(e,admin,'/api/users',{username:'subAdmin',password:'secure-password-sub-admin',role:'manager',campus_id:'2'});assert.equal(x.r.status,200,x.v.error);
 x=await submit(e,admin,'/api/courses',{campus_id:'1',name:'主校区课程'});assert.equal(x.r.status,200,x.v.error);
 x=await submit(e,admin,'/api/classes',{campus_id:'1',course_id:'1',name:'主校区班',weekday:'周日',start_time:'09:00',end_time:'10:00',capacity:'12',deduct_lessons:'1'});assert.equal(x.r.status,200,x.v.error);
 const r=await send(e,'/login','POST',{username:'subAdmin',password:'secure-password-sub-admin'});const cookie=r.headers.get('Set-Cookie').split(';')[0];
 const page=await send(e,'/api/classes/state/1','GET',null,cookie,'application/json');assert.equal(page.status,403);
});

test('regression: adjusting 12 lessons is independent of payment and preserves audit records',async()=>{
 const e=env(),admin=await loggedIn(e);
 let r=await submit(e,admin,'/api/students',{campus_id:'1',name:'小晚（演示）'});
 assert.equal(r.r.status,200,r.v.error);
 let page=await send(e,'/students/1','GET',null,admin.cookie);
 assert.equal(page.status,200);const doc=await page.text();
 assert.match(doc,/人工调整余额 · 补录 \/ 纠错/);
 assert.match(doc,/交费登记 · 续费 \/ 赠课/);
 assert.equal((doc.match(/class="js-balance-form"/g)||[]).length,2);
 // Two independently submitted forms: neither should contain the other mode's inputs.
 const forms=[...doc.matchAll(/<form[^>]*class="js-balance-form"[^>]*>([\s\S]*?)<\/form>/g)].map(m=>m[1]);
 assert.equal(forms.length,2,'admin should see two distinct balance forms');
 assert.match(forms[0],/name="type" value="adjust"/);
 assert.match(forms[0],/name="delta"/);
 assert.doesNotMatch(forms[0],/name="lessons"/);
 assert.match(forms[1],/name="type" value="charge"/);
 assert.match(forms[1],/name="lessons"/);
 assert.doesNotMatch(forms[1],/name="delta"/);
 const p='/api/students/1/payment';
 r=await submit(e,admin,p,{type:'adjust',delta:'12',remarks:'历史课时补录',nonce:'balance-12-unique-01234567890'});
 assert.equal(r.r.status,200,r.v.error);
 assert.equal(row(e,'SELECT lessons_remaining FROM student WHERE id=1').lessons_remaining,12);
 assert.equal(row(e,'SELECT lessons_delta FROM payment_record WHERE student_id=1').lessons_delta,12);
 r=await submit(e,admin,p,{type:'adjust',delta:'-2',remarks:'纠正初始录入',nonce:'balance-minus2-unique-012345'});
 assert.equal(r.r.status,200,r.v.error);
 assert.equal(row(e,'SELECT lessons_remaining FROM student WHERE id=1').lessons_remaining,10);
 for(const [delta,remarks,expected] of [['-11','扣多了','余额只有 10 节'],['0','原因','不能为 0'],['2','','调整原因']]){
  r=await submit(e,admin,p,{type:'adjust',delta,remarks,nonce:'reject-'+delta.replace('-','m')+'-unique-01234567890'});
  assert.equal(r.r.status,400);assert.match(r.v.error,new RegExp(expected));
  assert.equal(row(e,'SELECT lessons_remaining FROM student WHERE id=1').lessons_remaining,10);
 }
 r=await submit(e,admin,p,{type:'charge',lessons:'0',bonus:'0',amount:'0',nonce:'zero-charge-unique-0123456'});
 assert.equal(r.r.status,400);assert.match(r.v.error,/购买课时和赠课不能同时为 0/);
 // Mirrors the user's screenshot: bad old UI submitted charge plus a populated delta;
 // the API must explain the bad mode rather than claim balance was insufficient.
 r=await submit(e,admin,p,{type:'charge',lessons:'0',bonus:'0',amount:'0',delta:'12',nonce:'wrong-mode-unique-0123456'});
 assert.equal(r.r.status,400);assert.match(r.v.error,/请使用上方的“人工调整余额”/);
 r=await submit(e,admin,p,{type:'bogus',delta:'12',remarks:'测试',nonce:'wrong-type-unique-0123456'});
 assert.equal(r.r.status,400);assert.match(r.v.error,/操作类型不正确/);
 assert.equal(row(e,'SELECT COUNT(*) n FROM payment_record').n,2);
 assert.equal(row(e,'SELECT lessons_remaining FROM student WHERE id=1').lessons_remaining,10);
});

test('V7: historical lesson date, operator separation, refund is atomic and idempotent',async()=>{
 const e=env(),s=await loggedIn(e);
 await submit(e,s,'/api/courses',{campus_id:'1',name:'绘画'});
 await submit(e,s,'/api/classes',{campus_id:'1',course_id:'1',name:'补课班',weekday:'周日',start_time:'09:00',end_time:'11:00'});
 await submit(e,s,'/api/students',{campus_id:'1',name:'历史测试',class_group_id:'1'});
 let x=await submit(e,s,'/api/students/1/payment',{type:'charge',lessons:'12',bonus:'0',amount:'500',nonce:'v7-charge-unique-123456789000'});assert.equal(x.r.status,200,x.v.error);
 x=await submit(e,s,'/api/students/1/manual',{class_group_id:'1',count:'2',lesson_date:'2026-09-21',reason:'补记上月授课',nonce:'v7-manual-unique-123456789000'});
 assert.equal(x.r.status,200,x.v.error);assert.equal(row(e,'SELECT lessons_remaining FROM student WHERE id=1').lessons_remaining,10);
 let lr=row(e,'SELECT * FROM lesson_record WHERE student_id=1');assert.equal(lr.lesson_date,'2026-09-21');assert.equal(lr.actor_id,s?1:null);
 x=await submit(e,s,'/api/students/1/refund',{amount:'90.50',lessons:'2',reason:'取消部分课程退费',nonce:'v7-refund-nonce-1234567890'});
 assert.equal(x.r.status,200,x.v.error);assert.equal(row(e,'SELECT lessons_remaining FROM student WHERE id=1').lessons_remaining,8);
 x=await submit(e,s,'/api/students/1/refund',{amount:'90.50',lessons:'2',reason:'取消部分课程退费',nonce:'v7-refund-nonce-1234567890'});
 assert.equal(x.r.status,400);assert.equal(row(e,'SELECT COUNT(*) n FROM refund_record').n,1);
 x=await submit(e,s,'/api/students/1/refund',{amount:'90',lessons:'9',reason:'试图超额扣回',nonce:'v7-refund-nonce-new-12345678'});
 assert.equal(x.r.status,400);assert.equal(row(e,'SELECT lessons_remaining FROM student WHERE id=1').lessons_remaining,8);
 const r=await send(e,'/finance','GET',null,s.cookie);assert.equal(r.status,200);const h=await r.text();assert.match(h,/退款流水/);assert.match(h,/最近 6 个月/);assert.match(h,/支出构成/);
});

test('V7: trial attendance does not charge lessons, no same day replay',async()=>{
 const e=env(),s=await loggedIn(e);
 await submit(e,s,'/api/courses',{campus_id:'1',name:'试听课'});
 await submit(e,s,'/api/classes',{campus_id:'1',course_id:'1',name:'试听班',weekday:'周三',start_time:'09:00',end_time:'11:00'});
 await submit(e,s,'/api/students',{campus_id:'1',name:'试听生',class_group_id:'1'});
 e.DB.db.prepare("UPDATE student SET status='trial' WHERE id=1").run();
 let x=await submit(e,s,'/api/trial/1/1',{});assert.equal(x.r.status,200,x.v.error);assert.equal(x.v.remaining,0);
 assert.equal(row(e,'SELECT deducted_lessons FROM lesson_record WHERE student_id=1').deducted_lessons,0);
 assert.equal(row(e,'SELECT status FROM lesson_record WHERE student_id=1').status,'trial');
 x=await submit(e,s,'/api/trial/1/1',{});assert.equal(x.r.status,400);
 let r=await send(e,'/','GET',null,s.cookie);assert.match(await r.text(),/✓ 已到课/);
});

test('V7: navigation and readonly backup center render, role restrictions',async()=>{
 const e=env(),s=await loggedIn(e);
 for (const page of ['/manage','/data','/finance','/classes','/profile']){
  const response=await send(e,page,'GET',null,s.cookie);assert.equal(response.status,200,page);
  const markup=await response.text();assert.match(markup,/<html/);assert.doesNotMatch(markup,/<script[^>]*src="https:\/\//);
 }
 const html=await (await send(e,'/manage','GET',null,s.cookie)).text();assert.match(html,/数据与备份/);
});

test('V7: cancelled registration can reapply using the same name and phone',async()=>{
 const e=env(),s=await loggedIn(e);
 await submit(e,s,'/api/courses',{campus_id:'1',name:'报名课'});
 await submit(e,s,'/api/classes',{campus_id:'1',course_id:'1',name:'测试班',weekday:'周一',start_time:'09:00',end_time:'11:00',capacity:'5'});
 await submit(e,s,'/api/entries',{campus_id:'1',name:'报名入口'});
 const token=row(e,'SELECT token FROM registration_entry').token;
 let r=await send(e,`/r/${token}`,'POST',{class_group_id:'1',student_name:'小新',grade:'二年级',guardian_phone:'13812345678'});assert.equal(r.status,200);
 let x=await submit(e,s,'/api/registrations/1',{status:'cancelled'});assert.equal(x.r.status,200,x.v.error);
 r=await send(e,`/r/${token}`,'POST',{class_group_id:'1',student_name:'小新',grade:'二年级',guardian_phone:'13812345678'});assert.equal(r.status,200,await r.text());
 assert.equal(row(e,"SELECT COUNT(*) AS n FROM registration WHERE status='pending'").n,1);
 assert.equal(row(e,'SELECT COUNT(*) AS n FROM registration').n,1);
});

test('V7: pending registrations consume capacity when shrinking a class',async()=>{
 const e=env(),s=await loggedIn(e);
 await submit(e,s,'/api/courses',{campus_id:'1',name:'报名课'});
 await submit(e,s,'/api/classes',{campus_id:'1',course_id:'1',name:'容量测试',weekday:'周一',start_time:'09:00',end_time:'11:00',capacity:'2'});
 await submit(e,s,'/api/entries',{campus_id:'1',name:'报名入口'});
 const token=row(e,'SELECT token FROM registration_entry').token;
 for (const name of ['小李','小王']){const r=await send(e,`/r/${token}`,'POST',{class_group_id:'1',student_name:name,grade:'二年级',guardian_phone:name==='小李'?'13955555555':'13944444444'});assert.equal(r.status,200,await r.text());}
 let x=await submit(e,s,'/api/classes/1',{name:'容量测试',course_id:'1',weekday:'周一',start_time:'09:00',end_time:'11:00',capacity:'1',deduct_lessons:'1'});
 assert.equal(x.r.status,400);assert.equal(row(e,'SELECT capacity FROM class_group WHERE id=1').capacity,2);
});

// Regression: iOS Safari may decode WebP but cannot encode it through canvas.toBlob.
// Canvas JPEG fallback must upload to R2 and render publicly with the correct MIME.
test('V7.0.3 JPEG normalization: canvas and mobile metadata variants are safe to store',async()=>{
 const bytes=fs.readFileSync(new URL('./fixtures/canvas-reencoded.jpg',import.meta.url));
 assert.equal(cleanJpeg(bytes),true);assert.equal(safeImageInfo(bytes)?.contentType,'image/jpeg');
 const app1=Buffer.from([0xff,0xe1,0x00,0x0c,0x45,0x78,0x69,0x66,0x00,0x00,0x00,0x00,0x00,0x00]);
 const gps=Buffer.concat([bytes.subarray(0,2),app1,bytes.subarray(2)]);
 assert.equal(cleanJpeg(gps),false);const gpsClean=safeImageInfo(gps);assert.equal(gpsClean?.contentType,'image/jpeg');assert.deepEqual(Buffer.from(gpsClean.bytes),Buffer.from(stripJpegMetadata(bytes)),'server must strip EXIF before storing');
 const e=env(),s=await loggedIn(e);
 let t=await submit(e,s,'/api/students',{campus_id:'1',name:'相册测试'});assert.equal(t.r.status,200,t.v.error);
 t=await submit(e,s,'/api/students/1/share',{enabled:'1',consent:'1',public_name:'相册测试'});assert.equal(t.r.status,200,t.v.error);
 const token=row(e,'SELECT token FROM student_share').token;
 const makeForm=(nonce,file)=>{const form=new FormData();form.set('csrf_token',s.csrf);form.set('title','课堂作品');form.set('upload_nonce',nonce);form.set('photo',new Blob([file],{type:'image/jpeg'}),'work.jpg');return form;};
 let response=await send(e,'/api/students/1/upload','POST',makeForm('jpeg-sanitized-nonce-1234567',bytes),s.cookie,'application/json');
 let out=await response.json();assert.equal(response.status,200,out.error);assert.equal(out.ok,true);
 let art=row(e,'SELECT image_key FROM artwork ORDER BY id DESC LIMIT 1');assert.match(art.image_key,/\.jpg$/);
 response=await send(e,`/media/1`,'GET',null,s.cookie);assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'image/jpeg');
 response=await send(e,`/p/${token}/img/1`);assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'image/jpeg');
 response=await send(e,'/api/students/1/upload','POST',makeForm('jpeg-raw-exif-nonce-9876543',gps),s.cookie,'application/json');
 assert.equal(response.status,200,'valid mobile JPEG should be normalized server-side');assert.equal(row(e,'SELECT COUNT(*) n FROM artwork').n,2);
 response=await send(e,'/media/2','GET',null,s.cookie);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from(stripJpegMetadata(bytes)),'R2 served bytes must not contain EXIF/GPS');
 // One of the other image paths (studio logo) must accept the same safe JPEG.
 const form=new FormData();form.set('csrf_token',s.csrf);form.set('campus_id','1');form.set('photo',new Blob([bytes],{type:'image/jpeg'}),'logo.jpg');
 response=await send(e,'/api/branding/logo','POST',form,s.cookie,'application/json');out=await response.json();assert.equal(response.status,200,out.error);
 response=await send(e,'/branding/logo/1');assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'image/jpeg');
});


test('V7.0.3 accepts progressive JPEG and strips app-specific metadata without changing image data',async()=>{
 const p=fs.readFileSync(new URL('./fixtures/progressive-generated.jpg',import.meta.url));
 const segment=(marker,payload)=>{const b=Buffer.alloc(4+payload.length);b[0]=255;b[1]=marker;b.writeUInt16BE(payload.length+2,2);payload.copy(b,4);return b;};
 const withTags=Buffer.concat([p.subarray(0,2),
  segment(0xe1,Buffer.from('Exif\x00\x00SAMPLE-GPS-PRIVATE')),
  segment(0xed,Buffer.from('Photoshop 3.0-private-data')),
  segment(0xe2,Buffer.from('ICC_PROFILE\x00some-colors')) ,p.subarray(2)]);
 assert.equal(cleanJpeg(withTags),false);
 const normalized=stripJpegMetadata(withTags);
 assert.ok(normalized,'valid progressive JPEG should parse');
 assert.ok(!Buffer.from(normalized).includes(Buffer.from('SAMPLE-GPS-PRIVATE')),'GPS removed');
 assert.ok(!Buffer.from(normalized).includes(Buffer.from('Photoshop')),'photoshop metadata removed');
 assert.deepEqual(Buffer.from(normalized),p.subarray(0,2).equals(Buffer.from([255,216]))
  ? Buffer.from(stripJpegMetadata(p)) : p);
 const invalid=Buffer.concat([withTags.subarray(0,withTags.length-2),Buffer.from('bad')]);
 assert.equal(stripJpegMetadata(invalid),null,'truncated image must be rejected');
 const htmlPage=await (async()=>{const e=env(),s=await loggedIn(e);await submit(e,s,'/api/students',{campus_id:'1',name:'UI test'});const res=await send(e,'/students/1/upload','GET',null,s.cookie);return res.text()})();
 assert.match(htmlPage,/class="ld-upload-description"/);
 assert.doesNotMatch(htmlPage,/class="ld-collapse ld-upload-note"/);
});


test('V7.1: campus rename keeps identifiers and every linked student/class/lesson intact',async()=>{
 const e=env(),s=await loggedIn(e);
 let r=await submit(e,s,'/api/courses',{campus_id:'1',name:'素描'});assert.equal(r.r.status,200);
 r=await submit(e,s,'/api/classes',{campus_id:'1',course_id:'1',name:'周末班',weekday:'周六',start_time:'09:00',end_time:'11:00',capacity:'10',deduct_lessons:'1'});assert.equal(r.r.status,200);
 r=await submit(e,s,'/api/students',{campus_id:'1',name:'测试生',class_group_id:'1'});assert.equal(r.r.status,200);
 r=await submit(e,s,'/api/students/1/payment',{type:'charge',lessons:'5',amount:'100',nonce:'rename-test-payment-nonce-00001'});assert.equal(r.r.status,200);
 const campusBefore=row(e,'SELECT * FROM campus WHERE id=1');const balance=row(e,'SELECT lessons_remaining FROM student WHERE id=1').lessons_remaining;
 r=await submit(e,s,'/api/campuses/1/rename',{name:'示例画室'});assert.equal(r.r.status,200,r.v.error);assert.equal(r.v.redirect,'/campuses?updated=1');
 const after=row(e,'SELECT * FROM campus WHERE id=1');assert.equal(after.name,'示例画室');assert.equal(after.id,campusBefore.id);assert.equal(after.code,campusBefore.code);
 assert.equal(row(e,'SELECT campus_id FROM student WHERE id=1').campus_id,1);assert.equal(row(e,'SELECT campus_id FROM class_group WHERE id=1').campus_id,1);assert.equal(row(e,'SELECT lessons_remaining FROM student WHERE id=1').lessons_remaining,balance);
 assert.equal(row(e,"SELECT action FROM operation_log WHERE target='campus' ORDER BY id DESC LIMIT 1").action,'rename');
 let page=await send(e,'/campuses','GET',null,s.cookie);assert.equal(page.status,200);assert.match(await page.text(),/示例画室/);
 r=await submit(e,s,'/api/campuses/1/rename',{name:'示例画室'});assert.equal(r.r.status,200);assert.match(r.v.redirect,/unchanged/);
 assert.equal(row(e,"SELECT count(*) AS n FROM operation_log WHERE target='campus' AND action='rename'").n,1);
 assert.equal(row(e,'SELECT count(*) n FROM campus').n,1);
});

test('V7.1: campus rename permission boundary and duplicate names',async()=>{
 const e=env(),s=await loggedIn(e);
 let r=await submit(e,s,'/api/campuses',{name:'第二校区',code:'SECOND'});assert.equal(r.r.status,200);
 r=await submit(e,s,'/api/campuses/1/rename',{name:'第二校区'});assert.equal(r.r.status,409);
 assert.equal(row(e,'SELECT name FROM campus WHERE id=1').name,'画室');
 r=await submit(e,s,'/api/users',{username:'localmgr',password:'manager-long-test-password',role:'manager',campus_id:'1'});assert.equal(r.r.status,200);
 let resp=await send(e,'/login','POST',{username:'localmgr',password:'manager-long-test-password'});
 assert.equal(resp.status,303);const cookie=resp.headers.get('Set-Cookie').split(';')[0];const actor=row(e,"SELECT id FROM user WHERE username='localmgr'").id;
 const csrf=row(e,'SELECT csrf_token FROM session WHERE user_id=?',[actor]).csrf_token;
 resp=await send(e,'/campuses','GET',null,cookie);assert.equal(resp.status,200);assert.match(await resp.text(),/画室/);assert.doesNotMatch(await (await send(e,'/campuses','GET',null,cookie)).text(),/第二校区/);
 resp=await send(e,'/api/campuses/2/rename','POST',{csrf_token:csrf,name:'非法重命名'},cookie,'application/json');assert.equal(resp.status,403);
 resp=await send(e,'/api/campuses/1/rename','POST',{csrf_token:csrf,name:'示例校区A'},cookie,'application/json');assert.equal(resp.status,200);
 assert.equal(row(e,'SELECT name FROM campus WHERE id=1').name,'示例校区A');
 assert.equal(row(e,'SELECT name FROM campus WHERE id=2').name,'第二校区');
});

test('V7.1: GET and POST trailing slash variants, original CSRF and no double write',async()=>{
 const e=env(),s=await loggedIn(e);
 for(const p of ['/','/students/','/classes/','/finance/','/campuses/','/branding/','/profile/']){
  const r=await send(e,p,'GET',null,s.cookie);assert.equal(r.status,200,p);
 }
 let r=await submit(e,s,'/api/students/',{campus_id:'1',name:'尾斜杠学员'});assert.equal(r.r.status,200,r.v.error);
 assert.equal(row(e,'SELECT COUNT(*) n FROM student').n,1);
 r=await submit(e,s,'/api/campuses/1/rename/',{name:'更新名称'});assert.equal(r.r.status,200,r.v.error);
 const page=await send(e,'/students/1/','GET',null,s.cookie);assert.equal(page.status,200);
 const unknown=await send(e,'/does-not-exist/','GET',null,s.cookie);assert.equal(unknown.status,404);
 const unauth=await send(e,'/campuses/');assert.equal(unauth.status,401);
 const raw=await send(e,'/api/campuses/1/rename/','POST',{name:'没有 CSRF'},s.cookie,'application/json');assert.equal(raw.status,403);
 // Old direct HTML forms still POST only once and receive one 303 to a valid page.
 const resp=await send(e,'/api/campuses/1/rename/','POST',{csrf_token:s.csrf,name:'正式名称'},s.cookie);
 assert.equal(resp.status,303);assert.match(resp.headers.get('Location'),/^\/campuses\?updated=1&saved=1$/);
 const redirected=await send(e,resp.headers.get('Location'),'GET',null,s.cookie);assert.equal(redirected.status,200);
 assert.equal(row(e,'SELECT name FROM campus WHERE id=1').name,'正式名称');
});

test('V7.1: parent share and registration public links allow trailing slash without changing tokens',async()=>{
 const e=env(),s=await loggedIn(e);
 let t=await submit(e,s,'/api/students',{campus_id:'1',name:'公开页学员'});assert.equal(t.r.status,200);
 t=await submit(e,s,'/api/students/1/share',{enabled:'1',consent:'1',public_name:'小画家'});assert.equal(t.r.status,200);
 const token=row(e,'SELECT token FROM student_share').token;
 let r=await send(e,`/p/${token}/`);assert.equal(r.status,200);assert.match(await r.text(),/小画家/);
 t=await submit(e,s,'/api/branding',{campus_id:'1',studio_name:'示例画室'});assert.equal(t.r.status,200);
 t=await submit(e,s,'/api/campuses/1/rename',{name:'示例画室内校区'});assert.equal(t.r.status,200);
 assert.equal(row(e,'SELECT studio_name FROM campus_brand WHERE campus_id=1').studio_name,'示例画室', 'Renaming campus must not silently override public branding');
 r=await send(e,`/p/${token}/`);assert.equal(r.status,200);assert.match(await r.text(),/示例画室/);
 t=await submit(e,s,'/api/entries',{campus_id:'1',name:'报名测试'});assert.equal(t.r.status,200);
 const rt=row(e,'SELECT token FROM registration_entry').token;
 r=await send(e,`/r/${rt}/`);assert.equal(r.status,200);
 r=await send(e,`/r/${rt}/modify/`);assert.equal(r.status,200);
});
