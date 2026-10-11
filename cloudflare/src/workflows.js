import {all,one,run,batch,field,intval,cents,err,uuid,randomToken,today,now,ipHash,logLine,requireVal,hashPassword,verifyPassword} from './lib.js';
import {manager,superuser,scoped,canSeeStudent,canManageGroup,makeUser} from './auth.js';

function ok(extra={}){return {ok:true,...extra};}
const ensure = (condition,message,status=400)=>{if(!condition)throw err(message,status);};
const sidRecord = async (env,u,id)=>scoped(u,await one(env.DB,'SELECT * FROM student WHERE id=?',id));
const campusId=(u,d)=>{const v=u.role==='super_admin'?intval(field(d,'campus_id'),1):u.campus_id;if(!v)throw err('需要选择校区');return v;};
const cgCampus=async(env,campus,gid,active=true)=>{const g=await one(env.DB,'SELECT * FROM class_group WHERE id=? AND campus_id=?',gid,campus);ensure(g&&(!active||!g.is_archived),'班级不存在或已归档');return g;};


export async function trialAttendance(env,u,gid,sid){
 const g=await canManageGroup(env,u,gid),s=await canSeeStudent(env,u,sid,true);
 ensure(!g.is_archived&&s.campus_id===g.campus_id&&s.status==='trial','仅试听学员可无扣费签到');
 const enrolled=await one(env.DB,"SELECT id FROM enrollment WHERE class_group_id=? AND student_id=? AND status='active'",gid,sid);ensure(enrolled,'学员不在此班级');
 const day=today(env.TZ),stamp=now();
 try{await batch(env.DB,[
  ['INSERT INTO quick_deduct(student_id,class_group_id,local_day,operator_id,created_at) VALUES(?,?,?,?,?)',sid,gid,day,u.id,stamp],
  ["INSERT INTO lesson_record(campus_id,class_group_id,student_id,teacher_id,date,status,deducted_lessons,lesson_date,actor_id,reason) VALUES(?,?,?,?,?,'trial',0,?,?,?)",g.campus_id,gid,sid,g.teacher_id||u.id,stamp,day,u.id,'试听到课，不扣课时'],
  ['UPDATE quick_deduct SET lesson_record_id=last_insert_rowid() WHERE student_id=? AND class_group_id=? AND local_day=?',sid,gid,day],
  logLine(u.id,'student',sid,'trial_attendance',`group=${gid}; day=${day}`)
 ]);}catch(ex){if(/UNIQUE|constraint/i.test(String(ex)))throw err('该学员今天已经登记过试听到课');throw ex;}
 const r=await one(env.DB,'SELECT lessons_remaining FROM student WHERE id=?',sid);
 return ok({remaining:r.lessons_remaining,deducted:0,undo:null});
}

export async function quickDeduct(env,u,gid,sid){const g=await canManageGroup(env,u,gid),s=await canSeeStudent(env,u,sid,true);ensure(!g.is_archived&&s.status!=='archived'&&s.campus_id===g.campus_id,'该班或学员不可操作');const joined=await one(env.DB,"SELECT 1 AS yes FROM enrollment WHERE student_id=? AND class_group_id=? AND status='active'",sid,gid);ensure(joined,'学员不在此班级');const qty=Number(g.deduct_lessons)||1;ensure(s.lessons_remaining>=qty,'剩余课时不足');const day=today(env.TZ),date=now(),teacher=g.teacher_id||u.id;
 try{await batch(env.DB,[
  ['INSERT INTO quick_deduct(student_id,class_group_id,local_day,operator_id,created_at) VALUES(?,?,?,?,?)',sid,gid,day,u.id,date],
  ['UPDATE student SET lessons_remaining=lessons_remaining-? WHERE id=? AND campus_id=?',qty,sid,g.campus_id],
  ["INSERT INTO lesson_record(campus_id,class_group_id,student_id,teacher_id,date,status,deducted_lessons,created_at,lesson_date,actor_id) VALUES(?,?,?,?,?,'present',?,?,?,?)",g.campus_id,gid,sid,teacher,date,qty,date,day,u.id],
  ['UPDATE quick_deduct SET lesson_record_id=last_insert_rowid() WHERE student_id=? AND class_group_id=? AND local_day=?',sid,gid,day],
  logLine(u.id,'student',sid,'quick_deduct',`group=${gid}; delta=-${qty}`)
 ]);}catch(ex){if(/UNIQUE|constraint/i.test(String(ex)))throw err('今天该班已快捷消课，重复上课请到学员档案补记；如余额不足请先核对。');throw ex;}
 const last=await one(env.DB,'SELECT q.lesson_record_id AS id, s.lessons_remaining AS remaining FROM quick_deduct q JOIN student s ON s.id=q.student_id WHERE q.student_id=? AND q.class_group_id=? AND q.local_day=?',sid,gid,day);
 return ok({remaining:last.remaining,deducted:qty,undo:`/api/undo/${last.id}`});}
export async function undoLesson(env,u,id,d=new Map()){const r=await one(env.DB,'SELECT * FROM lesson_record WHERE id=?',id);scoped(u,r);ensure(!r.revoked_at,'课时已经撤销');let teacherAllowed=false;const q=await one(env.DB,'SELECT * FROM quick_deduct WHERE lesson_record_id=?',id);
 if(u.role==='teacher'){teacherAllowed=Boolean(q)&&q.operator_id===u.id&&Date.now()-new Date(String(r.created_at).replace(' ','T')+'Z').getTime()<=300000;ensure(teacherAllowed,'教师只能撤销本人最近 5 分钟的快捷消课，请联系管理员');}
 const reason=field(d,'reason');if(u.role!=='teacher')requireVal(reason,'管理员撤销原因',200);const qty=r.deducted_lessons||0,mark=now();try{await batch(env.DB,[
  ['INSERT INTO lesson_batch(nonce,class_group_id,operator_id) VALUES(?,?,?)','undo:'+id,r.class_group_id,u.id],
  ['UPDATE lesson_record SET revoked_at=? WHERE id=? AND revoked_at IS NULL',mark,id],
  ['UPDATE student SET lessons_remaining=lessons_remaining+? WHERE id=? AND campus_id=?',qty,r.student_id,r.campus_id],
  ['DELETE FROM quick_deduct WHERE lesson_record_id=?',id],
  logLine(u.id,'lesson_record',id,'undo_deduct',`restored=${qty}; reason=${reason||'本人误操作'}`)
 ]);}catch(ex){if(/UNIQUE|constraint/i.test(String(ex)))throw err('这次消课已撤销，请刷新余额');throw ex;}const balance=await one(env.DB,'SELECT lessons_remaining FROM student WHERE id=?',r.student_id);return ok({remaining:balance.lessons_remaining});}
