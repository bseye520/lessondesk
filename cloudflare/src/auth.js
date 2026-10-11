import {all,one,run,batch,randomToken,sha256,ipHash,hashPassword,verifyPassword,err,field,intval,logLine} from './lib.js';

export function cookieName(url){return url.protocol==='https:'?'__Host-ld_session':'ld_session';}
export function sessionCookie(url,raw,maxAge=1209600){return `${cookieName(url)}=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${url.protocol==='https:'?'; Secure':''}`;}
export function getCookie(req,url){let c=req.headers.get('cookie')||'';return c.split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName(url)+'='))?.slice(cookieName(url).length+1)||'';}
export async function currentUser(req,env,url){const raw=getCookie(req,url);if(!/^[a-f0-9]{64}$/.test(raw))return null;const u=await one(env.DB,`SELECT u.*,s.csrf_token,s.token_hash,s.expires_at,c.name AS campus_name,ap.avatar_key,cb.logo_key AS brand_logo_key,cb.studio_name AS brand_studio_name,cb.campus_id AS brand_campus_id FROM session s JOIN user u ON s.user_id=u.id LEFT JOIN campus c ON c.id=u.campus_id LEFT JOIN account_profile ap ON ap.user_id=u.id LEFT JOIN campus_brand cb ON cb.campus_id=COALESCE(u.campus_id,(SELECT id FROM campus ORDER BY id LIMIT 1)) WHERE s.token_hash=? AND s.expires_at>? AND u.is_active=1`,sha256(raw),Math.floor(Date.now()/1000));return u||null;}
export function requireUser(u){if(!u)throw err('请先登录',401);return u;}
export function manager(u){requireUser(u);if(!['manager','super_admin'].includes(u.role))throw err('仅管理员可以操作',403);}
export function superuser(u){if(!u||u.role!=='super_admin')throw err('需要系统管理员权限',403);}
export function campusFilter(u,requested){if(u.role==='super_admin')return Number(requested)||null;return u.campus_id;}
export function scoped(u,record){requireUser(u);if(!record)throw err('找不到相关数据',404);if(u.role!=='super_admin'&&Number(record.campus_id)!==Number(u.campus_id))throw err('无权访问其他校区数据',403);return record;}
export async function canSeeStudent(env,u,sid,write=false){requireUser(u);const s=scoped(u,await one(env.DB,'SELECT * FROM student WHERE id=?',sid));if(u.role==='teacher'){
 const enrolled=await one(env.DB,`SELECT 1 AS yes FROM enrollment e JOIN class_group g ON g.id=e.class_group_id WHERE e.student_id=? AND e.status='active' AND g.teacher_id=? AND g.is_archived=0 LIMIT 1`,sid,u.id);
 if(!enrolled)throw err('该学员不在你的任教班级',403);
 }return s;}
export async function canManageGroup(env,u,gid){requireUser(u);const g=scoped(u,await one(env.DB,'SELECT * FROM class_group WHERE id=?',gid));if(u.role==='teacher'&&(Number(g.teacher_id)!==Number(u.id)||g.is_archived))throw err('不能操作其他教师班级',403);return g;}
export async function issueSession(db,u){const raw=randomToken(32),csrf=randomToken(24);await run(db,'INSERT INTO session(token_hash,user_id,csrf_token,expires_at) VALUES(?,?,?,?)',sha256(raw),u.id,csrf,Math.floor(Date.now()/1000)+1209600);return raw;}
export async function login(env,req,data){const username=field(data,'username'),pw=field(data,'password'),ip=req.headers.get('CF-Connecting-IP')||'local',key=ipHash(ip,env.IP_HASH_SECRET),bucket=Math.floor(Date.now()/900000);
 const block=await one(env.DB,'SELECT fails FROM login_attempt WHERE ip_hash=? AND bucket=?',key,bucket);
 if((block?.fails||0)>=10)throw err('登录尝试过多，15 分钟后再试',429);
 const u=await one(env.DB,'SELECT * FROM user WHERE username=? AND is_active=1',username);
 if(!u||!(await verifyPassword(pw,u.password_hash))){await run(env.DB,`INSERT INTO login_attempt(ip_hash,bucket,fails) VALUES(?,?,1) ON CONFLICT(ip_hash,bucket) DO UPDATE SET fails=fails+1`,key,bucket);throw err('用户名或密码错误',401);}
 await run(env.DB,'DELETE FROM login_attempt WHERE ip_hash=? AND bucket=?',key,bucket);
 return issueSession(env.DB,u);
}
export async function logout(env,u){if(u)await run(env.DB,'DELETE FROM session WHERE token_hash=?',u.token_hash);}
export async function checkCsrf(req,u,data){requireUser(u);const token=req.headers.get('X-CSRF-Token')||field(data,'csrf_token');if(!token||token!==u.csrf_token)throw err('页面安全令牌已过期，请刷新后重试',403);}
export async function bootstrap(env,req,data){const n=await one(env.DB,'SELECT COUNT(*) AS n FROM user');if(n?.n)throw err('系统已初始化，不能再创建初始管理员',403);if(!env.SETUP_KEY||field(data,'setup_key')!==env.SETUP_KEY)throw err('部署密钥不正确',403);const username=field(data,'username');if(!/^[A-Za-z0-9_.-]{3,40}$/.test(username))throw err('用户名需为 3–40 位英文、数字或下划线');const hash=await hashPassword(field(data,'password'));await batch(env.DB,[['INSERT INTO campus(name,code,is_active) VALUES(?,?,1)',field(data,'campus_name').slice(0,100)||'我的画室','MAIN'],['INSERT INTO user(username,password_hash,role,campus_id) VALUES(?,?,?,NULL)',username,hash,'super_admin']]);return true;}
export async function changePassword(env,u,oldPass,newPass){if(!(await verifyPassword(oldPass,u.password_hash)))throw err('原密码不正确');const hash=await hashPassword(newPass);await batch(env.DB,[['UPDATE user SET password_hash=? WHERE id=?',hash,u.id],['DELETE FROM session WHERE user_id=? AND token_hash<>?',u.id,u.token_hash],logLine(u.id,'user',u.id,'change_password')]);}
export async function makeUser(env,u,data){manager(u);const role=field(data,'role');if(!['teacher','manager'].includes(role))throw err('无效的账号角色');if(u.role==='manager'&&role!=='teacher')throw err('校区管理员只能创建教师账号',403);const campus= u.role==='super_admin'?intval(field(data,'campus_id'),1):u.campus_id;const c=await one(env.DB,'SELECT id FROM campus WHERE id=? AND is_active=1',campus);if(!c)throw err('校区无效');const username=field(data,'username');if(!/^[A-Za-z0-9_.-]{3,40}$/.test(username))throw err('用户名需为 3–40 位英文、数字或下划线');const hash=await hashPassword(field(data,'password'));await run(env.DB,'INSERT INTO user(username,password_hash,role,campus_id) VALUES(?,?,?,?)',username,hash,role,campus);}
