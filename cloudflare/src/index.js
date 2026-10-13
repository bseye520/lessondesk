import {all,one,run,batch,html,jres,redirect,err,body,field,intval,money,enc as e,attr as a,randomToken,today,weekday,back,acceptsJson} from './lib.js';
import {layout,publicLayout,authPage,section,card,csrf,form,btn,input,select,area,roster,table,numberCard,link,message} from './ui.js';
import {currentUser,requireUser,manager,superuser,scoped,canSeeStudent,canManageGroup,login,logout,bootstrap,issueSession,sessionCookie,cookieName,checkCsrf,makeUser,changePassword} from './auth.js';
import * as work from './workflows.js';
import * as media from './media.js';

const match=(pathname,regex)=>pathname.match(regex);
const go=(res)=>{const to=new URL(res.redirect||'/', 'https://app.internal');if(to.pathname.startsWith('/api/'))return redirect('/');if(!to.searchParams.has('saved'))to.searchParams.set('saved','1');return redirect(to.pathname+to.search+to.hash);};
const R=(req,env)=>new URL(req.url);
const scope=(u,alias='')=>u.role==='super_admin'?['',[]]:[` AND ${alias?alias+'.':''}campus_id=?`,[u.campus_id]];
const ui=(env,u,title,contents,nav)=>html(layout(u,title,contents,nav||'/',env.SITE_NAME||'课时本'));
const reqCampus=(u,url)=>u.role==='super_admin'?(intval(url.searchParams.get('campus_id'),1)||null):u.campus_id;
const isManager=(u)=>u.role!=='teacher';
function capname(x){return x==='active'?'在册':x==='trial'?'试听':'已归档';}
function statGrid(items){return `<div class="row g-3 my-3">${items.map(([l,v])=>`<div class="col-6 col-md-3">${numberCard(l,v)}</div>`).join('')}</div>`;}
const linkOr=(req,path)=>new URL(path,req.url).href;
// A trailing slash is a harmless URL variant. Route internally: POST must NEVER be redirected
// (a retry could repeat a financial write). Preserve root and the query string.
export function normalizeRoute(path){return path==='/'?'/':path.replace(/\/+$/,'')||'/';}

async function getGroups(env,u,campus=null,teacherOnly=true){let filter='g.is_archived=0',args=[];if(campus){filter+=' AND g.campus_id=?';args.push(campus);}if(u.role==='teacher'&&teacherOnly){filter+=' AND g.teacher_id=?';args.push(u.id);}return all(env.DB,`SELECT g.*,c.name AS course_name,t.username AS teacher_name FROM class_group g LEFT JOIN course c ON c.id=g.course_id LEFT JOIN user t ON t.id=g.teacher_id WHERE ${filter} ORDER BY CASE WHEN g.weekday=? THEN 0 ELSE 1 END, g.weekday,g.start_time,g.name`,...args,weekday(env.TZ));}
async function getStudentsForGroups(env,groups){if(!groups.length)return [];const ids=groups.map(x=>x.id);return all(env.DB,`SELECT s.*,e.class_group_id FROM enrollment e JOIN student s ON s.id=e.student_id WHERE e.status='active' AND s.status!='archived' AND e.class_group_id IN (${ids.map(()=>'?').join(',')}) ORDER BY s.name,s.id`,...ids);}
async function recentRecord(env,u,limit=40,studentId=null){let w=' WHERE 1=1 ',args=[];if(u.role==='teacher'){w+=' AND r.teacher_id=?';args.push(u.id)}else if(u.role==='manager'){w+=' AND r.campus_id=?';args.push(u.campus_id)}if(studentId){w+=' AND r.student_id=?';args.push(studentId)}return all(env.DB,`SELECT r.*,COALESCE(r.lesson_date,date(r.date,'+8 hours')) AS display_date, r.actor_id AS operator_id,s.name AS student_name,g.name AS group_name,q.lesson_record_id AS quick_id FROM lesson_record r JOIN student s ON s.id=r.student_id JOIN class_group g ON g.id=r.class_group_id LEFT JOIN quick_deduct q ON q.lesson_record_id=r.id ${w} ORDER BY r.date DESC,r.id DESC LIMIT ?`,...args,limit);}
function columnChart(rows,{label='课时',moneyAxis=false}={}){
 const points=rows.map(r=>({name:String(r.label),value:Math.max(0,Number(r.value)||0)}));
 const max=Math.max(1,...points.map(r=>r.value));
 return `<div class="ld-chart" role="img" aria-label="${e(label)}柱状图">${points.map(p=>`<div class="ld-chart-item" title="${a(p.name)} ${p.value}"><span class="ld-chart-value">${moneyAxis?money(p.value):p.value}</span><div class="ld-chart-column"><span style="height:${Math.max(3,Math.round(p.value/max*100))}%"></span></div><small>${e(p.name)}</small></div>`).join('')||'<p class="ld-muted">暂无统计数据</p>'}</div>`;
}
function incomeExpenseChart(incomes,expenses){
 const months=[...new Set([...incomes.map(r=>r.label),...expenses.map(r=>r.label)])].sort().slice(-6);
 const ins=new Map(incomes.map(r=>[r.label,Number(r.value)||0])),outs=new Map(expenses.map(r=>[r.label,Number(r.value)||0]));
 const max=Math.max(1,...months.flatMap(m=>[ins.get(m)||0,outs.get(m)||0]));
 return `<div class="ld-chart-legend"><span class="ld-chart-dot income"></span>实收 <span class="ld-chart-dot expense"></span>支出</div><div class="ld-chart">${months.map(m=>`<div class="ld-chart-item"><div class="ld-chart-pair"><span class="income" title="实收 ${money(ins.get(m)||0)}" style="height:${Math.max(2,(ins.get(m)||0)/max*100)}%"></span><span class="expense" title="支出 ${money(outs.get(m)||0)}" style="height:${Math.max(2,(outs.get(m)||0)/max*100)}%"></span></div><small>${e(m)}</small></div>`).join('')}</div>`;
}
function expensePie(rows){
 const vals=rows.filter(r=>Number(r.value)>0),total=vals.reduce((s,r)=>s+Number(r.value),0);
 if(!total)return '<p class="ld-muted">暂无支出分类数据</p>';
 const colors=['#ae3440','#d48f6e','#e5c6a1','#889990','#a4a1b1','#c5aaab'];let acc=0;
 const arc=vals.slice(0,6).map((r,i)=>{const start=acc;acc+=Number(r.value)/total*100;return `${colors[i]} ${start.toFixed(2)}% ${acc.toFixed(2)}%`}).join(',');
 return `<div class="ld-pie-layout"><div class="ld-donut" style="background:conic-gradient(${arc})" aria-label="支出总额 ${money(total)}"></div><div class="ld-pie-legend">${vals.slice(0,6).map((r,i)=>`<div><span style="background:${colors[i]}"></span>${e(r.label)} <b>${(Number(r.value)/total*100).toFixed(1)}%</b></div>`).join('')}</div></div>`;
}
async function dashboard(env,u,url){
 const campus=reqCampus(u,url),groups=await getGroups(env,u,campus),ids=groups.map(g=>g.id);
 const [students,spent,done,recent,pending,daily]=await Promise.all([
  getStudentsForGroups(env,groups),
  ids.length?all(env.DB,`SELECT class_group_id,student_id,SUM(deducted_lessons) AS used FROM lesson_record WHERE revoked_at IS NULL AND class_group_id IN (${ids.map(()=>'?').join(',')}) GROUP BY class_group_id,student_id`,...ids):Promise.resolve([]),
  ids.length?all(env.DB,`SELECT class_group_id,student_id FROM quick_deduct WHERE local_day=? AND class_group_id IN (${ids.map(()=>'?').join(',')})`,today(env.TZ),...ids):Promise.resolve([]),
  recentRecord(env,u,15),
  u.role==='teacher'?Promise.resolve({n:0}):one(env.DB,`SELECT COUNT(*) AS n FROM registration WHERE status='pending' ${u.role==='super_admin'?'':'AND campus_id=?'}`,...(u.role==='super_admin'?[]:[u.campus_id])),
  u.role==='teacher'?Promise.resolve([]):all(env.DB,`SELECT lesson_date AS label,SUM(deducted_lessons) AS value FROM lesson_record WHERE revoked_at IS NULL AND lesson_date>=? ${u.role==='super_admin'?'':'AND campus_id=?'} GROUP BY lesson_date ORDER BY lesson_date`,new Intl.DateTimeFormat('sv-SE',{timeZone:env.TZ||'Asia/Shanghai'}).format(new Date(Date.now()-6*86400000)),...(u.role==='super_admin'?[]:[u.campus_id]))
 ]);
 const headline=u.role==='teacher'?'我的课':'教务概览';const enrollmentCount=new Set(students.map(s=>s.id)).size;
 const todaySum=u.role==='teacher'?0:daily.filter(x=>x.label===today(env.TZ)).reduce((n,x)=>n+Number(x.value),0);
 let content=section(headline,`${weekday(env.TZ)} · ${today(env.TZ)} · 展开班级后直接点右侧消课；点姓名查看其他操作`);
 content+=u.role!=='teacher'?statGrid([['在班学员',enrollmentCount],['当前班级',groups.length],['今日有效消课',todaySum],['待办报名',pending?.n||0]]):'';
 content+=u.role==='teacher'?'':`<details class="ld-collapse ld-stats-collapse"><summary>近 7 天有效消课趋势</summary>${card('按实际授课日期统计',columnChart(daily,{label:'每日消课'}))}</details>`;
 content+=roster(groups,students,spent,u,env.TZ,done);
 content+=`<details class="ld-collapse"><summary>最近消课记录 · ${recent.length} 条</summary>`+card('操作记录',table(['日期','班级','学员','课时','操作'],recent.map(r=>[e(r.display_date||''),e(r.group_name),e(r.student_name),r.revoked_at?'<span class="st-badge">已撤销</span>':`- ${r.deducted_lessons}`,r.quick_id&&!r.revoked_at&&(isManager(u)||r.operator_id===u.id)?form(`/api/undo/${r.id}`,u,(isManager(u)?'<input name="reason" class="form-control form-control-sm" maxlength="200" placeholder="撤销原因" required>':'')+'<button class="btn btn-sm btn-outline-secondary">撤销</button>'):'—'])))+`</details>`;
 return ui(env,u,headline,content,'/');}