export async function manualDeduct(env,u,sid,d){const s=await canSeeStudent(env,u,sid,true),gid=intval(field(d,'class_group_id'),1),qty=intval(field(d,'count'),1,8),reason=requireVal(field(d,'reason'),'补记原因',200);const g=await canManageGroup(env,u,gid);ensure(g.campus_id===s.campus_id&&!g.is_archived,'班级与学员不匹配');const en=await one(env.DB,"SELECT id FROM enrollment WHERE student_id=? AND class_group_id=? AND status='active'",sid,gid);ensure(en,'学员未在班');ensure(qty&&s.lessons_remaining>=qty,'余额不足或课时数量不正确');const lessonDate=field(d,'lesson_date')||today(env.TZ);ensure(/^\d{4}-\d{2}-\d{2}$/.test(lessonDate)&&!Number.isNaN(Date.parse(lessonDate))&&lessonDate<=today(env.TZ),'授课日期必须为今天或有效的过去日期');const nonce=field(d,'nonce');ensure(/^[a-zA-Z0-9-]{20,80}$/.test(nonce),'操作凭据失效，请刷新');
 try{await batch(env.DB,[
  ['INSERT INTO lesson_batch(nonce,class_group_id,operator_id) VALUES(?,?,?)',nonce,gid,u.id],
  ['UPDATE student SET lessons_remaining=lessons_remaining-? WHERE id=?',qty,sid],
  ["INSERT INTO lesson_record(campus_id,class_group_id,student_id,teacher_id,date,status,deducted_lessons,lesson_date,actor_id,reason) VALUES(?,?,?,?,?,'present',?,?,?,?)",g.campus_id,gid,sid,g.teacher_id||u.id,now(),qty,lessonDate,u.id,reason],
  logLine(u.id,'student',sid,'manual_deduct',`group=${gid}; -${qty}; taught=${lessonDate}; ${reason}`)
 ]);}catch(ex){if(/UNIQUE|constraint/i.test(String(ex)))throw err('提交已处理或余额不足，请刷新核对');throw ex;}
 return ok({redirect:`/students/${sid}`});}
export async function payment(env,u,sid,d){
 manager(u);
 const s=await sidRecord(env,u,sid);
 const kind=field(d,'type');
 ensure(kind==='adjust'||kind==='charge','操作类型不正确，请刷新后重试');
 const reason=field(d,'remarks');
 let lessons=0,bonus=0,amount=0,delta=0;
 if(kind==='adjust'){
   delta=intval(field(d,'delta'),-10000,10000);
   ensure(delta!==null,'增减课时必须是 -10000 到 10000 的整数');
   ensure(delta!==0,'调整课时不能为 0，请输入增加或扣减的节数');
   ensure(s.lessons_remaining+delta>=0,`余额只有 ${s.lessons_remaining} 节，不能扣减 ${Math.abs(delta)} 节`);
   requireVal(reason,'调整原因',300);
 }else{
   lessons=intval(field(d,'lessons'),0,10000);
   bonus=intval(field(d,'bonus'),0,10000);
   amount=cents(field(d,'amount'));
   ensure(lessons!==null&&bonus!==null,'购买课时和赠课必须是非负整数');
   ensure(amount!==null,'实收金额必须是有效金额，最多两位小数');
   delta=lessons+bonus;
   ensure(delta>0,'购买课时和赠课不能同时为 0；如需人工补录，请使用上方的“人工调整余额”');
 }

 const nonce=field(d,'nonce');ensure(/^[a-zA-Z0-9-]{20,80}$/.test(nonce),'提交令牌过期，请刷新页面');try{await batch(env.DB,[
  ['INSERT INTO lesson_batch(nonce,operator_id) VALUES(?,?)','payment:'+nonce,u.id],
  ['UPDATE student SET lessons_remaining=lessons_remaining+? WHERE id=? AND campus_id=?',delta,sid,s.campus_id],
  ['INSERT INTO payment_record(campus_id,student_id,type,amount_cents,lessons_delta,lessons_bonus,operator_id,remarks) VALUES(?,?,?,?,?,?,?,?)',s.campus_id,sid,kind,amount,kind==='charge'?lessons:delta,kind==='charge'?bonus:0,u.id,reason],
  logLine(u.id,'student',sid,kind==='charge'?'charge':'adjust',`delta=${delta}; ${reason}`)
 ]);}catch(ex){if(/UNIQUE|constraint/i.test(String(ex)))throw err('这笔课时变更已提交或余额不够，请刷新核对');throw ex;}return ok({redirect:`/students/${sid}`});}

export async function refund(env,u,sid,d){
 manager(u);const s=await sidRecord(env,u,sid),amount=cents(field(d,'amount')),qty=intval(field(d,'lessons'),0,10000),reason=requireVal(field(d,'reason'),'退款原因',200),nonce=field(d,'nonce');
 ensure(amount!==null&&qty!==null&&(amount>0||qty>0),'退款金额或扣回课时必须大于零');
 ensure(qty<=s.lessons_remaining,'剩余课时不足，无法扣回这么多节');
 ensure(/^[a-zA-Z0-9-]{20,80}$/.test(nonce),'提交令牌无效');
 try{await batch(env.DB,[
  ['INSERT INTO lesson_batch(nonce,operator_id) VALUES(?,?)','refund:'+nonce,u.id],
  ['UPDATE student SET lessons_remaining=lessons_remaining-? WHERE id=? AND campus_id=?',qty,sid,s.campus_id],
  ['INSERT INTO refund_record(campus_id,student_id,amount_cents,lessons_debited,reason,operator_id,nonce) VALUES(?,?,?,?,?,?,?)',s.campus_id,sid,amount,qty,reason,u.id,nonce],
  logLine(u.id,'student',sid,'refund',`amount_cents=${amount}; lessons=-${qty}; ${reason}`)
 ]);}catch(ex){if(/UNIQUE|constraint/i.test(String(ex)))throw err('退款已提交或余额不足，请核对记录');throw ex;}
 return ok({redirect:`/students/${sid}`});
}

