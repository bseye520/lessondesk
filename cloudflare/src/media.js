import {one,run,randomToken,err,field,logLine} from './lib.js';
import {manager,scoped} from './auth.js';
import {safeImageInfo,contentTypeFromKey} from './workflows.js';

function validId(value){const n=Number(value);if(!Number.isSafeInteger(n)||n<=0)throw err('无效编号');return n;}
async function validateImage(data,fieldName){
 const photo=data.get(fieldName);
 if(!photo||typeof photo.arrayBuffer!=='function'||photo.size<100||photo.size>2*1024*1024)throw err('请选择照片并等待手机压缩完成（最大 2MB）');
 const bytes=new Uint8Array(await photo.arrayBuffer());
 const image=safeImageInfo(bytes);
 if(!image)throw err('图片格式或安全校验失败，请使用页面重新选择图片');
 return image;
}
export async function saveAvatar(env,u,data){
 const image=await validateImage(data,'photo'),{bytes}=image,key=`profiles/${u.id}/${randomToken(16)}.${image.extension}`;
 const old=await one(env.DB,'SELECT avatar_key FROM account_profile WHERE user_id=?',u.id);
 await env.ARTWORKS.put(key,bytes,{httpMetadata:{contentType:image.contentType}});
 try{await run(env.DB,"INSERT INTO account_profile(user_id,avatar_key,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET avatar_key=excluded.avatar_key,updated_at=CURRENT_TIMESTAMP",u.id,key);}catch(ex){await env.ARTWORKS.delete(key);throw ex;}
 if(old?.avatar_key)await env.ARTWORKS.delete(old.avatar_key).catch(()=>{});
 return {ok:true,redirect:'/profile'};
}
export async function saveBrand(env,u,data){
 manager(u);const campus=u.role==='super_admin'?validId(field(data,'campus_id')):u.campus_id;
 if(u.role!=='super_admin'&&campus!==u.campus_id)throw err('无权管理其他校区',403);
 const row=await one(env.DB,'SELECT * FROM campus WHERE id=?',campus);
 if(!row)throw err('校区不存在',404);
 if(!row.is_active)throw err('校区已停用');
 const info={studio_name:field(data,'studio_name').slice(0,100),slogan:field(data,'slogan').slice(0,300),address:field(data,'address').slice(0,250),contact:field(data,'contact').slice(0,120)};
 await run(env.DB,`INSERT INTO campus_brand(campus_id,studio_name,slogan,address,contact,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)
 ON CONFLICT(campus_id) DO UPDATE SET studio_name=excluded.studio_name,slogan=excluded.slogan,address=excluded.address,contact=excluded.contact,updated_at=CURRENT_TIMESTAMP`,campus,info.studio_name,info.slogan,info.address,info.contact);
 await run(env.DB,'INSERT INTO operation_log(user_id,target,target_id,action,detail) VALUES(?,?,?,?,?)',u.id,'campus',campus,'brand_text_update','update studio display');
 return {ok:true,redirect:`/branding?campus_id=${campus}`};
}
export async function saveBrandAsset(env,u,data,type){
 manager(u);if(!['logo','qr'].includes(type))throw err('无效图片类型');
 const campus=u.role==='super_admin'?validId(field(data,'campus_id')):u.campus_id;
 if(u.role!=='super_admin'&&campus!==u.campus_id)throw err('无权管理其他校区',403);
 const record=await one(env.DB,'SELECT * FROM campus WHERE id=?',campus);if(!record)throw err('校区不存在',404);
 const image=await validateImage(data,'photo'),{bytes}=image,column=type==='logo'?'logo_key':'qr_key';
 const before=await one(env.DB,`SELECT ${column} AS old_key FROM campus_brand WHERE campus_id=?`,campus);
 const key=`branding/${campus}/${type}/${randomToken(16)}.${image.extension}`;
 await env.ARTWORKS.put(key,bytes,{httpMetadata:{contentType:image.contentType}});
 try{
   await run(env.DB,`INSERT INTO campus_brand(campus_id,${column},updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(campus_id) DO UPDATE SET ${column}=excluded.${column},updated_at=CURRENT_TIMESTAMP`,campus,key);
 }catch(ex){await env.ARTWORKS.delete(key);throw ex;}
 if(before?.old_key)await env.ARTWORKS.delete(before.old_key).catch(()=>{});
 return {ok:true,redirect:`/branding?campus_id=${campus}`};
}
export async function mediaResponse(env,type,id,u){
 const n=validId(id);let key;
 if(type==='avatar'){
  if(!u)throw err('请先登录',401);
  // Only the account holder or its campus admin/super admin may fetch an avatar.
  const owner=await one(env.DB,'SELECT campus_id FROM user WHERE id=?',n);
  if(!owner)throw err('头像不存在',404);
  if(u.id!==n&&u.role!=='super_admin'&&!(u.role==='manager'&&u.campus_id===owner.campus_id))throw err('无权读取其他账号头像',403);
  key=(await one(env.DB,'SELECT avatar_key FROM account_profile WHERE user_id=?',n))?.avatar_key;
 } else {
  if(!['logo','qr'].includes(type))throw err('无效资源',404);
  key=(await one(env.DB,`SELECT ${type==='logo'?'logo_key':'qr_key'} AS k FROM campus_brand WHERE campus_id=?`,n))?.k;
 }
 if(!key)throw err('图片未设置',404);
 const photo=await env.ARTWORKS.get(key);if(!photo)throw err('图片未找到',404);
 return new Response(photo.body,{status:200,headers:{'Content-Type':contentTypeFromKey(key),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
}