async function studentsList(env,u,url){const campus=reqCampus(u,url),kw=(url.searchParams.get('q')||'').slice(0,50),status=url.searchParams.get('status')||'active';let args=[],where=' WHERE 1=1 ';if(campus){where+=' AND s.campus_id=?';args.push(campus);}if(status!=='all'){where+=' AND s.status != ?';args.push('archived');}if(kw){where+=' AND (s.name LIKE ? OR s.phone LIKE ? OR s.parent_name LIKE ?)';args.push(...Array(3).fill(`%${kw}%`));}if(u.role==='teacher'){where+=' AND EXISTS (SELECT 1 FROM enrollment e JOIN class_group g ON g.id=e.class_group_id WHERE e.student_id=s.id AND e.status=\'active\' AND g.teacher_id=? AND g.is_archived=0)';args.push(u.id)}
 const _isM=isManager(u);
 const _pCampuses=_isM?all(env.DB,'SELECT * FROM campus WHERE is_active=1 ORDER BY id'):Promise.resolve([]);
 const _pGroups=_isM?getGroups(env,u,campus):Promise.resolve([]);
 const students=await all(env.DB,`SELECT s.*,c.name AS campus_name FROM student s JOIN campus c ON c.id=s.campus_id ${where} ORDER BY s.status,s.name LIMIT 300`,...args);
 let c=section('学员管理','姓名、家长、余额及作品档案');c+=`<form method="get" class="ld-actions mb-3"><input class="form-control" style="max-width:280px" name="q" placeholder="搜索姓名或手机号" value="${a(kw)}"><button class="btn btn-soft">搜索</button><a class="btn btn-outline-secondary" href="/students?status=${status==='all'?'active':'all'}">${status==='all'?'只看在册':'含归档'}</a></form>`;
 if(_isM){const [campuses,gs]=await Promise.all([_pCampuses,_pGroups]);const choices=campuses.filter(c=>u.role==='super_admin'||c.id===u.campus_id);
 c+=card('新建学员',form('/api/students',u,`<div class="ld-form-grid">${select('campus_id','校区',choices.map(x=>[x.id,x.name]),u.campus_id||choices[0]?.id)}${input('name','学员姓名','','text',true)}${input('phone','家长电话（可重复）')}${input('parent_name','家长姓名')}${input('grade','年级')}${select('class_group_id','加入班级（可不选）',[['','暂不入班'],...gs.map(g=>[g.id,g.name])])}</div><div class="mt-2">${btn('创建学员')}</div>`));}
 c+=`<div class="row g-3">${students.map(s=>`<div class="col-12 col-sm-6 col-xl-4"><div class="card-ld h-100"><div class="card-b"><div class="ld-actions justify-content-between"><b>${e(s.name)}</b><span class="st-badge">${capname(s.status)}</span></div><div class="ld-muted">${e(s.grade||s.campus_name)}${isManager(u)?' · '+e(s.phone):''}</div><p class="mt-2">剩余课时 <b style="font-size:24px;color:#ae3440">${s.lessons_remaining}</b> 节</p><a class="btn btn-soft btn-sm" href="/students/${s.id}">查看档案 / 作品 →</a></div></div></div>`).join('')||'<p class="ld-muted">暂无匹配学员</p>'}</div>`;
 return ui(env,u,'学员管理',c,'/students');}