export async function studentCreate(env,u,d){manager(u);const campus=campusId(u,d),name=requireVal(field(d,'name'),'姓名',50);const phone=field(d,'phone').slice(0,25);const gId=intval(field(d,'class_group_id'),1)||null;if(gId)await cgCampus(env,campus,gId);
 const operations=[['INSERT INTO student(campus_id,name,phone,parent_name,grade,gender,birthday,remarks,status) VALUES(?,?,?,?,?,?,?,?,?)',campus,name,phone,field(d,'parent_name').slice(0,50),field(d,'grade').slice(0,50),field(d,'gender').slice(0,10),field(d,'birthday')||null,field(d,'remarks').slice(0,1000),'active']];
 if(gId)operations.push(['INSERT INTO enrollment(campus_id,student_id,class_group_id,status) VALUES(?,last_insert_rowid(),?,?)',campus,gId,'active']);
 let changes;try{changes=await batch(env.DB,operations);}catch(ex){if(/CLASS_FULL/i.test(String(ex)))throw err('班级已满，学员尚未创建');throw ex;}
 const id=changes[0].meta.last_row_id;await run(env.DB,'INSERT INTO operation_log(user_id,target,target_id,action,detail) VALUES(?,?,?,?,?)',u.id,'student',id,'create',name);return ok({redirect:`/students/${id}`});}
export async function studentUpdate(env,u,id,d){manager(u);const s=await sidRecord(env,u,id);const status=field(d,'status')||s.status;ensure(['active','trial','archived'].includes(status),'无效状态');const name=requireVal(field(d,'name'),'姓名',50);const queries=[['UPDATE student SET name=?,phone=?,parent_name=?,grade=?,gender=?,remarks=?,status=? WHERE id=?',name,field(d,'phone').slice(0,25),field(d,'parent_name').slice(0,50),field(d,'grade').slice(0,50),field(d,'gender').slice(0,10),field(d,'remarks').slice(0,1000),status,id]];
 if(status==='archived')queries.push(["UPDATE enrollment SET status='left',left_at=? WHERE student_id=? AND status='active'",now(),id]);queries.push(logLine(u.id,'student',id,'update',`status=${status}`));await batch(env.DB,queries);return ok({redirect:`/students/${id}`});}
export async function enroll(env,u,sid,gid){manager(u);const s=await sidRecord(env,u,sid);const g=await cgCampus(env,s.campus_id,gid);ensure(s.status!=='archived','归档学员无法加班');const sql=`INSERT INTO enrollment(campus_id,student_id,class_group_id,status) SELECT ?,?,?,'active' WHERE (SELECT CASE WHEN ?=0 THEN 1 WHEN (SELECT count(*) FROM enrollment WHERE class_group_id=? AND status='active') < ?+? THEN 1 ELSE 0 END)=1 ON CONFLICT(student_id,class_group_id) DO UPDATE SET status='active',left_at=NULL WHERE enrollment.status='left' AND (SELECT CASE WHEN ?=0 THEN 1 WHEN (SELECT count(*) FROM enrollment WHERE class_group_id=? AND status='active') < ?+? THEN 1 ELSE 0 END)=1`;
 const result=await run(env.DB,sql,s.campus_id,sid,gid,g.capacity,gid,g.capacity,g.allow_override?g.override_extra:0,g.capacity,gid,g.capacity,g.allow_override?g.override_extra:0);ensure(result.meta.changes===1,'班级可能已满或学员已经在班');await run(env.DB,'INSERT INTO enrollment_event(campus_id,student_id,class_group_id,action,operator_id) VALUES(?,?,?,?,?)',s.campus_id,sid,gid,'join',u.id);return ok({redirect:`/students/${sid}`});}
export async function leave(env,u,sid,gid){manager(u);const s=await sidRecord(env,u,sid),g=await cgCampus(env,s.campus_id,gid,false);await batch(env.DB,[["UPDATE enrollment SET status='left',left_at=? WHERE student_id=? AND class_group_id=? AND status='active'",now(),sid,gid],['INSERT INTO enrollment_event(campus_id,student_id,class_group_id,action,operator_id) VALUES(?,?,?,?,?)',s.campus_id,sid,gid,'leave',u.id],logLine(u.id,'student',sid,'leave',`group=${gid}`)]);return ok({redirect:`/students/${sid}`});}
export async function courseCreate(env,u,d){manager(u);const campus=campusId(u,d),name=requireVal(field(d,'name'),'课程名称',100);const r=await run(env.DB,'INSERT INTO course(campus_id,name,category) VALUES(?,?,?)',campus,name,field(d,'category').slice(0,30)||'其他');await run(env.DB,'INSERT INTO operation_log(user_id,target,target_id,action,detail) VALUES(?,?,?,?,?)',u.id,'course',r.meta.last_row_id,'create',name);return ok({redirect:'/courses'});}
export async function courseUpdate(env,u,id,d){manager(u);const old=scoped(u,await one(env.DB,'SELECT * FROM course WHERE id=?',id));const name=requireVal(field(d,'name'),'课程名称',100);await batch(env.DB,[['UPDATE course SET name=?,category=?,is_archived=? WHERE id=?',name,field(d,'category').slice(0,30),field(d,'is_archived')==='1'?1:0,id],logLine(u.id,'course',id,'update',name)]);return ok({redirect:'/courses'});}
export async function classCreate(env,u,d){manager(u);const campus=campusId(u,d),courseId=intval(field(d,'course_id'),1),teacherId=intval(field(d,'teacher_id'),1)||null;const course=await one(env.DB,'SELECT * FROM course WHERE id=? AND campus_id=? AND is_archived=0',courseId,campus);ensure(course,'课程不属于该校区');if(teacherId){const t=await one(env.DB,'SELECT id FROM user WHERE id=? AND campus_id=? AND role=? AND is_active=1',teacherId,campus,'teacher');ensure(t,'教师不属于该校区');}
 const name=requireVal(field(d,'name'),'班级名称',100),cap=intval(field(d,'capacity')||'0',0,300),deduct=intval(field(d,'deduct_lessons')||'1',1,8);ensure(cap!==null&&deduct!==null,'人数或每次消课设置不正确');const weekday=field(d,'weekday');ensure(/^周[一二三四五六日]$/.test(weekday),'上课星期错误');const start=field(d,'start_time'),end=field(d,'end_time');ensure(/^([01]\d|2[0-3]):[0-5]\d$/.test(start)&&/^([01]\d|2[0-3]):[0-5]\d$/.test(end)&&start<end,'上课时间不正确');
 const r=await run(env.DB,'INSERT INTO class_group(campus_id,course_id,name,teacher_id,weekday,start_time,end_time,room,capacity,deduct_lessons) VALUES(?,?,?,?,?,?,?,?,?,?)',campus,courseId,name,teacherId,weekday,start,end,field(d,'room').slice(0,50),cap,deduct);await run(env.DB,'INSERT INTO operation_log(user_id,target,target_id,action,detail) VALUES(?,?,?,?,?)',u.id,'class_group',r.meta.last_row_id,'create',name);return ok({redirect:'/classes'});}
