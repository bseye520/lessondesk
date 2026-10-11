// Generates STATIC DEMO HTML to inspect actual Worker-rendered markup. Never touches D1.
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';import path from 'node:path';
import {randomToken,sha256} from '../src/lib.js';import app from '../src/index.js';
const root=new URL('../docs/previews/site/',import.meta.url),out=new URL('../docs/previews/',import.meta.url);
fs.mkdirSync(root,{recursive:true});
const base=fs.readFileSync(new URL('../migrations/0001_schema.sql',import.meta.url),'utf8')+'\n'+fs.readFileSync(new URL('../migrations/0002_branding.sql',import.meta.url),'utf8')+'\n'+fs.readFileSync(new URL('../migrations/0003_v7.sql',import.meta.url),'utf8');
const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON;'+base);
sqlite.exec("INSERT INTO campus(id,name,code) VALUES(1,'示例画室','MAIN');INSERT INTO user(id,username,password_hash,role,campus_id) VALUES(1,'demo','x','manager',1);INSERT INTO course(id,campus_id,name) VALUES(1,1,'素描基础');INSERT INTO course(id,campus_id,name) VALUES(2,1,'创意绘画');INSERT INTO class_group(id,campus_id,course_id,name,teacher_id,weekday,start_time,end_time,room,capacity) VALUES(1,1,1,'周六素描班',1,'周六','09:00','11:00','A教室',15);INSERT INTO class_group(id,campus_id,course_id,name,teacher_id,weekday,start_time,end_time,room,capacity) VALUES(2,1,2,'周日创意班',1,'周日','14:00','16:00','B教室',15);INSERT INTO campus_brand(campus_id,studio_name,slogan,address,contact,logo_key,qr_key) VALUES(1,'示例画室','在创作中发现自己的世界','演示地址：艺术路 18 号','联系老师：演示联系方式','demo-logo','demo-qr');");
const names=['小鹿','小竹','小禾','小北','小豆','小鱼','阿栗','小晚','小果','小米','小墨','小可'];
for(let i=0;i<names.length;i++){
 let id=i+1,group=i<8?1:2,rem=[6,10,12,8,24,16,3,12,15,7,18,20][i];
 sqlite.prepare('INSERT INTO student(id,campus_id,name,status,lessons_remaining) VALUES(?,1,?,?,?)').run(id,names[i],'active',rem);
 sqlite.prepare("INSERT INTO enrollment(campus_id,student_id,class_group_id,status) VALUES(1,?,?,'active')").run(id,group);
}
const token='abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',sid=1;
sqlite.prepare('INSERT INTO student_share(student_id,token,enabled,public_name,approved_at) VALUES(?,?,1,?,CURRENT_TIMESTAMP)').run(sid,token,'小鹿');
for(let j=1;j<=3;j++)sqlite.prepare("INSERT INTO artwork(id,student_id,campus_id,uploader_id,image_key,title,note,is_public) VALUES(?,1,1,1,?,?,?,1)").run(j,'demo-'+j,['水粉静物','想象中的森林','色彩练习'][j-1],'课堂作品 · 演示');
const raw='a'.repeat(64),csrf='dev-csrf-token',exp=Math.floor(Date.now()/1000)+10000;
sqlite.prepare('INSERT INTO session(token_hash,user_id,csrf_token,expires_at) VALUES(?,?,?,?)').run(sha256(raw),1,csrf,exp);
class DB{prepare(sql){return{bind(...args){return{all:async()=>({results:sqlite.prepare(sql).all(...args)}),first:async()=>sqlite.prepare(sql).get(...args),run:async()=>{const x=sqlite.prepare(sql).run(...args);return{meta:{changes:Number(x.changes),last_row_id:Number(x.lastInsertRowid)}}}}}}}}
const env={DB:new DB(),ARTWORKS:{get:async()=>null},TZ:'Asia/Shanghai',SITE_NAME:'课时本',IP_HASH_SECRET:'dev'};
async function save(pathname,filename,logged=true){const req=new Request('https://demo.local'+pathname,{headers:logged?{Cookie:'__Host-ld_session='+raw}: {}});const res=await app.fetch(req,env);if(res.status!==200)throw Error(filename+' '+res.status+' '+await res.text());fs.writeFileSync(new URL(filename,root),await res.text());}
await save('/','index.html');await save('/students/1/upload','upload.html');await save('/branding','branding.html');await save('/p/'+token,'parent.html',false);await save('/profile','profile.html');await save('/campuses','campuses.html');
fs.cpSync(new URL('../public/',import.meta.url),root,{recursive:true});
for(const f of ['index.html','upload.html','branding.html','parent.html','profile.html','campuses.html']){
 const file=new URL(f,root);let markup=fs.readFileSync(file,'utf8');
 for(const section of ['css/','vendor/','icons/','app.js','public.js','manifest.webmanifest','preview-'])markup=markup.replaceAll('"/'+section,'"./'+section);
 markup=markup.replaceAll('/branding/logo/1','/preview-logo.webp').replaceAll('/branding/qr/1','/preview-qr.webp');
 markup=markup.replace(/\/p\/[a-f0-9]{64}\/img\/(\d+)/g,(_,id)=>'/preview-work-'+id+'.webp');
 markup=markup.replaceAll('"/preview-','"./preview-');
 fs.writeFileSync(file,markup);
}
console.log('Preview HTML created in',root.pathname);