async function studentDetail(env,u,id,req){
 const s=await canSeeStudent(env,u,id),isMgr=isManager(u);
 const [gs,available,payments,rec,works,sh]=await Promise.all([
   all(env.DB,`SELECT g.*,e.status AS enroll_status FROM enrollment e JOIN class_group g ON g.id=e.class_group_id WHERE e.student_id=? AND ${isMgr?'1=1':'g.teacher_id=?'} ORDER BY e.status,g.name`,...(isMgr?[id]:[id,u.id])),
   isMgr?getGroups(env,u,s.campus_id):Promise.resolve([]),
   isMgr?all(env.DB,'SELECT p.*,u.username AS operator FROM payment_record p LEFT JOIN user u ON u.id=p.operator_id WHERE p.student_id=? ORDER BY p.id DESC LIMIT 80',id):Promise.resolve([]),
   recentRecord(env,u,60,id),
   all(env.DB,'SELECT * FROM artwork WHERE student_id=? AND is_deleted=0 ORDER BY created_at DESC LIMIT 160',id),
   isMgr?one(env.DB,'SELECT * FROM student_share WHERE student_id=?',id):Promise.resolve(null)
 ]);
 const active=gs.filter(x=>x.enroll_status==='active');
 let h=section(s.name,`学员档案 · ${e(s.grade||'未填年级')} · ${active.map(g=>g.name).join('、')||'未入班'}`);
 h+=`<div class="ld-detail-stats">${numberCard('剩余总课时',String(s.lessons_remaining))}${numberCard('当前班级数',String(active.length))}${numberCard('已上传作品',String(works.length))}</div>`;
 h+=card('课堂快捷操作',`<div class="ld-actions mb-2"><a class="btn btn-soft" href="/students/${id}/upload">📷 拍摄并上传作品</a></div>`+form(`/api/students/${id}/manual`,u,`<p class="ld-muted mb-2">用于同一天上多节课、补记历史等特殊情况。普通上课请在班级卡片点“消 1 节”。</p><div class="ld-form-grid">${select('class_group_id','上课班级',active.map(x=>[x.id,x.name]))}${input('count','本次消课节数','1','number',true)}${input('lesson_date','实际授课日期',today(env.TZ),'date',true)}${input('reason','操作原因（必填）','','text',true)}</div><input type="hidden" name="nonce" value="${randomToken(20)}"><div class="mt-2">${btn('确认补记','btn-outline-primary')}</div>`));
 h+=`<details class="ld-collapse"><summary>班级关系 · ${active.length} 个在班</summary>`+card('班级关系',`<div class="ld-actions">${gs.map(g=>`<span class="roster-utility-button">${e(g.name)}（${g.enroll_status==='active'?'在班':'已退班'}）${isMgr&&g.enroll_status==='active'?form(`/api/students/${id}/leave/${g.id}`,u,'<button class="btn btn-sm btn-outline-secondary">退班</button>','ld-inline'):''}</span>`).join('')||'暂无班级'}</div>`+(isMgr?form(`/api/students/${id}/enroll`,u,`<div class="ld-actions mt-3">${select('class_group_id','加入或恢复班级',available.map(g=>[g.id,g.name]))}${btn('加入班级','btn-outline-primary')}</div>`):''))+`</details>`;
 if(isMgr){
 // Do NOT share the same form for charge and correction. An operator must never
 // enter delta=12 while type=charge silently ignores it (V6 incident).
 const adjustBody=`<input type="hidden" name="type" value="adjust"><input type="hidden" name="nonce" value="${randomToken(20)}"><div class="ld-form-grid"><label class="form-label d-block">增减课时（正数增加，负数扣减）<input class="form-control" name="delta" type="number" step="1" min="-10000" max="10000" placeholder="例如 12 或 -2" required></label><label class="form-label d-block">调整原因（必填）<input class="form-control" name="remarks" maxlength="300" placeholder="例如：补录原有课时" required></label></div><p class="ld-muted ld-balance-preview" data-original="${s.lessons_remaining}" role="status">当前余额 ${s.lessons_remaining} 节 · 输入调整值后显示预计余额</p>${btn('确认调整余额')}`;
 const chargeBody=`<input type="hidden" name="type" value="charge"><input type="hidden" name="nonce" value="${randomToken(20)}"><div class="ld-form-grid"><label class="form-label d-block">购买课时<input class="form-control" name="lessons" type="number" min="0" max="10000" step="1" value="0" required></label><label class="form-label d-block">赠送课时<input class="form-control" name="bonus" type="number" min="0" max="10000" step="1" value="0" required></label><label class="form-label d-block">实收金额（元）<input class="form-control" name="amount" type="number" min="0" step="0.01" value="0" required></label><label class="form-label d-block">收费备注（选填）<input class="form-control" name="remarks" maxlength="300" placeholder="例如：秋季课程续费"></label></div><p class="ld-muted">购买课时 + 赠送课时必须大于 0；金额只用于登记，不会自动收款。</p>${btn('登记交费并增加课时')}`;
 h+=`<div id="lessons"></div>`+
 `<details class="ld-collapse" id="adjust"><summary>人工调整余额 · 补录 / 纠错</summary>`+card('人工调整余额',form(`/api/students/${id}/payment`,u,adjustBody,'js-balance-form'))+`</details>`+
 `<details class="ld-collapse"><summary>交费登记 · 续费 / 赠课</summary>`+card('交费登记',form(`/api/students/${id}/payment`,u,chargeBody,'js-balance-form'))+`</details>`+
 `<details class="ld-collapse"><summary>退费登记</summary>`+card('退款 / 扣回课时',form(`/api/students/${id}/refund`,u,`<input type="hidden" name="nonce" value="${randomToken(20)}"><div class="ld-form-grid">${input('amount','退回金额（元）','0','number',true)}${input('lessons','扣回课时（可为 0）','0','number',true)}${input('reason','退款原因','','text',true)}</div><p class="ld-muted">仅记录实际发生的退款，不会触发线上转账；扣回课时不能超过剩余余额。</p>${btn('登记退款')}`))+`</details>`;
 h+=`<details class="ld-collapse"><summary>编辑学员资料</summary>`+card('编辑学员',form(`/api/students/${id}/edit`,u,`<div class="ld-form-grid">${input('name','姓名',s.name,'text',true)}${input('phone','家长电话',s.phone)}${input('parent_name','家长姓名',s.parent_name)}${input('grade','年级',s.grade)}${select('gender','性别',[['','未填'],['男','男'],['女','女']],s.gender)}${select('status','状态',[['active','在册'],['trial','试听'],['archived','归档（会自动退班）']],s.status)}</div>${area('remarks','内部备注',s.remarks)}${btn('保存学员信息')}`))+`</details>`;
 h+=`<details class="ld-collapse" id="share"><summary>家长分享 · ${sh?.enabled?'已公开':'未公开'}</summary>`+card('家长专属页面',`${message('链接可被持有人转发；必须先征得监护人同意。关停或轮换后旧链接立即失效。','warning')}${sh?.enabled?`<div class="ld-actions mb-3"><input id="share-url" class="form-control" readonly value="${a(linkOr(req,`/p/${sh.token}`))}"><button id="copy-share" class="btn btn-outline-primary" type="button">复制分享地址</button></div>`:'<p class="ld-muted">当前未公开</p>'}`+form(`/api/students/${id}/share`,u,`${input('public_name','家长页显示昵称',sh?.public_name||s.name)}${select('enabled','公开状态',[['0','关闭公开'],['1','开启公开']],sh?.enabled?'1':'0')}<label class="form-check mt-2"><input class="form-check-input" type="checkbox" name="consent" value="1">首次公开：我确认已取得监护人的授权</label><label class="form-check mt-2"><input class="form-check-input" type="checkbox" name="rotate" value="1">更换分享链接（旧链接失效）</label><div class="mt-2"><label class="form-check"><input class="form-check-input" type="checkbox" name="publish_existing" value="1">确认同意后同步公开此前作品（需再次勾选授权）</label>${btn('保存公开设置')}</div>`))+`</details>`;}
 h+=`<div id="artworks"></div>`+card('作品记录',`<div class="ld-actions mb-3"><a class="btn btn-soft" href="/students/${id}/upload">📷 新增作品</a></div><div class="ld-art-grid">${works.map(w=>`<div class="ld-art-card"><img src="/media/${w.id}" loading="lazy" alt="${a(w.title)}"><div class="p-2"><b>${e(w.title)}</b><div class="ld-muted">${e(w.created_at?.slice(0,10)||'')} · ♥ ${w.likes_count}</div>${isMgr?form(`/api/artworks/${w.id}`,u,`<input type="hidden" name="op" value="publish"><input type="hidden" name="is_public" value="${w.is_public?'0':'1'}">${btn(w.is_public?'取消公开':'允许家长查看','btn-sm btn-outline-secondary')}`):''}${(isMgr||w.uploader_id===u.id)?form(`/api/artworks/${w.id}`,u,'<input type="hidden" name="op" value="delete"><button class="btn btn-sm btn-link text-danger">删除误传</button>','', 'data-confirm="确认删除作品"'):''}</div></div>`).join('')||'<span class="ld-muted">还没有上传作品</span>'}</div>`);
 h+=`<details class="ld-collapse"><summary>历史消课 · ${rec.length} 条</summary>`+card('消课记录',table(['日期','班级','扣除','状态','操作'],rec.map(r=>[e(r.display_date||''),e(r.group_name),e(r.deducted_lessons),r.revoked_at?'已撤销':'有效',!r.revoked_at&&(isMgr||r.operator_id===u.id&&r.quick_id)?form(`/api/undo/${r.id}`,u,(isManager(u)?'<input name="reason" class="form-control form-control-sm" maxlength="200" placeholder="撤销原因" required>':'')+'<button class="btn btn-sm btn-outline-secondary">撤销</button>'):'—'])))+`</details>`;
 if(isMgr)h+=`<details class="ld-collapse"><summary>交费及课时调整流水</summary>`+card('交费与调整流水',table(['时间','类型','余额变化','实收','操作人'],payments.map(r=>[e(r.created_at?.slice(0,16)||''),r.type==='charge'?'交费':'调整',(r.lessons_delta||0)+(r.type==='charge'?(r.lessons_bonus||0):0),money(r.amount_cents),e(r.operator||'—')])))+`</details>`;
 return ui(env,u,s.name,h,'/students');}