export async function classUpdate(env,u,id,d){
 manager(u);
 const g=scoped(u,await one(env.DB,'SELECT * FROM class_group WHERE id=?',id));
 const courseId=intval(field(d,'course_id'),1);
 const course=await one(env.DB,'SELECT * FROM course WHERE id=? AND campus_id=?',courseId,g.campus_id);
 ensure(course,'课程必须属于当前校区');
 const teacherId=intval(field(d,'teacher_id'),1)||null;
 if(teacherId){const t=await one(env.DB,"SELECT id,is_active FROM user WHERE id=? AND campus_id=? AND role='teacher'",teacherId,g.campus_id);ensure(t&&(t.is_active||teacherId===g.teacher_id),'所选教师无效；旧任课教师如已停用，可保留但不可新分配');}
 const cap=intval(field(d,'capacity'),0,300),deduct=intval(field(d,'deduct_lessons'),1,8);
 ensure(cap!==null&&deduct!==null,'无效人数/课时');
 const wd=field(d,'weekday'),start=field(d,'start_time'),end=field(d,'end_time');
 ensure(/^周[一二三四五六日]$/.test(wd),'上课星期无效');
 ensure(/^([01]\d|2[0-3]):[0-5]\d$/.test(start)&&/^([01]\d|2[0-3]):[0-5]\d$/.test(end)&&start<end,'上下课时间不正确');
 const flag=field(d,'is_archived')==='1'?1:0;
 if(cap>0){const occupied=await one(env.DB,"SELECT (SELECT COUNT(*) FROM enrollment WHERE class_group_id=? AND status='active')+(SELECT COUNT(*) FROM registration WHERE class_group_id=? AND status='pending') AS n",id,id);ensure((occupied?.n||0)<=cap+(g.allow_override?g.override_extra:0),'新班额小于在班与待审批总人数，请先处理报名');}
 await batch(env.DB,[
  ['UPDATE class_group SET name=?,course_id=?,teacher_id=?,weekday=?,start_time=?,end_time=?,capacity=?,deduct_lessons=?,room=?,is_archived=? WHERE id=?',requireVal(field(d,'name'),'班级名称',100),courseId,teacherId,wd,start,end,cap,deduct,field(d,'room').slice(0,50),flag,id],
  logLine(u.id,'class_group',id,'update',`archived=${flag}; capacity=${cap}`)
 ]);
 return ok({redirect:'/classes'});
}
export async function expense(env,u,d){manager(u);const camp=campusId(u,d),amount=cents(field(d,'amount'));ensure(amount!==null&&amount>0,'金额无效');const nonce=field(d,'nonce');ensure(/^[a-zA-Z0-9-]{20,80}$/.test(nonce),'提交令牌已失效，请刷新');await batch(env.DB,[['INSERT INTO lesson_batch(nonce,operator_id) VALUES(?,?)','expense:'+nonce,u.id],['INSERT INTO campus_expense(campus_id,category,amount_cents,remarks,operator_id) VALUES(?,?,?,?,?)',camp,requireVal(field(d,'category'),'支出类别',30),amount,field(d,'remarks').slice(0,500),u.id],logLine(u.id,'campus_expense',null,'create',`amount=${amount}; campus=${camp}`)]);return ok({redirect:'/finance'});}
export async function campusCreate(env,u,d){superuser(u);const name=requireVal(field(d,'name'),'校区名称',100),code=requireVal(field(d,'code'),'校区编码',20);ensure(/^[A-Z0-9_-]+$/.test(code),'校区编码应为大写英文/数字');await run(env.DB,'INSERT INTO campus(name,code) VALUES(?,?)',name,code);return ok({redirect:'/campuses'});}
export async function campusRename(env,u,id,d){
 manager(u);
 ensure(u.role==='super_admin'||Number(u.campus_id)===Number(id),'无权更改其他校区名称',403);
 const campus=await one(env.DB,'SELECT * FROM campus WHERE id=?',id);
 ensure(campus,'校区不存在',404);
 ensure(campus.is_active===1,'已停用校区不能改名');
 const name=requireVal(field(d,'name'),'校区名称',100);
 ensure(!/[\x00-\x1f\x7f]/.test(name),'校区名称不能包含控制字符');
 const conflict=await one(env.DB,'SELECT id FROM campus WHERE lower(trim(name))=lower(?) AND id<>?',name,id);
 ensure(!conflict,'已有同名校区，请使用其他名称',409);
 if(name===campus.name)return ok({redirect:`/campuses?unchanged=${id}`});
 try{
  await batch(env.DB,[
   ['UPDATE campus SET name=? WHERE id=? AND name=?',name,id,campus.name],
   logLine(u.id,'campus',id,'rename',`from=${campus.name}; to=${name}; code=${campus.code}`)
  ]);
 }catch(ex){if(/UNIQUE|constraint/i.test(String(ex)))throw err('此名称已被其他校区使用，请刷新确认',409);throw ex;}
 return ok({redirect:`/campuses?updated=${id}`});
}
export async function shareUpdate(env,u,sid,d){manager(u);const s=await sidRecord(env,u,sid);const enabled=field(d,'enabled')==='1'?1:0,consent=field(d,'consent')==='1',publicName=field(d,'public_name').slice(0,64)||s.name;const existing=await one(env.DB,'SELECT * FROM student_share WHERE student_id=?',sid);if(enabled&&!existing?.approved_at&&!consent)throw err('首次开放家长页面必须确认已取得监护人授权');const token=field(d,'rotate')==='1'||!existing?randomToken(32):existing.token;const publishAll=enabled&&field(d,'publish_existing')==='1'&&consent;const actions=[['INSERT INTO student_share(student_id,token,enabled,public_name,approved_at) VALUES(?,?,?,?,?) ON CONFLICT(student_id) DO UPDATE SET token=excluded.token,enabled=excluded.enabled,public_name=excluded.public_name,approved_at=CASE WHEN excluded.enabled=1 AND student_share.approved_at IS NULL THEN excluded.approved_at ELSE student_share.approved_at END',sid,token,enabled,publicName,enabled?now():null],logLine(u.id,'student',sid,'share_settings',`enabled=${enabled}; rotated=${token!==existing?.token}`)];if(publishAll)actions.push(['UPDATE artwork SET is_public=1 WHERE student_id=? AND is_deleted=0',sid]);await batch(env.DB,actions);return ok({redirect:`/students/${sid}#share`});}
export function cleanWebp(bytes){if(bytes.length<20)return false;const len=bytes[4]|(bytes[5]<<8)|(bytes[6]<<16)|(bytes[7]<<24);if(len<12||len+8!==bytes.length)return false;let i=12,hasImage=false;while(i+8<=bytes.length){const tag=String.fromCharCode(...bytes.slice(i,i+4)),size=(bytes[i+4]|(bytes[i+5]<<8)|(bytes[i+6]<<16)|(bytes[i+7]<<24))>>>0;if(['EXIF','XMP '].includes(tag))return false;if(['VP8 ','VP8L','VP8X','ANIM','ANMF'].includes(tag))hasImage=true;i+=8+size+(size%2);if(i>bytes.length)return false;}return hasImage&&i===bytes.length;}
// Only browser-reencoded image data may be stored. For JPEG, reject all metadata
// application markers (other than the standard JFIF APP0 header), including EXIF,
// XMP, IPTC, ICC and Adobe segments. The client redraws into a canvas first.
export function cleanJpeg(bytes){
 if(bytes.length<100 || bytes[0]!==0xff || bytes[1]!==0xd8 || bytes.at(-2)!==0xff || bytes.at(-1)!==0xd9)return false;
 let pos=2,hasScan=false,hasJFIF=false;
 while(pos<bytes.length){
  if(bytes[pos]!==0xff){if(!hasScan)return false;pos++;continue;}
  while(bytes[pos]===0xff)pos++;
  if(pos>=bytes.length)return false;
  const marker=bytes[pos++];
  if(marker===0x00){if(!hasScan)return false;continue;}
  if(marker===0xd9)return hasScan&&pos===bytes.length;
  if(marker===0xd8)return false;
  if(marker>=0xd0&&marker<=0xd7){if(!hasScan)return false;continue;}
  if(marker===0x01)continue;
  if(pos+2>bytes.length)return false;
  const length=(bytes[pos]<<8)|bytes[pos+1];
  if(length<2||pos+length>bytes.length)return false;
  if(marker===0xfe)return false; // JPEG comments can carry private metadata.
  if(marker===0xe2){ // ICC color profile only; no EXIF/GPS metadata.
   const signature=String.fromCharCode(...bytes.slice(pos+2,pos+14));
   if(signature!=='ICC_PROFILE\0')return false;
  }else if(marker===0xee){ // Adobe color-transform marker; safe for display.
   if(String.fromCharCode(...bytes.slice(pos+2,pos+7))!=='Adobe')return false;
  }else if(marker>=0xe1&&marker<=0xef)return false;
  if(marker===0xe0){
   if(length<7||String.fromCharCode(...bytes.slice(pos+2,pos+7))!=='JFIF\0')return false;
   hasJFIF=true;
  }
  if(marker===0xda)hasScan=true;
  pos+=length;
 }
 return false;
}
// Validate JPEG structure and discard every application/comment segment before
// placing it in private R2. Camera/browser encoders differ in whether they emit
// JFIF, ICC, Adobe, EXIF, XMP and other APP segments. Rejecting those segments
// is too brittle on iOS; preserving them would leak metadata. Remove instead.
// This is a bounded marker parser, not a full image decoder. It requires an
// SOF image header, at least one SOS scan, proper segment bounds and final EOI.
export function stripJpegMetadata(bytes){
 if(!(bytes instanceof Uint8Array)||bytes.length<100||bytes.length>2*1024*1024||
    bytes[0]!==0xff||bytes[1]!==0xd8||bytes[bytes.length-2]!==0xff||bytes[bytes.length-1]!==0xd9)return null;
 let at=2,hasFrame=false,hasScan=false,removed=false;
 const segments=[bytes.subarray(0,2)];
 while(at<bytes.length){
  const start=at;
  if(bytes[at++]!==0xff)return null;
  while(at<bytes.length&&bytes[at]===0xff)at++;
  if(at>=bytes.length)return null;
  const mark=bytes[at++];
  if(mark===0xd9){
   if(!hasFrame||!hasScan||at!==bytes.length)return null;
   segments.push(bytes.subarray(start,at));
   if(!removed)return bytes;
   const size=segments.reduce((n,b)=>n+b.length,0),out=new Uint8Array(size);
   let offset=0;for(const part of segments){out.set(part,offset);offset+=part.length;}
   return out;
  }
  if(mark===0xd8||mark===0x00||mark===0x01||(mark>=0xd0&&mark<=0xd7))return null;
  if(at+2>bytes.length)return null;
  const size=(bytes[at]<<8)|bytes[at+1];
  if(size<2||at+size>bytes.length)return null;
  const end=at+size;
  if([0xc0,0xc1,0xc2].includes(mark)){
   if(size<11||bytes[at+2]!==8)return null;
   const h=(bytes[at+3]<<8)|bytes[at+4],w=(bytes[at+5]<<8)|bytes[at+6],n=bytes[at+7];
   if(!h||!w||h>12000||w>12000||h*w>40000000||![1,3].includes(n))return null;
   hasFrame=true;
  } else if(mark===0xda){
   if(!hasFrame||size<6)return null;
   hasScan=true;
  } else if(![0xc4,0xdb,0xdd,0xdc].includes(mark)&&!(mark>=0xe0&&mark<=0xef)&&mark!==0xfe){
   return null; // Unsupported coding mode or malformed marker.
  }
  at=end;
  if(mark===0xda){
   // A scan has entropy-coded data. 0xff 00 is a stuffed byte and
   // RST0..RST7 are in-scan restart markers. Other markers end the scan.
   for(;;){
    const ff=bytes.indexOf(0xff,at);
    if(ff<0||ff+1>=bytes.length)return null;
    let next=ff+1;while(next<bytes.length&&bytes[next]===0xff)next++;
    if(next>=bytes.length)return null;
    const code=bytes[next];
    if(code===0x00||(code>=0xd0&&code<=0xd7)){at=next+1;continue;}
    at=ff;break;
   }
   segments.push(bytes.subarray(start,at));
  }else if((mark>=0xe0&&mark<=0xef)||mark===0xfe){
   removed=true; // EXIF, GPS, XMP, ICC, Photoshop, JFIF and comments.
  }else segments.push(bytes.subarray(start,end));
 }
 return null;
}
// Callers MUST store the returned normalized bytes, not the original upload.
export function safeImageInfo(bytes){
 if(bytes.length<100||bytes.length>2*1024*1024)return null;
 if(bytes[0]===82&&bytes[1]===73&&bytes[2]===70&&bytes[3]===70&&
  String.fromCharCode(...bytes.slice(8,12))==='WEBP'&&cleanWebp(bytes))
  return {extension:'webp',contentType:'image/webp',bytes};
 const clean=stripJpegMetadata(bytes);
 if(clean)return {extension:'jpg',contentType:'image/jpeg',bytes:clean};
 return null;
}
export function contentTypeFromKey(key){return String(key).toLowerCase().endsWith('.jpg')?'image/jpeg':'image/webp';}
export async function artworkUpload(env,u,sid,data){const s=await canSeeStudent(env,u,sid,true);ensure(s.status!=='archived','已归档学员不能上传');const file=data.get('photo');ensure(file&&typeof file.arrayBuffer==='function'&&file.size>100&&file.size<=2*1024*1024,'请选择图片并在手机上完成压缩（最大 2MB）');const bytes=new Uint8Array(await file.arrayBuffer());const image=safeImageInfo(bytes);ensure(image,'图片格式无法解析，请重新选择照片；如果持续出现，请让管理员查看上传日志');
 const key=`${s.campus_id}/${sid}/${randomToken(16)}.${image.extension}`,title=field(data,'title').slice(0,100)||'课堂作品';const share=await one(env.DB,'SELECT enabled,approved_at FROM student_share WHERE student_id=?',sid);const autoPublic=share?.enabled&&share?.approved_at?1:0;const nonce=field(data,'upload_nonce');ensure(/^[a-zA-Z0-9-]{20,80}$/.test(nonce),'上传凭据无效，请刷新');const putStart=Date.now();
 await env.ARTWORKS.put(key,image.bytes,{httpMetadata:{contentType:image.contentType,cacheControl:'private, no-store'}});
 const r2Ms=Date.now()-putStart,dbStart=Date.now();
 try{await batch(env.DB,[['INSERT INTO lesson_batch(nonce,operator_id) VALUES(?,?)','art:'+nonce,u.id],['INSERT INTO artwork(student_id,campus_id,uploader_id,image_key,title,note,is_public,is_deleted) VALUES(?,?,?,?,?,?,?,0)',sid,s.campus_id,u.id,key,title,field(data,'note').slice(0,300),autoPublic]]);}catch(ex){await env.ARTWORKS.delete(key);if(/UNIQUE|constraint/i.test(String(ex)))throw err('这张照片已提交，请刷新查看作品');throw ex;}
 const d1Ms=Date.now()-dbStart;
 // Timing covers binding calls only, not the mobile network transfer or multipart parsing.
 console.info('artwork_upload_timings',{bytes_in:bytes.length,bytes_saved:image.bytes.length,format:image.extension,r2_ms:r2Ms,d1_ms:d1Ms});
 return ok({redirect:`/students/${sid}#artworks`,upload_metrics:{bytes:image.bytes.length,r2_ms:r2Ms,d1_ms:d1Ms}});}
