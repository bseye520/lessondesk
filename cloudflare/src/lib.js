import { createHash, createHmac, pbkdf2 as nodePbkdf2, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';

export const enc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const attr = enc;
export const uuid = () => crypto.randomUUID();
export const randomToken = (n=32) => [...crypto.getRandomValues(new Uint8Array(n))].map(x=>x.toString(16).padStart(2,'0')).join('');
export const sha256 = v => createHash('sha256').update(String(v)).digest('hex');
export const ipHash = (ip, secret) => createHmac('sha256',secret).update(ip||'unknown').digest('hex');
export const now = () => new Date().toISOString().replace('T',' ').slice(0,19);
export const today = (tz='Asia/Shanghai') => new Intl.DateTimeFormat('sv-SE',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export const weekday = (tz='Asia/Shanghai') => '周'+'日一二三四五六'.charAt(new Date(new Date().toLocaleString('en-US',{timeZone:tz})).getDay());
export const intval = (v,min=0,max=1000000) => {const n=Number(v); return Number.isSafeInteger(n)&&n>=min&&n<=max?n:null;};
export const cents = str => {if(!/^\d{1,9}(\.\d{1,2})?$/.test(String(str)))return null;const [a,b='']=String(str).split('.');return Number(a)*100+Number((b+'00').slice(0,2));};
export const money = n => '¥'+((Number(n)||0)/100).toFixed(2);
export const all = async (db,sql,...args)=>(await db.prepare(sql).bind(...args).all()).results||[];
export const one = async (db,sql,...args)=>db.prepare(sql).bind(...args).first();
export const run = async (db,sql,...args)=>db.prepare(sql).bind(...args).run();
export const batch = async (db, arr)=>db.batch(arr.map(([sql,...params])=>db.prepare(sql).bind(...params)));
export const jres = (value,status=200,headers={}) => new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}});
export const html = (text,status=200,headers={}) => new Response(text,{status,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',...headers}});
export const redirect=(path,status=303,headers={})=>new Response(null,{status,headers:{Location:path,'Cache-Control':'no-store',...headers}});
export const err = (msg='操作失败',status=400)=>Object.assign(new Error(msg),{status});
export const requireVal = (s,name,max=100)=>{const v=String(s??'').trim();if(!v||v.length>max)throw err(`${name}不能为空或太长`);return v;};
export const field = (f,key)=>String(f.get(key)||'').trim();
export const back=(req,fallback='/')=>{const refer=req.headers.get('Referer');if(!refer)return fallback;try{const u=new URL(refer);return u.origin===new URL(req.url).origin?u.pathname+u.search:fallback;}catch{return fallback;}};
export const safePath = path=>path.startsWith('/')&&!path.startsWith('//')?path:'/';
export async function body(req){
 const type=(req.headers.get('content-type')||'').toLowerCase();
 // Quick-deduct/undo/like deliberately send an empty POST with CSRF in headers.
 // Request.formData() throws on an empty POST without a form Content-Type.
 if (!type || !req.body) return new Map();
 if (type.includes('application/json')) {
   if (Number(req.headers.get('content-length'))>100000) throw err('表单太大',413);
   const obj=await req.json();
   if (!obj || Array.isArray(obj) || typeof obj!=='object') throw err('提交数据格式不正确');
   return new Map(Object.entries(obj));
 }
 if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
   // The artwork/profile upload routes validate actual image size separately.
   if(Number(req.headers.get('content-length'))>25*1024*1024)throw err('提交内容超过 25MB',413);
   return req.formData();
 }
 throw err('不支持的提交数据格式',415);
}
export function acceptsJson(req){return (req.headers.get('Accept')||'').includes('application/json');}
export const delay=()=>{};
const asyncPbkdf2=async(pw,salt,n,len,digest)=>{
 // Prefer Workers WebCrypto (also works in modern Node) instead of a Node compatibility thread pool.
 if(crypto.subtle && digest==='sha256'){
   const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveBits']);
   const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:new TextEncoder().encode(salt),iterations:n,hash:'SHA-256'},k,len*8);
   return Buffer.from(bits);
 }
 return new Promise((resolve,reject)=>nodePbkdf2(pw,salt,n,len,digest,(e,r)=>e?reject(e):resolve(r)));
};
const asyncScrypt=(pw,salt,n,r,p,len)=>new Promise((resolve,reject)=>nodeScrypt(pw,salt,len,{N:n,r,p,maxmem:128*n*r+64*1024*1024},(e,b)=>e?reject(e):resolve(b)));
export async function hashPassword(pw){if(typeof pw!=='string'||pw.length<10||pw.length>150)throw err('密码应为 10–150 个字符');const salt=randomToken(16),rounds=100000;const h=await asyncPbkdf2(pw,salt,rounds,32,'sha256');return `pbkdf2:sha256:${rounds}$${salt}$${h.toString('hex')}`;}
export async function verifyPassword(pw,stored){try{
 const [method,salt,hex]=String(stored||'').split('$');if(!hex||!salt||pw.length>500)return false;
 let derived;
 if(method.startsWith('pbkdf2:sha256:')){const rounds=Number(method.split(':')[2]);if(!Number.isSafeInteger(rounds)||rounds<10000||rounds>1500000)return false;derived=await asyncPbkdf2(pw,salt,rounds,Buffer.from(hex,'hex').length,'sha256');}
 else if(method.startsWith('scrypt:')){const [n,r,p]=method.split(':').slice(1).map(Number);if(n>65536||n<16384||r>16||p>4)return false;derived=await asyncScrypt(pw,salt,n,r,p,Buffer.from(hex,'hex').length);}
 else return false;
 const expected=Buffer.from(hex,'hex');return expected.length>0&&expected.length===derived.length&&timingSafeEqual(derived,expected);
 }catch{return false;}}
export function logLine(actor,target,targetId,action,detail=''){return ['INSERT INTO operation_log(user_id,target,target_id,action,detail) VALUES(?,?,?,?,?)',actor||null,target,targetId||null,action,String(detail).slice(0,800)];}
export const safeInt=(x)=>Number.isInteger(Number(x))?Number(x):0;
export const clamp=(x,min,max)=>Math.min(max,Math.max(min,Number(x)||0));