async function uploadPage(env,u,id){
 const s=await canSeeStudent(env,u,id);
 const h=section('上传学员作品',`学员：${s.name} · 上传作品与消课互相独立`)+card('新作品',`<form id="art-form" data-state="idle" action="/api/students/${id}/upload" method="post" enctype="multipart/form-data">${csrf(u)}<input type="hidden" name="upload_nonce" value="${randomToken(20)}">
 <div class="ld-upload-inputs">
  <div class="ld-art-pickers" role="group" aria-label="选择照片来源">
   <label class="ld-art-picker">📷 立即拍照<input id="art-camera" type="file" accept="image/*" capture="environment" aria-label="打开相机拍摄作品"></label>
   <label class="ld-art-picker">▣ 从相册选择<input id="art-file" name="photo" type="file" accept="image/*" aria-label="从相册选择作品照片"></label>
  </div>
  <p id="art-selected" class="ld-muted" role="status">拍照或从相册选择一张作品。</p>
  <img id="art-preview" class="ld-photo-preview" alt="作品预览" hidden>
  ${input('title','作品标题','课堂作品')}
  <details class="ld-upload-description"><summary>添加作品介绍（可选）</summary><textarea class="form-control" name="note" rows="2" maxlength="300" placeholder="记录画了什么或课堂表现（可不填）"></textarea></details>
  <p class="ld-muted ld-upload-help">图片会自动缩小并移除照片元数据，再保存到画室作品档案。</p>
 </div>
 <div class="ld-upload-progress" id="art-progress-wrap" hidden><progress id="art-progress" max="100" value="0"></progress><p class="ld-muted" id="art-upload-status" role="status" aria-live="polite"></p><details id="art-diagnostics" class="ld-upload-note" hidden><summary>上传耗时详情</summary><p class="ld-muted" id="art-metrics"></p></details></div>
 <div class="ld-upload-actions">
  <button class="btn btn-primary" type="submit" id="art-submit" disabled>请选择照片</button>
  <a href="/students/${id}#artworks" class="btn btn-soft" id="art-view" hidden>查看作品</a>
  <a href="/students/${id}/upload" class="btn btn-soft" id="art-again" hidden>再上传一张</a>
  <a href="/" class="ld-upload-back" id="art-back">返回上课</a>
 </div>
 </form>`);
 return ui(env,u,'上传作品',h,'/students');
}
async function classesPage(env,u,url){
 manager(u);
 const campus=reqCampus(u,url);
 const [schoolsRaw,teachers,courses,gs]=await Promise.all([
  all(env.DB,'SELECT * FROM campus WHERE is_active=1'),
  all(env.DB,"SELECT * FROM user WHERE role='teacher'"),
  all(env.DB,'SELECT * FROM course'),
  all(env.DB,`SELECT g.*,c.name AS course_name,t.username AS teacher_name FROM class_group g LEFT JOIN course c ON c.id=g.course_id LEFT JOIN user t ON t.id=g.teacher_id WHERE ${campus?'g.campus_id=?':'1=1'} ORDER BY g.is_archived,g.weekday,g.name`,...(campus?[campus]:[]))
 ]);
 const schools=schoolsRaw.filter(c=>u.role==='super_admin'||c.id===u.campus_id);
 let h=section('班级管理','班级设置与历史记录独立。归档后停止消课，仍可恢复使用。');
 h+=`<details class="ld-collapse"><summary>＋ 创建新班级</summary>`+card('创建班级',form('/api/classes',u,`<div class="ld-form-grid">${select('campus_id','校区',schools.map(c=>[c.id,c.name]),u.campus_id||schools[0]?.id)}${input('name','班级名称','','text',true)}${select('course_id','课程',courses.filter(c=>!c.is_archived&&schools.some(s=>s.id===c.campus_id)).map(c=>[c.id,c.name,c.campus_id]))}${select('teacher_id','教师',[['','暂未指定'],...teachers.filter(t=>t.is_active&&schools.some(s=>s.id===t.campus_id)).map(t=>[t.id,t.username,t.campus_id])])}${select('weekday','每周',[...'一二三四五六日'].map(w=>['周'+w,'周'+w]))}${input('start_time','开始','09:00','time',true)}${input('end_time','结束','10:30','time',true)}${input('room','教室')}${input('capacity','班级容量（0=不限）','0','number')}${input('deduct_lessons','每次消课','1','number')}</div><div class="mt-2">${btn('创建班级')}</div>`))+`</details>`;
 for(const g of gs){
  const courseOptions=courses.filter(c=>c.campus_id===g.campus_id).map(c=>[c.id,c.name+(c.is_archived?' (已归档)':'')]);
  const teacherOptions=[['','暂不指定'],...teachers.filter(t=>t.campus_id===g.campus_id&&(t.is_active||t.id===g.teacher_id)).map(t=>[t.id,t.username+(t.is_active?'':'（已停用，仅保留旧分配）')])];
  h+=`<details class="ld-collapse" id="class-${g.id}"><summary><b>${e(g.name)}</b><span>${e(g.weekday)} ${e(g.start_time)}–${e(g.end_time)} · ${e(g.teacher_name||'未分配')} · ${g.is_archived?'归档':'在用'}</span></summary>`+card(`${e(g.name)} <small>(${e(g.course_name||'无课程')} · ${g.is_archived?'已归档':'在用'})</small>`,form(`/api/classes/${g.id}`,u,`<div class="ld-form-grid">${input('name','班级名称',g.name,'text',true)}${select('course_id','课程',courseOptions,g.course_id)}${select('teacher_id','教师',teacherOptions,g.teacher_id||'')}${select('weekday','每周',[...'一二三四五六日'].map(w=>['周'+w,'周'+w]),g.weekday)}${input('start_time','上课时间',g.start_time,'time',true)}${input('end_time','下课时间',g.end_time,'time',true)}${input('capacity','班额（0=不限）',g.capacity,'number')}${input('deduct_lessons','每次消课节数',g.deduct_lessons,'number')}${input('room','教室',g.room)}${select('is_archived','状态',[['0','正常'],['1','归档']],g.is_archived?'1':'0')}</div><div class="mt-2">${btn('保存班级','btn-outline-primary')}</div>`))+`</details>`;
 }
 return ui(env,u,'班级管理',h,'/classes');
}
async function coursesPage(env,u){
 manager(u);
 const campus=u.role==='super_admin'?null:u.campus_id,schools=(await all(env.DB,'SELECT * FROM campus WHERE is_active=1')).filter(c=>!campus||c.id===campus);
 const courses=await all(env.DB,`SELECT c.*,ca.name AS school FROM course c JOIN campus ca ON ca.id=c.campus_id WHERE ${campus?'c.campus_id=?':'1=1'} ORDER BY c.is_archived,c.name`,...(campus?[campus]:[]));
 let h=section('课程管理','课程只作为分类。余额属于学员，不会按课程重复扣减。');
 h+=card('新增课程',form('/api/courses',u,select('campus_id','校区',schools.map(x=>[x.id,x.name]))+input('name','课程名称','','text',true)+input('category','课程分类','绘画')+btn('添加课程')));
 h+=courses.map(c=>card(`${e(c.name)} · ${e(c.school)}${c.is_archived?'（已归档）':''}`,form(`/api/courses/${c.id}`,u,`<div class="ld-form-grid">${input('name','课程名称',c.name,'text',true)}${input('category','分类',c.category)}${select('is_archived','状态',[['0','在用'],['1','归档']],String(c.is_archived||0))}</div><div class="mt-2">${btn('保存课程','btn-outline-primary')}</div>`))).join('');
 return ui(env,u,'课程管理',h,'/courses');
}
async function recordsPage(env,u,url){const sid=intval(url.searchParams.get('student_id'),1)||null;if(sid)await canSeeStudent(env,u,sid);const rec=await recentRecord(env,u,300,sid);let h=section('消课记录','保留操作流水，不直接删除记录；管理员可撤销错误消课。');h+=card('最近记录（最多 300 条）',table(['日期','班级','学员','扣除','状态','操作'],rec.map(r=>[e(r.display_date||''),e(r.group_name),e(r.student_name),r.deducted_lessons,r.revoked_at?'已撤销':'有效',!r.revoked_at&&(isManager(u)||r.operator_id===u.id&&r.quick_id)?form(`/api/undo/${r.id}`,u,(isManager(u)?'<input name="reason" class="form-control form-control-sm" maxlength="200" placeholder="撤销原因" required>':'')+'<button class="btn btn-sm btn-outline-secondary">撤销</button>'):'—'])));return ui(env,u,'消课记录',h,'/records');}
async function financePage(env,u){
 manager(u);const wh=u.role==='super_admin'?'1=1':'campus_id=?',args=u.role==='super_admin'?[]:[u.campus_id];
 const [payments,expenses,sums,spend,camps,refunds,refundSum,monthlyIncome,monthlyExpense,expenseKinds]=await Promise.all([
 all(env.DB,`SELECT p.*,s.name AS student_name FROM payment_record p JOIN student s ON s.id=p.student_id WHERE ${wh.replace('campus_id','p.campus_id')} ORDER BY p.id DESC LIMIT 120`,...args),
 all(env.DB,`SELECT * FROM campus_expense WHERE ${wh} ORDER BY id DESC LIMIT 100`,...args),
 one(env.DB,`SELECT COALESCE(SUM(CASE WHEN type='charge' THEN amount_cents ELSE 0 END),0) AS income, COUNT(CASE WHEN type='charge' THEN 1 END) AS count FROM payment_record WHERE ${wh}`,...args),
 one(env.DB,`SELECT COALESCE(SUM(amount_cents),0) AS total FROM campus_expense WHERE ${wh}`,...args),
 all(env.DB,'SELECT * FROM campus WHERE is_active=1'),
 all(env.DB,`SELECT r.*,s.name AS student_name FROM refund_record r JOIN student s ON s.id=r.student_id WHERE ${wh.replace('campus_id','r.campus_id')} ORDER BY r.id DESC LIMIT 100`,...args),
 one(env.DB,`SELECT COALESCE(SUM(amount_cents),0) AS total FROM refund_record WHERE ${wh}`,...args),
 all(env.DB,`SELECT substr(created_at,1,7) AS label,SUM(amount_cents) AS value FROM payment_record WHERE type='charge' AND ${wh} GROUP BY substr(created_at,1,7) ORDER BY label DESC LIMIT 6`,...args),
 all(env.DB,`SELECT substr(created_at,1,7) AS label,SUM(amount_cents) AS value FROM campus_expense WHERE ${wh} GROUP BY substr(created_at,1,7) ORDER BY label DESC LIMIT 6`,...args),
 all(env.DB,`SELECT category AS label,SUM(amount_cents) AS value FROM campus_expense WHERE ${wh} GROUP BY category ORDER BY value DESC LIMIT 6`,...args)
 ]);
 let h=section('收支','实际登记金额与课时余额调整分开计算；统计仅供内部经营参考');
 h+=statGrid([['累计实收',money(sums.income)],['累计退款',money(refundSum.total)],['登记支出',money(spend.total)],['登记收支差额',money(sums.income-refundSum.total-spend.total)]]);
 h+=card('最近 6 个月 · 实收与支出',incomeExpenseChart(monthlyIncome,monthlyExpense));
 h+=card('支出构成',expensePie(expenseKinds));
 h+=`<details class="ld-collapse"><summary>＋ 登记支出</summary>`+card('支出',form('/api/expenses',u,`<input type="hidden" name="nonce" value="${randomToken(20)}"><div class="ld-form-grid">${select('campus_id','校区',camps.filter(x=>u.role==='super_admin'||x.id===u.campus_id).map(x=>[x.id,x.name]))}${select('category','费用类别',[['耗材','耗材'],['房租','房租'],['工资','工资'],['水电','水电'],['营销','营销'],['其他','其他']])}${input('amount','金额（元）','0','number',true)}${input('remarks','说明')}</div>${btn('保存支出')}`))+`</details>`;
 h+=`<details class="ld-collapse"><summary>收入与课时调整 · 最近 120 条</summary>`+card('流水',table(['时间','学员','类型','课时','金额'],payments.map(p=>[e(p.created_at?.slice(0,16)||''),e(p.student_name),p.type==='charge'?'交费':'调整',String(p.lessons_delta+(p.type==='charge'?p.lessons_bonus:0)),money(p.amount_cents)])))+`</details>`;
 h+=`<details class="ld-collapse"><summary>退款流水 · 最近 100 条</summary>`+card('退款',table(['时间','学员','金额','扣回课时'],refunds.map(r=>[e(r.created_at?.slice(0,16)||''),e(r.student_name),money(r.amount_cents),r.lessons_debited])))+`</details>`;
 h+=`<details class="ld-collapse"><summary>支出流水 · 最近 100 条</summary>`+card('支出',table(['时间','类别','金额','备注'],expenses.map(r=>[e(r.created_at?.slice(0,16)||''),e(r.category),money(r.amount_cents),e(r.remarks)])))+`</details>`;
 h+='<p class="ld-muted">注意：差额并非利润，未计入未登记的成本、税费或应收款。</p>';
 return ui(env,u,'财务',h,'/finance');}