export async function artworkAction(env,u,id,d){const a=await one(env.DB,'SELECT * FROM artwork WHERE id=? AND is_deleted=0',id);scoped(u,a);await canSeeStudent(env,u,a.student_id,true);const op=field(d,'op');if(op==='publish'){manager(u);await run(env.DB,'UPDATE artwork SET is_public=? WHERE id=?',field(d,'is_public')==='1'?1:0,id);return ok({redirect:`/students/${a.student_id}#artworks`});}
 if(op==='delete'){if(u.role==='teacher'){const utc=Date.parse(String(a.created_at).replace(' ','T')+'Z');ensure(a.uploader_id===u.id&&Date.now()-utc<10*60*1000,'教师仅可删除本人 10 分钟内的误传作品');}await run(env.DB,'UPDATE artwork SET is_deleted=1,is_public=0 WHERE id=?',id);await env.ARTWORKS.delete(a.image_key);return ok({redirect:`/students/${a.student_id}#artworks`});}throw err('无效操作');}
export async function setUser(env,u,id,d){manager(u);const target=scoped(u,await one(env.DB,'SELECT * FROM user WHERE id=?',id));if(target.role==='super_admin')throw err('无法修改系统管理员');const op=field(d,'op');if(u.role==='manager'&&target.role!=='teacher')throw err('校区管理员只能管理教师账号',403);if(op==='toggle'){ensure(target.id!==u.id,'不能停用自己');await batch(env.DB,[['UPDATE user SET is_active=? WHERE id=?',target.is_active?0:1,id],['DELETE FROM session WHERE user_id=?',id],logLine(u.id,'user',id,'toggle',`active=${!target.is_active}`)]);}else if(op==='reset'){const pw=field(d,'password'),hash=await hashPassword(pw);await batch(env.DB,[['UPDATE user SET password_hash=? WHERE id=?',hash,id],['DELETE FROM session WHERE user_id=?',id],logLine(u.id,'user',id,'password_reset')]);}else if(op==='role'){superuser(u);const role=field(d,'role');ensure(['teacher','manager'].includes(role),'角色只能为教师或校区管理员');ensure(target.campus_id,'角色对应的校区不能为空');await batch(env.DB,[['UPDATE user SET role=? WHERE id=?',role,id],['DELETE FROM session WHERE user_id=?',id],logLine(u.id,'user',id,'role_change',role)]);}else throw err('无效操作');return ok({redirect:'/users'});}
export async function entryCreate(env,u,d){manager(u);const campus=campusId(u,d),name=requireVal(field(d,'name'),'报名入口名称',100);await run(env.DB,'INSERT INTO registration_entry(campus_id,name,token,enabled,deadline,contact,created_by) VALUES(?,?,?,1,?,?,?)',campus,name,randomToken(16),field(d,'deadline')||null,field(d,'contact').slice(0,500),u.id);return ok({redirect:'/entries'});}
export async function entryToggle(env,u,id,d){manager(u);const entry=scoped(u,await one(env.DB,'SELECT * FROM registration_entry WHERE id=?',id));await run(env.DB,'UPDATE registration_entry SET enabled=? WHERE id=?',entry.enabled?0:1,id);return ok({redirect:'/entries'});}
export async function registrationSubmit(env,entry,d,req){const ip=ipHash((req?.headers.get('CF-Connecting-IP')||'anonymous')+':registration-new',env.IP_HASH_SECRET),bucket=Math.floor(Date.now()/60000);const rate=await one(env.DB,'SELECT fails FROM login_attempt WHERE ip_hash=? AND bucket=?',ip,bucket);ensure((rate?.fails||0)<10,'报名操作过于频繁，请一分钟后重试',429);await run(env.DB,`INSERT INTO login_attempt(ip_hash,bucket,fails,kind) VALUES(?,?,1,'public') ON CONFLICT(ip_hash,bucket) DO UPDATE SET fails=fails+1`,ip,bucket);const gid=intval(field(d,'class_group_id'),1),g=await cgCampus(env,entry.campus_id,gid),name=requireVal(field(d,'student_name'),'学生姓名',50),phone=requireVal(field(d,'guardian_phone'),'联系方式',20);const last4=phone.slice(-4);ensure(last4.length===4,'请填写至少 4 位手机号');
 const occupied=await one(env.DB,"SELECT (SELECT COUNT(*) FROM enrollment WHERE class_group_id=? AND status='active')+(SELECT COUNT(*) FROM registration WHERE class_group_id=? AND status='pending') AS n",gid,gid);ensure(!g.capacity||occupied.n<g.capacity+(g.allow_override?g.override_extra:0),'班级人数已满');const code=String(Math.floor(100000+crypto.getRandomValues(new Uint32Array(1))[0]%900000));const codeHash=await hashPassword('modify:'+code);const cancelled=await one(env.DB,`SELECT id FROM registration WHERE entry_id=? AND student_name=? AND grade=? AND phone_last4=? AND status='cancelled'`,entry.id,name,field(d,'grade').slice(0,50),last4);if(cancelled){
 const restored=await run(env.DB,`UPDATE registration SET status='pending',class_group_id=?,guardian_name=?,guardian_phone=?,note=?,modify_uses=0,modify_code_hash=?,updated_at=? WHERE id=? AND status='cancelled' AND (SELECT CASE WHEN capacity=0 THEN 1 WHEN (SELECT COUNT(*) FROM enrollment WHERE class_group_id=? AND status='active')+(SELECT COUNT(*) FROM registration WHERE class_group_id=? AND status='pending')<capacity+(CASE WHEN allow_override=1 THEN override_extra ELSE 0 END) THEN 1 ELSE 0 END FROM class_group WHERE id=?)=1`,gid,field(d,'guardian_name').slice(0,50),phone,field(d,'note').slice(0,300),codeHash,now(),cancelled.id,gid,gid,gid);
 ensure(restored.meta.changes===1,'班级已满，不能重新报名');
 await run(env.DB,'INSERT INTO registration_history(registration_id,action,to_class_group_id,note) VALUES(?,?,?,?)',cancelled.id,'reapplied',gid,'家长重新报名');
 return ok({code,student_name:name,group_name:g.name});
 }const submitted=await run(env.DB,`INSERT INTO registration(entry_id,campus_id,class_group_id,student_name,grade,guardian_name,guardian_phone,phone_last4,status,note,modify_code_hash) SELECT ?,?,?,?,?,?,?,?,'pending',?,? WHERE (SELECT CASE WHEN capacity=0 THEN 1 WHEN (SELECT COUNT(*) FROM enrollment WHERE class_group_id=? AND status='active')+(SELECT COUNT(*) FROM registration WHERE class_group_id=? AND status='pending') < capacity+(CASE WHEN allow_override=1 THEN override_extra ELSE 0 END) THEN 1 ELSE 0 END FROM class_group WHERE id=?)=1`,entry.id,entry.campus_id,gid,name,field(d,'grade').slice(0,50),field(d,'guardian_name').slice(0,50),phone,last4,field(d,'note').slice(0,300),codeHash,gid,gid,gid);ensure(submitted.meta.changes===1,'该班已满或提交失败');return ok({code,student_name:name,group_name:g.name});}