async function usersPage(env,u){manager(u);const rows=await all(env.DB,`SELECT u.*,c.name AS campus_name,ap.avatar_key FROM user u LEFT JOIN campus c ON u.campus_id=c.id LEFT JOIN account_profile ap ON ap.user_id=u.id WHERE ${u.role==='super_admin'?'1=1':'u.campus_id=?'} ORDER BY u.id`,...(u.role==='super_admin'?[]:[u.campus_id]));const camps=await all(env.DB,'SELECT * FROM campus WHERE is_active=1');let h=section('教师账号','权限：系统管理员管理全部校区；校区管理员可管理本校区班级、学员、品牌与教师；教师仅访问本人任教班级和学生，可消课与上传作品。修改角色将踢出其旧登录。');h+=card('新增账号',form('/api/users',u,`<div class="ld-form-grid">${input('username','用户名','','text',true)}${input('password','初始密码（10 位以上）','','password',true)}${select('role','身份',u.role==='super_admin'?[['teacher','教师'],['manager','校区管理员']]:[['teacher','教师']])}${select('campus_id','校区',camps.filter(x=>u.role==='super_admin'||x.id===u.campus_id).map(x=>[x.id,x.name]))}</div>${btn('创建账号')}`));h+=rows.map(t=>card(`${t.avatar_key?`<img src="/avatar/${t.id}" class="ld-avatar" alt="用户头像"> `:''}${e(t.username)} · ${e(t.campus_name||'全局')} · ${e(t.role)}`,t.role==='super_admin'?'<p class="ld-muted">系统管理员账号请在个人中心修改密码。</p>':`<div class="ld-actions">${form(`/api/users/${t.id}`,u,`<input type="hidden" name="op" value="toggle">${btn(t.is_active?'停用账号':'恢复账号','btn-outline-secondary')}`)}${form(`/api/users/${t.id}`,u,`<input type="hidden" name="op" value="reset">${input('password','重置密码（10 位以上）','','password',true)}${btn('重置密码','btn-outline-primary')}`)}${u.role==='super_admin'?form(`/api/users/${t.id}`,u,`<input type="hidden" name="op" value="role">${select('role','角色权限',[['teacher','教师（只管自己班）'],['manager','校区管理员（管理本校区）']],t.role)}${btn('更新权限','btn-outline-secondary')}`):''}</div>`)).join('');return ui(env,u,'账号',h,'/users');}
async function campusPage(env,u,url){
 manager(u);
 const camps=await all(env.DB,`SELECT * FROM campus WHERE ${u.role==='super_admin'?'1=1':'id=?'} ORDER BY id`,...(u.role==='super_admin'?[]:[u.campus_id]));
 let h=section('校区管理','直接修改现有校区名称。不会改变校区编号、编码及学员、班级、课时的关联。');
 const changed=intval(url.searchParams.get('updated'),1),unchanged=intval(url.searchParams.get('unchanged'),1);
 if(changed&&camps.some(c=>c.id===changed))h+=message('校区已重命名，原有学员、班级和课时关联保持不变。','success');
 if(unchanged&&camps.some(c=>c.id===unchanged))h+=message('名称没有变化，无需保存。','info');
 for(const c of camps){
  h+=card(`校区 #${c.id} · ${e(c.name)}`,`<p class="ld-muted">校区编码：<code>${e(c.code)}</code>（保持不变）　·　${c.is_active?'正常使用':'已停用'}</p>`+
   (c.is_active?form(`/api/campuses/${c.id}/rename`,u,`<div class="ld-form-grid">${input('name','内部校区名称',c.name,'text',true)}</div><p class="ld-muted">此处更改用于学员、班级、账号等内部页面。家长作品页的展示名称与 Logo 仍在「画室品牌」中设置。</p>${btn('保存校区名称','btn-primary')}`):'<p class="ld-muted">已停用校区暂不可重命名。</p>')+
   `<p class="mt-2 mb-0"><a class="btn btn-soft btn-sm" href="/branding?campus_id=${c.id}">管理画室品牌、Logo 与家长页 →</a></p>`);
 }
 if(u.role==='super_admin')h+=`<details class="ld-collapse"><summary>＋ 创建新校区（不是重命名）</summary>${card('新增校区',form('/api/campuses',u,input('name','校区名称','','text',true)+input('code','编码（大写英文）','','text',true)+btn('创建校区')))}</details>`;
 return ui(env,u,'校区管理',h,'/campuses');
}
async function entriesPage(env,u,req){manager(u);const c=u.role==='super_admin'?null:u.campus_id,entries=await all(env.DB,`SELECT re.*,ca.name AS campus_name FROM registration_entry re JOIN campus ca ON ca.id=re.campus_id WHERE ${c?'re.campus_id=?':'1=1'} ORDER BY re.id DESC`,...(c?[c]:[])),camps=await all(env.DB,'SELECT * FROM campus WHERE is_active=1');let h=section('报名入口','生成家长填写的公开报名链接，不需要账号');h+=card('新建报名链接',form('/api/entries',u,select('campus_id','校区',camps.filter(x=>!c||x.id===c).map(x=>[x.id,x.name]))+input('name','入口名称（如：秋季班报名）','','text',true)+input('contact','联系信息')+btn('创建入口')));h+=entries.map(x=>card(e(x.name),`<div class="ld-link-break"><a href="/r/${a(x.token)}" target="_blank">${e(linkOr(req,`/r/${x.token}`))}</a></div><p class="ld-muted">${e(x.campus_name)} · ${x.enabled?'正在接受报名':'已关闭'}</p>`+form(`/api/entries/${x.id}`,u,btn(x.enabled?'关闭报名':'开启报名','btn-outline-secondary')))).join('');return ui(env,u,'报名入口',h,'/entries');}
async function registrationsPage(env,u){manager(u);const camp=u.role==='super_admin'?null:u.campus_id,recs=await all(env.DB,`SELECT r.*,g.name AS group_name,en.name AS entry_name FROM registration r JOIN class_group g ON g.id=r.class_group_id JOIN registration_entry en ON en.id=r.entry_id WHERE ${camp?'r.campus_id=?':'1=1'} ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END,r.id DESC LIMIT 200`,...(camp?[camp]:[]));let h=section('报名审批','家长提交后必须管理员审批才会正式入班');h+=recs.map(r=>card(`${e(r.student_name)} · ${e(r.group_name)} ${r.status==='pending'?'<span class="st-badge">待审核</span>':`<span class="st-badge">${e(r.status)}</span>`}`,`<div class="ld-muted">家长：${e(r.guardian_name)} · ${e(r.guardian_phone)} · ${e(r.entry_name)}</div>${r.status==='pending'?`<div class="ld-actions mt-2">${form(`/api/registrations/${r.id}`,u,'<input type="hidden" name="status" value="confirmed"><label class="form-label">现有学员 ID（选填；留空创建新学员）<input name="existing_student_id" inputmode="numeric" class="form-control form-control-sm" placeholder="核对身份后填写"></label><button class="btn btn-sm btn-primary">确认入班</button>')}${form(`/api/registrations/${r.id}`,u,'<input type="hidden" name="status" value="cancelled"><button class="btn btn-sm btn-outline-secondary">拒绝</button>')}</div>`:''}`)).join('')||'<p>没有待办报名</p>';return ui(env,u,'报名',h,'/registrations');}
async function regPublic(env,token,req,url){const entry=await one(env.DB,'SELECT * FROM registration_entry WHERE token=? AND enabled=1',token);if(!entry)return html(publicLayout('报名已关闭',message('报名入口已关闭或链接无效','warning')),404);if(entry.deadline&&String(entry.deadline)<new Date().toISOString().slice(0,16))return html(publicLayout('报名截止',message('报名已截止','warning')));const gs=await all(env.DB,`SELECT g.*,COALESCE((SELECT COUNT(*) FROM enrollment WHERE class_group_id=g.id AND status='active'),0)+COALESCE((SELECT COUNT(*) FROM registration WHERE class_group_id=g.id AND status='pending'),0) AS occupied FROM class_group g WHERE g.campus_id=? AND g.is_archived=0 ORDER BY g.name`,entry.campus_id);const available=gs.filter(g=>!g.capacity||g.occupied<g.capacity+(g.allow_override?g.override_extra:0));const h=`<div class="ld-public-header"><h2>${e(entry.name)}</h2><p class="ld-muted">提交后由老师确认，报名不自动扣课或收取费用。</p>${url.searchParams.get('modified')?message('已提交班级修改，请等候老师确认。','success'):''}</div>`+card('填写报名信息',`<form method="post" action="/r/${a(token)}">${select('class_group_id','选择班级',available.map(g=>[g.id,`${g.name} · ${g.weekday} ${g.start_time}`]))}${input('student_name','学生姓名','','text',true)}${input('grade','年级')}${input('guardian_name','家长姓名')}${input('guardian_phone','联系电话','','tel',true)}${area('note','说明')}${btn('提交报名')}</form><p class="mt-3"><a href="/r/${a(token)}/modify">已有报名？使用修改码更换班级 →</a></p>`);return html(publicLayout(entry.name,h));}
async function regModifyPage(env,token){const entry=await one(env.DB,'SELECT * FROM registration_entry WHERE token=?',token);if(!entry)throw err('链接不存在',404);const gs=await all(env.DB,"SELECT * FROM class_group WHERE campus_id=? AND is_archived=0 ORDER BY name",entry.campus_id);
 const h=`<div class="ld-public-header"><h2>修改报名班级</h2><p class="ld-muted">仅限待确认报名；姓名、联系电话尾号和提交时得到的 6 位修改码须一致。最多修改 3 次。</p></div>`+card('修改报名',`<form method="post" action="/r/${a(token)}/modify"><input type="hidden" name="action" value="change">${input('student_name','学生姓名','','text',true)}${input('phone_last4','家长手机尾号（4 位）','','text',true)}${input('code','6 位修改码','','text',true)}${select('class_group_id','改到班级',gs.map(g=>[g.id,`${g.name} · ${g.weekday}`]))}${btn('提交修改')}</form>`);return html(publicLayout('修改报名',h));}
async function publicPage(env,token){const sh=await one(env.DB,'SELECT sh.*,s.lessons_remaining,s.name,s.campus_id,c.name AS campus_name,b.studio_name,b.slogan,b.address,b.contact,b.logo_key,b.qr_key FROM student_share sh JOIN student s ON s.id=sh.student_id JOIN campus c ON c.id=s.campus_id LEFT JOIN campus_brand b ON b.campus_id=s.campus_id WHERE sh.token=? AND sh.enabled=1 AND s.status!=\'archived\'',token);if(!sh)throw err('家长链接不存在或已经停用',404);const works=await all(env.DB,'SELECT id,title,note,likes_count,created_at FROM artwork WHERE student_id=? AND is_public=1 AND is_deleted=0 ORDER BY created_at DESC LIMIT 120',sh.student_id);let h=`<div class="ld-public-header"><div class="ld-public-studio">${sh.logo_key?`<img class="ld-public-logo" alt="画室标识" src="/branding/logo/${sh.campus_id}">`:''}<strong>${e(sh.studio_name||sh.campus_name)}</strong></div><div class="ld-muted">我的成长档案</div><h1>${e(sh.public_name||sh.name)}</h1><p class="mt-3">剩余课时：<strong style="font-size:28px;color:#ae3440">${sh.lessons_remaining}</strong> 节</p><small class="ld-muted">所有课程合计课时；由画室维护。分享本页面给亲友可一起看作品。</small></div><div class="ld-section-title">课堂作品 · ${works.length} 件</div><div class="ld-public-grid">${works.map(w=>`<div class="ld-public-card"><img alt="${a(w.title)}" loading="lazy" src="/p/${a(token)}/img/${w.id}"><div class="ld-public-card-body"><strong>${e(w.title)}</strong><p class="ld-muted mb-1">${e(w.created_at?.slice(0,10)||'')}</p><div>${e(w.note)}</div><form class="js-like mt-2" method="post" action="/p/${a(token)}/like/${w.id}"><button type="submit" class="btn btn-sm btn-outline-secondary">♥ ${w.likes_count}</button></form></div></div>`).join('')||'<p>作品正在整理中</p>'}</div><section class="ld-parent-footer"><h2>${e(sh.studio_name||sh.campus_name)}</h2>${sh.slogan?`<p class="ld-parent-slogan">${e(sh.slogan)}</p>`:''}<div class="ld-parent-contact"><div>${sh.address?`<p><strong>画室地址</strong> ${e(sh.address)}</p>`:''}${sh.contact?`<p><strong>联系方式</strong> ${e(sh.contact)}</p>`:''}</div>${sh.qr_key?`<img src="/branding/qr/${sh.campus_id}" loading="lazy" alt="画室联系二维码" class="ld-parent-qr">`:''}</div></section>`;return html(publicLayout(sh.public_name||sh.name,h),200,{'X-Robots-Tag':'noindex, nofollow, noarchive'});}
async function imageResponse(env,id,token,u){let arow;if(token){arow=await one(env.DB,'SELECT a.* FROM artwork a JOIN student_share sh ON sh.student_id=a.student_id WHERE a.id=? AND a.is_deleted=0 AND a.is_public=1 AND sh.enabled=1 AND sh.token=?',id,token);}else{arow=await one(env.DB,'SELECT * FROM artwork WHERE id=? AND is_deleted=0',id);if(arow)await canSeeStudent(env,u,arow.student_id);}
 if(!arow)throw err('无权访问该作品',404);const item=await env.ARTWORKS.get(arow.image_key);if(!item)throw err('作品文件未找到',404);return new Response(item.body,{headers:{'Content-Type':work.contentTypeFromKey(arow.image_key),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex','Referrer-Policy':'no-referrer'}});}
async function profilePage(env,u){
 const avatar=u.avatar_key?`<img src="/avatar/${u.id}" class="ld-avatar lg" alt="个人头像">`:'<span class="ld-avatar-fallback">👤</span>';
 const photoForm=`<form class="js-media-form" method="post" action="/api/profile/avatar" enctype="multipart/form-data">${csrf(u)}<label class="form-label">上传头像（支持拍照或相册）<input name="photo" type="file" accept="image/*" class="form-control" required></label><p class="ld-muted">图片将在浏览器内压缩为 WebP，无 EXIF 信息。</p><button class="btn btn-soft" type="submit">更新头像</button></form>`;
 return ui(env,u,'个人中心',section('个人中心','管理个人头像和密码')+card('我的头像',`<div class="ld-avatar-header">${avatar}<span>${e(u.username)} · ${e(u.role==='teacher'?'教师':u.role==='manager'?'校区管理员':'系统管理员')}</span></div>${photoForm}`)+card('更换密码',form('/api/profile/password',u,input('old_password','原密码','','password',true)+input('new_password','新密码（10 位以上）','','password',true)+btn('更新密码'))),'/profile');
}
async function managePage(env,u){manager(u);const links=[['/classes','班级与课程安排','维护时间、任课老师和班额'],['/courses','课程分类','课程名称与归档'],['/registrations','报名审批','确认、拒绝及关联现有学生'],['/entries','公开报名入口','设置家长填报入口'],['/users','教师账号与权限','账号停用与密码重置'],['/branding','画室品牌资料','Logo、二维码、地址及宣传语'],['/campuses','校区名称','重命名校区，不更换数据归属'],['/data','数据与安全','季度、年度备份及恢复验收'],['/profile','个人中心','头像与个人密码']];
 return ui(env,u,'管理',section('管理','只把低频设置放在这里，老师日常页面不受影响')+`<div class="ld-manage-grid">${links.map(([url,name,desc])=>`<a class="ld-manage-card" href="${url}"><strong>${name} →</strong><small>${desc}</small></a>`).join('')}</div>`,'/manage');}
async function dataPage(env,u){superuser(u);
 const contract=await one(env.DB,'SELECT major,minor,updated_at FROM data_contract WHERE id=1');
 const students=await one(env.DB,'SELECT COUNT(*) n,COALESCE(SUM(lessons_remaining),0) balance FROM student');
 const logs=await one(env.DB,'SELECT COUNT(*) n FROM operation_log');
 const images=await one(env.DB,'SELECT COUNT(*) n FROM artwork WHERE is_deleted=0');
 const content=section('数据与安全','只有系统管理员能执行灾难恢复。备份文件务必加密并存于 Cloudflare 之外')+
 statGrid([['数据版本',`${contract?.major||'?'} . ${contract?.minor||0}`],['学员',students.n],['总剩余课时',students.balance],['操作日志',logs.n]])+
 card('季度与年度备份',`<p>课时、班级、财务流水、账号、操作日志和图片索引会随 D1 SQL 一起备份。作品图片及头像等 R2 文件<strong>不自动备份</strong>，需要时手动导出。</p><p class="ld-muted">数据备份由部署者在已登录 Wrangler 的可信设备执行 <code>bash scripts/backup_data.sh</code>；季度自动化可由 NAS 的计划任务调用 <code>scripts/backup_quarterly.sh</code>。每年一月备份留作年度归档。</p><p>当前作品索引：${images.n} 条。备份文件具备 SHA-256 校验和实际恢复演练脚本。</p>`)+
 card('灾难恢复原则','<p>恢复必须创建全新空 D1，再验证压缩包、字段版本、学员数量、课时总余额和外键。先在测试 Worker 验收，再修改正式域名绑定。</p><p class="ld-muted">为防止误覆盖，本页面不提供直接执行恢复的按钮。完整恢复命令见项目 docs/V7-备份恢复.md。</p>');
 return ui(env,u,'数据与安全',content,'/manage');}
async function brandingPage(env,u,url){
 manager(u);const campus=u.role==='super_admin'?(intval(url.searchParams.get('campus_id'),1)|| (await one(env.DB,'SELECT id FROM campus ORDER BY id LIMIT 1'))?.id):u.campus_id;
 if(u.role!=='super_admin'&&campus!==u.campus_id)throw err('无权访问其他校区',403);
 const chosen=await one(env.DB,'SELECT * FROM campus WHERE id=?',campus);if(!chosen)throw err('校区不存在',404);
 const b=await one(env.DB,'SELECT * FROM campus_brand WHERE campus_id=?',chosen.id)||{};
 const campusList=u.role==='super_admin'?await all(env.DB,'SELECT id,name FROM campus WHERE is_active=1 ORDER BY id'):[];
 let h=section('画室展示资料','此处配置首页与家长作品页显示的品牌名称、Logo、二维码及联系资料。内部校区名称在「校区管理」中修改。');h+=`<p class="mb-3">内部校区：<strong>${e(chosen.name)}</strong>　<a href="/campuses" class="btn btn-sm btn-soft">修改校区名称 →</a></p>`;
 if(campusList.length>1)h+=card('切换管理校区',`<form method="get" action="/branding">${select('campus_id','当前校区',campusList.map(c=>[c.id,c.name]),chosen.id)}<button class="btn btn-soft" type="submit">切换</button></form>`);
 h+=card('公开页与首页品牌设置',form('/api/branding',u,`<input type="hidden" name="campus_id" value="${chosen.id}"><div class="ld-form-grid">${input('studio_name','对外展示名称（可与校区不同）',b.studio_name||chosen.name,'text',true)}${input('contact','联系人及联系电话',b.contact||'')}${input('address','画室地址',b.address||'')}</div>${area('slogan','画室宣传语',b.slogan||'')}${btn('保存展示信息')}`));
 for(const [kind,title,key,tip] of [['logo','画室 Logo','logo_key','首页和家长作品页共用'],['qr','联系二维码','qr_key','仅展示在家长作品页底部']]){
  h+=card(title,`${b[key]?`<img class="ld-brand-preview ${kind==='qr'?'ld-brand-qr':''}" src="/branding/${kind}/${campus}" alt="${title}">`:'<p class="ld-muted">尚未上传</p>'}<p class="ld-muted">${tip}</p><form class="js-media-form" action="/api/branding/${kind}" enctype="multipart/form-data" method="post">${csrf(u)}<input type="hidden" name="campus_id" value="${campus}"><label class="form-label">选择图片 <input type="file" class="form-control" accept="image/*" name="photo" required></label><button class="btn btn-soft" type="submit">上传${title}</button></form>`);
 }
 return ui(env,u,'画室品牌',h,'/branding');
}
async function postHandler(req,env,u,url,data){const p=url.pathname,m=req.method;let x;const mat=(reg)=>match(p,reg);
 if(p==='/login'){const raw=await login(env,req,data);return redirect('/',303,{'Set-Cookie':sessionCookie(url,raw)});}if(p==='/setup'){await bootstrap(env,req,data);return redirect('/login');}if(p.startsWith('/r/')&&m==='POST'){const modified=p.endsWith('/modify');const token=p.slice(3).replace(/\/modify$/,'');const entry=await one(env.DB,'SELECT * FROM registration_entry WHERE token=? AND enabled=1',token);if(!entry)throw err('无效的报名入口',404);if(entry.deadline&&String(entry.deadline)<new Date().toISOString().slice(0,16))throw err('报名已经截止',403);if(modified)return go(await work.registrationModify(env,req,entry,data));const res=await work.registrationSubmit(env,entry,data,req);return html(publicLayout('报名成功',`<div class="ld-public-header"><h2>报名已提交</h2><p>学生：${e(res.student_name)} · ${e(res.group_name)}</p><p>请保存以下修改码，报名班级只能凭它更换。</p><h2 style="color:#ae3440;letter-spacing:5px">${e(res.code)}</h2><p class="ld-muted">此码只显示一次，不要公开分享。报名尚待老师确认。</p><a class="btn btn-soft" href="/r/${a(token)}">返回报名页</a></div>`));}
 if(mat(/^\/p\/([A-Za-z0-9_-]{32,96})\/like\/(\d+)$/)){const mt=mat(/^\/p\/([A-Za-z0-9_-]{32,96})\/like\/(\d+)$/);return work.publicLike(env,req,mt[1],Number(mt[2]));}
 requireUser(u);await checkCsrf(req,u,data);if(p==='/logout'){await logout(env,u);return redirect('/login',303,{'Set-Cookie':sessionCookie(url,'',0)});}
 if(p==='/api/profile/avatar')return media.saveAvatar(env,u,data);
 if(p==='/api/branding')return media.saveBrand(env,u,data);
 if(p==='/api/branding/logo')return media.saveBrandAsset(env,u,data,'logo');
 if(p==='/api/branding/qr')return media.saveBrandAsset(env,u,data,'qr');
 if(p==='/api/students')return work.studentCreate(env,u,data);if(p==='/api/courses')return work.courseCreate(env,u,data);if(p==='/api/classes')return work.classCreate(env,u,data);if(p==='/api/expenses')return work.expense(env,u,data);if(p==='/api/users'){await makeUser(env,u,data);return {ok:true,redirect:'/users'};}if(p==='/api/campuses')return work.campusCreate(env,u,data);if((x=mat(/^\/api\/campuses\/(\d+)\/rename$/)))return work.campusRename(env,u,Number(x[1]),data);if(p==='/api/entries')return work.entryCreate(env,u,data);if(p==='/api/profile/password'){await changePassword(env,u,field(data,'old_password'),field(data,'new_password'));return {ok:true,redirect:'/profile'};}
 if((x=mat(/^\/api\/quick\/(\d+)\/(\d+)$/)))return work.quickDeduct(env,u,Number(x[1]),Number(x[2]));if((x=mat(/^\/api\/trial\/(\d+)\/(\d+)$/)))return work.trialAttendance(env,u,Number(x[1]),Number(x[2]));
 if((x=mat(/^\/api\/undo\/(\d+)$/)))return work.undoLesson(env,u,Number(x[1]),data);
 if((x=mat(/^\/api\/students\/(\d+)\/manual$/)))return work.manualDeduct(env,u,Number(x[1]),data);
 if((x=mat(/^\/api\/students\/(\d+)\/edit$/)))return work.studentUpdate(env,u,Number(x[1]),data);
 if((x=mat(/^\/api\/students\/(\d+)\/payment$/)))return work.payment(env,u,Number(x[1]),data);
   if((x=mat(/^\/api\/students\/(\d+)\/refund$/)))return work.refund(env,u,Number(x[1]),data);
 if((x=mat(/^\/api\/students\/(\d+)\/enroll$/)))return work.enroll(env,u,Number(x[1]),intval(field(data,'class_group_id'),1));
 if((x=mat(/^\/api\/students\/(\d+)\/leave\/(\d+)$/)))return work.leave(env,u,Number(x[1]),Number(x[2]));
 if((x=mat(/^\/api\/students\/(\d+)\/share$/)))return work.shareUpdate(env,u,Number(x[1]),data);
 if((x=mat(/^\/api\/students\/(\d+)\/upload$/)))return work.artworkUpload(env,u,Number(x[1]),data);
 if((x=mat(/^\/api\/artworks\/(\d+)$/)))return work.artworkAction(env,u,Number(x[1]),data);
 if((x=mat(/^\/api\/classes\/(\d+)$/)))return work.classUpdate(env,u,Number(x[1]),data);
 if((x=mat(/^\/api\/courses\/(\d+)$/)))return work.courseUpdate(env,u,Number(x[1]),data);
 if((x=mat(/^\/api\/users\/(\d+)$/)))return work.setUser(env,u,Number(x[1]),data);
 if((x=mat(/^\/api\/entries\/(\d+)$/)))return work.entryToggle(env,u,Number(x[1]),data);
 if((x=mat(/^\/api\/registrations\/(\d+)$/)))return work.registrationReview(env,u,Number(x[1]),data);
 throw err('找不到提交接口',404);
}
async function getHandler(req,env,u,url){const p=url.pathname;if(p==='/health')return jres({ok:true,service:'lessondesk'});if(p==='/login')return html(authPage('课时本 · 登录',`<form method="post" action="/login">${input('username','用户名','','text',true)}${input('password','密码','','password',true)}${btn('登录')}</form>`));if(p==='/setup'){const n=await one(env.DB,'SELECT count(*) AS n FROM user');if(n?.n)throw err('系统已经初始化',403);return html(authPage('课时本 · 首次初始化',`<p class="ld-muted">部署者先执行 wrangler secret put SETUP_KEY，再在这里创建系统管理员。</p><form method="post" action="/setup">${input('setup_key','部署安全密钥','','password',true)}${input('campus_name','画室名称','我的画室','text',true)}${input('username','管理员用户名','admin','text',true)}${input('password','管理员密码（10 位以上）','','password',true)}${btn('初始化')}</form>`));}
 let x;if((x=match(p,/^\/r\/([A-Za-z0-9_-]{16,100})\/modify$/)))return regModifyPage(env,x[1]);if((x=match(p,/^\/r\/([A-Za-z0-9_-]{16,100})$/)))return regPublic(env,x[1],req,url);if((x=match(p,/^\/p\/([A-Za-z0-9_-]{32,96})$/)))return publicPage(env,x[1]);if((x=match(p,/^\/p\/([A-Za-z0-9_-]{32,96})\/img\/(\d+)$/)))return imageResponse(env,Number(x[2]),x[1],u);
 if((x=match(p,/^\/branding\/(logo|qr)\/(\d+)$/)))return media.mediaResponse(env,x[1],x[2],u);
 requireUser(u);
 // Check whether a mobile upload completed if its response was lost on a weak network.
 // Query only a nonce belonging to the current account; do not expose artwork URLs.
 if((x=match(p,/^\/api\/students\/(\d+)\/upload-state\/([A-Za-z0-9_-]{20,80})$/))){
  const sid=Number(x[1]);await canSeeStudent(env,u,sid,true);
  const found=await one(env.DB,'SELECT 1 AS yes FROM lesson_batch WHERE nonce=? AND operator_id=?','art:'+x[2],u.id);
  return jres({ok:true,completed:Boolean(found)});
 }
 if((x=match(p,/^\/api\/classes\/state\/(\d+)$/))){
  manager(u);
  const group=scoped(u,await one(env.DB,`SELECT id,name,course_id,teacher_id,weekday,start_time,end_time,room,capacity,deduct_lessons,is_archived FROM class_group WHERE id=?`,Number(x[1])));
  return jres({ok:true,group});
 }
 if((x=match(p,/^\/api\/quick\/state\/(\d+)\/(\d+)$/))){
  const g=await canManageGroup(env,u,Number(x[1])),student=await canSeeStudent(env,u,Number(x[2]));
  const en=await one(env.DB,"SELECT 1 AS yes FROM enrollment WHERE student_id=? AND class_group_id=? AND status='active'",student.id,g.id);
  if(!en)throw err('当前学员不在该班级',403);
  const done=await one(env.DB,'SELECT lr.deducted_lessons FROM quick_deduct q LEFT JOIN lesson_record lr ON lr.id=q.lesson_record_id WHERE q.student_id=? AND q.class_group_id=? AND q.local_day=?',student.id,g.id,today(env.TZ));
  return jres({ok:true,remaining:student.lessons_remaining,done:Boolean(done),deduct_lessons:done?.deducted_lessons??g.deduct_lessons});
 }
 if((x=match(p,/^\/avatar\/(\d+)$/)))return media.mediaResponse(env,'avatar',x[1],u);if((x=match(p,/^\/media\/(\d+)$/)))return imageResponse(env,Number(x[1]),null,u);
 if(p==='/')return dashboard(env,u,url);if(p==='/students')return studentsList(env,u,url);if((x=match(p,/^\/students\/(\d+)\/upload$/)))return uploadPage(env,u,Number(x[1]));if((x=match(p,/^\/students\/(\d+)$/)))return studentDetail(env,u,Number(x[1]),req);
 if(p==='/manage')return managePage(env,u);if(p==='/data')return dataPage(env,u);if(p==='/classes')return classesPage(env,u,url);if(p==='/courses')return coursesPage(env,u);if(p==='/records')return recordsPage(env,u,url);if(p==='/finance')return financePage(env,u);if(p==='/users')return usersPage(env,u);if(p==='/campuses')return campusPage(env,u,url);if(p==='/entries')return entriesPage(env,u,req);if(p==='/registrations')return registrationsPage(env,u);if(p==='/profile')return profilePage(env,u);if(p==='/branding')return brandingPage(env,u,url);throw err('页面不存在',404);
}
export default {
 async scheduled(_event,env){
   if(!env.DB)return;
   await batch(env.DB,[
     ['DELETE FROM session WHERE expires_at<?',Math.floor(Date.now()/1000)],
     ['DELETE FROM login_attempt WHERE (kind=\'login\' AND bucket<?) OR (kind=\'public\' AND bucket<?)',Math.floor(Date.now()/900000)-96,Math.floor(Date.now()/60000)-1440]
   ]);
 },
 async fetch(req,env){const url=R(req,env);url.pathname=normalizeRoute(url.pathname);const p=url.pathname;try{
 if((p.startsWith('/css/')||p.startsWith('/vendor/')||p.startsWith('/icons/')||['/app.js','/public.js','/manifest.webmanifest'].includes(p))&&env.ASSETS)return env.ASSETS.fetch(p===new URL(req.url).pathname?req:new Request(url,req));
 if(!env.DB||!env.ARTWORKS||!env.IP_HASH_SECRET)throw err('部署尚未配置 D1、R2 或 IP_HASH_SECRET',503);
 const publicPath=p==='/health'||p==='/login'||p==='/setup'||p.startsWith('/p/')||p.startsWith('/r/')||/^\/branding\/(logo|qr)\/\d+$/.test(p);
 const u=publicPath?null:await currentUser(req,env,url);
 if(req.method==='GET'||req.method==='HEAD')return await getHandler(req,env,u,url);
 if(req.method!=='POST')throw err('不支持的请求方法',405);
 const d=await body(req);const res=await postHandler(req,env,u,url,d);if(res instanceof Response)return res;if(acceptsJson(req))return jres(res);return go(res);
 }catch(ex){const status=ex.status||(/constraint|FOREIGN KEY|UNIQUE/i.test(String(ex))?409:500);const incident=randomToken(4);const msg=status>=500?'系统暂时未能完成操作，请核对余额/记录。故障编号：'+incident:ex.message||'操作失败';if(status>=500)console.error('request_error',incident,p.replace(/\/(p|r)\/[A-Za-z0-9_-]{16,100}/g,'/$1/:token'),String(ex),ex?.stack||'');if(acceptsJson(req))return jres({ok:false,error:msg,incident_id:status>=500?incident:undefined},status);if(status===401)return html(authPage('请登录课时本',message(msg,'warning')+`<form method="post" action="/login">${input('username','用户名','','text',true)}${input('password','密码','','password',true)}${btn('登录')}</form>`),401);
 if(req.method==='POST')return html(authPage('操作未完成',message(msg,'danger')+`<a class="btn btn-outline-secondary" href="${a(back(req,'/'))}">返回上一页</a>`),status);return html(authPage(status===404?'页面不存在':'暂时无法访问',message(msg,status===404?'warning':'danger')+`<a href="/">返回首页</a>`),status);
 }} };