export async function registrationReview(env,u,id,d){
 manager(u);const r=scoped(u,await one(env.DB,'SELECT * FROM registration WHERE id=?',id));ensure(r.status==='pending','只可处理待确认报名');const status=field(d,'status');ensure(['confirmed','cancelled'].includes(status),'状态不正确');let ops=[['INSERT INTO lesson_batch(nonce,class_group_id,operator_id) VALUES(?,?,?)','registration:'+id,r.class_group_id,u.id]];
 if(status==='confirmed'){
  const g=await cgCampus(env,r.campus_id,r.class_group_id);
  // Older registrations with only phone_last4 must not be merged with an unrelated student.
  let st=null;const linkId=intval(field(d,'existing_student_id'),1);if(linkId){st=await one(env.DB,"SELECT id FROM student WHERE id=? AND campus_id=? AND status!='archived'",linkId,r.campus_id);ensure(st,'关联学员不存在或跨校区');}
  if(!st){
   ops.push(['INSERT INTO student(campus_id,name,phone,parent_name,grade,source,registration_id) VALUES(?,?,?,?,?,?,?)',r.campus_id,r.student_name,r.guardian_phone||r.phone_last4,r.guardian_name,r.grade,'registration',id]);
   ops.push(['INSERT INTO enrollment(campus_id,student_id,class_group_id,status) VALUES(?,last_insert_rowid(),?,?)',r.campus_id,g.id,'active']);
  }else{
   const e=await one(env.DB,'SELECT * FROM enrollment WHERE student_id=? AND class_group_id=?',st.id,g.id);
   if(!e)ops.push(['INSERT INTO enrollment(campus_id,student_id,class_group_id,status) VALUES(?,?,?,?)',r.campus_id,st.id,g.id,'active']);
   else if(e.status!=='active')ops.push(["UPDATE enrollment SET status='active',left_at=NULL WHERE id=?",e.id]);
  }
 }
 ops.push(['UPDATE registration SET status=?,updated_at=? WHERE id=? AND status=\'pending\'',status,now(),id]);
 ops.push(['INSERT INTO registration_history(registration_id,action,from_class_group_id,to_class_group_id,note) VALUES(?,?,?,?,?)',id,status,r.class_group_id,r.class_group_id,field(d,'note').slice(0,300)]);
 ops.push(logLine(u.id,'registration',id,status));try{await batch(env.DB,ops);}catch(ex){if(/CLASS_FULL/i.test(String(ex)))throw err('班级已满，无法确认报名');if(/UNIQUE|constraint/i.test(String(ex)))throw err('该报名已经处理过');throw ex;}return ok({redirect:'/registrations'});
}
export async function registrationModify(env,req,entry,d){
 const action=field(d,'action'),ip=ipHash((req.headers.get('CF-Connecting-IP')||'unknown')+':registration-edit',env.IP_HASH_SECRET),minute=Math.floor(Date.now()/60000);
 const current=await one(env.DB,'SELECT fails FROM login_attempt WHERE ip_hash=? AND bucket=?',ip,minute);if((current?.fails||0)>=5)throw err('修改过于频繁，请一分钟后再试',429);
 await run(env.DB,`INSERT INTO login_attempt(ip_hash,bucket,fails,kind) VALUES(?,?,1,'public') ON CONFLICT(ip_hash,bucket) DO UPDATE SET fails=fails+1`,ip,minute);
 ensure(action==='change','操作错误');const name=requireVal(field(d,'student_name'),'学生姓名',50),last4=field(d,'phone_last4'),code=field(d,'code');ensure(/^\d{4}$/.test(last4)&&/^\d{6}$/.test(code),'尾号或修改码格式不正确');
 const r=await one(env.DB,'SELECT * FROM registration WHERE entry_id=? AND student_name=? AND phone_last4=? ORDER BY id DESC LIMIT 1',entry.id,name,last4);
 ensure(r&&r.status==='pending','未找到可修改的待确认报名');ensure(r.modify_uses<3,'最多修改 3 次，请联系老师');ensure((await verifyPassword(code,r.modify_code_hash))||(await verifyPassword('modify:'+code,r.modify_code_hash)),'修改码错误');const gid=intval(field(d,'class_group_id'),1),g=await cgCampus(env,entry.campus_id,gid);ensure(g.id!==r.class_group_id,'目标班级未改变');
 try{await batch(env.DB,[['UPDATE registration SET class_group_id=?,modify_uses=modify_uses+1,updated_at=? WHERE id=? AND status=\'pending\' AND modify_uses<3',gid,now(),r.id],['INSERT INTO registration_history(registration_id,action,from_class_group_id,to_class_group_id,note) VALUES(?,?,?,?,?)',r.id,'modified',r.class_group_id,gid,'家长使用修改码调整班级']]);}catch(ex){if(/REGISTRATION_FULL|CLASS_FULL/i.test(String(ex)))throw err('该班名额已满');throw ex;}
 return ok({redirect:`/r/${entry.token}?modified=1`});
}
export async function publicLike(env,req,token,id){const url=new URL(req.url),origin=req.headers.get('origin');if(origin&&origin!==url.origin)throw err('请求来源不正确',403);
 const a=await one(env.DB,`SELECT a.id,a.likes_count FROM artwork a JOIN student_share sh ON sh.student_id=a.student_id WHERE a.id=? AND a.is_deleted=0 AND a.is_public=1 AND sh.token=? AND sh.enabled=1`,id,token);ensure(a,'作品不可访问',404);
 const ip=req.headers.get('CF-Connecting-IP')||'anonymous',key=ipHash(ip,env.IP_HASH_SECRET),ts=Math.floor(Date.now()/1000);
 const liked=await one(env.DB,`INSERT INTO artwork_like(artwork_id,ip_hash,last_at,count) VALUES(?,?,?,1) ON CONFLICT(artwork_id,ip_hash) DO UPDATE SET last_at=excluded.last_at,count=count+1 WHERE artwork_like.last_at<=excluded.last_at-86400 RETURNING count`,id,key,ts);
 if(!liked)throw err('同一网络每 24 小时只能为这张作品点赞一次',429);
 const fresh=await one(env.DB,'SELECT likes_count FROM artwork WHERE id=?',id);return ok({likes:fresh.likes_count});}
