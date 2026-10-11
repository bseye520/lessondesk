(function(){'use strict';
const csrf=document.body.dataset.csrf||'';
function toast(msg,undo){document.querySelector('.ld-toast')?.remove();let d=document.createElement('div');d.className='ld-toast';d.setAttribute('role','status');let span=document.createElement('span');span.textContent=msg;d.append(span);if(undo){let b=document.createElement('button');b.textContent='撤销这次';b.addEventListener('click',async()=>{b.disabled=true;try{const reason=document.body.dataset.role==='teacher'?'':prompt('请输入撤销原因（必填）');if(reason===null){b.disabled=false;return;}if(document.body.dataset.role!=='teacher'&&!reason?.trim()){b.disabled=false;return toast('撤销需要填写原因');}let r=await fetch(undo,{method:'POST',headers:{'X-CSRF-Token':csrf,'Accept':'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({reason})});let j=await r.json();if(!r.ok||!j.ok)throw Error(j.error||'撤销失败');location.reload();}catch(e){b.disabled=false;toast(e.message);}});d.append(b);}document.body.append(d);setTimeout(()=>d.remove(),15000);}
if(new URLSearchParams(location.search).get('saved')==='1'){toast('✓ 已保存');const url=new URL(location.href);url.searchParams.delete('saved');history.replaceState(null,'',url.pathname+url.search+url.hash);}
document.querySelectorAll('[data-expand]').forEach(b=>b.addEventListener('click',()=>document.querySelectorAll('.roster-class').forEach(g=>g.open=b.dataset.expand==='1')));
async function requestJson(url,options={}){
 const response=await fetch(url,{...options,headers:{'Accept':'application/json','X-CSRF-Token':csrf,...options.headers},cache:'no-store'});
 let json;try{json=await response.json()}catch{throw Error('服务端返回格式异常（HTTP '+response.status+'）')}
 if(!response.ok||!json.ok)throw Error(json.error||'请求失败（HTTP '+response.status+'）');return json;
}
// A student may attend several classes while sharing ONE lesson balance.
// Keep every visible row in sync and recalculate each reference progress bar.
function reconcileStudent(studentId,remaining){
 document.querySelectorAll('.roster-student[data-student-id="'+studentId+'"]').forEach(row=>{
  const label=row.querySelector('.roster-remaining');
  if(label){label.textContent='余 '+remaining+' 节';label.classList.toggle('is-low',remaining<=3)}
  const used=Number(row.dataset.used)||0,total=used+remaining;
  const fraction=row.querySelector('.roster-fraction');if(fraction)fraction.textContent=used+'/'+total;
  const fill=row.querySelector('.roster-track > span');if(fill)fill.style.width=(total?Math.min(100,used/total*100):0)+'%';
  const button=row.querySelector('.js-quick button');
  const qty=Number(row.dataset.deduct)||1;
  if(button&&!row.dataset.pending){
   if(row.dataset.done==='1'){button.disabled=true;button.textContent=row.dataset.trial==='1'?'✓ 已到课':'✓ 今日已消'}
   else {button.disabled=remaining<qty;button.textContent=row.dataset.trial==='1'?'试听到课':remaining<qty?'余额不足':'消 '+qty+' 节'}
  }
 });
}
function markDone(row,yes){row.dataset.done=yes?'1':'0';}
// A bounded wait keeps weak-network buttons from appearing stuck indefinitely.
async function boundedJson(url,options={}){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
 try{return await requestJson(url,{...options,signal:controller.signal})}
 finally{clearTimeout(timer)}
}

document.querySelectorAll('.js-quick').forEach(f=>f.addEventListener('submit',async event=>{
 event.preventDefault();const b=f.querySelector('button'),row=f.closest('.roster-student'),g=f.closest('.roster-class');
 if(b.disabled)return;row.dataset.pending='1';b.disabled=true;b.textContent='处理中…';
 const stateUrl='/api/quick/state/'+g.dataset.classId+'/'+row.dataset.studentId;
 try{
  const j=await boundedJson(f.action,{method:'POST'});
  row.dataset.used=String((Number(row.dataset.used)||0)+j.deducted);markDone(row,true);
  delete row.dataset.pending;reconcileStudent(row.dataset.studentId,j.remaining);
  toast(j.deducted===0?'试听到课已记录':('已消 '+j.deducted+' 节 · 剩 '+j.remaining+' 节'),j.undo);
 }catch(ex){
  // Reconcile a lost response with authoritative D1 state, never blindly resubmit.
  b.textContent='正在核对…';
  try{
   const st=await boundedJson(stateUrl);
   // Current server state includes today's quick lesson in the used-reference total.
   if(st.done && row.dataset.done!=='1')row.dataset.used=String((Number(row.dataset.used)||0)+st.deduct_lessons);
   markDone(row,st.done);delete row.dataset.pending;
   reconcileStudent(row.dataset.studentId,st.remaining);
   if(st.done)toast('已核对：今天的到课记录已保存，剩余 '+st.remaining+' 节');
   else toast('未查到今天的快捷消课：'+ex.message+'。请确认后再操作');
  }catch{delete row.dataset.pending;b.textContent='刷新核对';b.disabled=true;toast(ex.message+'；网络核对失败，请刷新后先查看余额，勿重复点击');}
 }
}));
// Creating a class across multiple campuses: never present course/teacher choices
// from a different campus. The API still enforces this server-side.
const createClass=document.querySelector('form[action="/api/classes"]');
if(createClass){
 const campus=createClass.querySelector('select[name="campus_id"]');
 const course=createClass.querySelector('select[name="course_id"]');
 const teacher=createClass.querySelector('select[name="teacher_id"]');
 if(campus&&course&&teacher){
  const filter=()=>{const wanted=campus.value;
   for(const select of [course,teacher]){
    let visibleSelected=false,first='';
    for(const opt of select.options){
     const show=!opt.value || !opt.dataset.campus || opt.dataset.campus===wanted;
     opt.hidden=!show;opt.disabled=!show;
     if(show&&!first)first=opt.value;
     if(show&&opt.selected)visibleSelected=true;
    }
    if(!visibleSelected)select.value=first;
   }
  };campus.addEventListener('change',filter);filter();
 }
}
// Keep class forms on the page if the Worker rejects a teacher assignment.
document.querySelectorAll('form[action^="/api/classes/"]').forEach(f=>f.addEventListener('submit',async event=>{
 event.preventDefault();if(f.classList.contains('ld-save-working'))return;
 const b=f.querySelector('button[type="submit"]'),old=b?.textContent||'保存';
 f.querySelector('.ld-inline-error')?.remove();f.classList.add('ld-save-working');if(b)b.textContent='正在保存…';
 try{await requestJson(f.action,{method:'POST',body:new FormData(f)});if(b)b.textContent='✓ 已保存';toast('班级信息保存成功');const hash=f.closest('[id^="class-"]')?.id||'';setTimeout(()=>{location.assign('/classes'+(hash?'#'+hash:''))},450)}
 catch(ex){
  let verified=false;
  try{
   const id=f.action.match(/\/api\/classes\/(\d+)$/)?.[1];
   if(id){const live=await boundedJson('/api/classes/state/'+id),submitted=new FormData(f);
    verified=['name','course_id','teacher_id','weekday','start_time','end_time','room','capacity','deduct_lessons','is_archived'].every(key=>String(live.group[key]??'')===String(submitted.get(key)??''));}
  }catch{}
  if(verified){toast('已向数据库核对：保存成功');if(b)b.textContent='✓ 已保存';location.reload();}
  else{const d=document.createElement('div');d.className='ld-inline-error';d.setAttribute('role','alert');d.textContent='保存未确认：'+ex.message+'。请勿连续重复提交。';f.prepend(d);d.scrollIntoView({behavior:'smooth',block:'nearest'});if(b)b.textContent=old;}
 }
 finally{f.classList.remove('ld-save-working')}
}));
async function decodePhoto(file){
 try{if(typeof createImageBitmap==='function')return await createImageBitmap(file)}catch{}
 const url=URL.createObjectURL(file);const img=new Image();
 try{img.src=url;await img.decode();return {width:img.naturalWidth,height:img.naturalHeight,source:img,close(){URL.revokeObjectURL(url)}};}
 catch(ex){URL.revokeObjectURL(url);throw ex;}
}
function drawable(photo){return photo.source||photo}

// Convert via Canvas so original EXIF/GPS never reaches the Worker.
// WebKit may display WebP without supporting WebP canvas encoding; use JPEG fallback.
async function encodeCanvasPhoto(decoded,{maxBytes=2*1024*1024,largest=1600}={}){
 const src=drawable(decoded);const original=Math.max(decoded.width,decoded.height);
 if(!original||original>20000)throw Error('图片尺寸异常，请换一张照片');
 let webpSupported=true;
 const variants=[[largest,.78],[Math.min(largest,1400),.71],[1100,.63],[850,.58]];
 for(const [limit,quality] of variants){
  const ratio=Math.min(1,limit/original),canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(decoded.width*ratio));canvas.height=Math.max(1,Math.round(decoded.height*ratio));
  const ctx=canvas.getContext('2d',{alpha:false});if(!ctx)throw Error('当前浏览器无法处理照片');
  ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(src,0,0,canvas.width,canvas.height);
  const blobOf=(type)=>new Promise(resolve=>{try{canvas.toBlob(resolve,type,quality)}catch{resolve(null)}});
  if(webpSupported){const webp=await blobOf('image/webp');
   if(webp?.type==='image/webp'&&webp.size<=maxBytes)return webp;
   if(!webp||webp.type!=='image/webp')webpSupported=false;
  }
  const jpeg=await blobOf('image/jpeg');
  if(jpeg?.type==='image/jpeg'&&jpeg.size<=maxBytes)return jpeg;
 }
 throw Error('图片处理后仍超过 2MB，请换一张或裁剪后重试');
}
function encodedFilename(blob,prefix='image'){return prefix+(blob.type==='image/jpeg'?'.jpg':'.webp');}

// Compress profile/logo/QR images and strip EXIF data client-side.

// Balance adjustment and payment registration are separate forms by design.
// Preview is advisory only: the Worker validates every submitted amount again.
document.querySelectorAll('form.js-balance-form').forEach(f=>{
 const preview=f.querySelector('.ld-balance-preview');
 const deltaInput=f.querySelector('input[name="delta"]');
 const updatePreview=()=>{
  if(!preview||!deltaInput)return;
  const before=Number(preview.dataset.original),raw=deltaInput.value.trim(),n=Number(raw);
  if(raw===''){preview.textContent=`当前余额 ${before} 节 · 请输入调整值`;return;}
  if(!Number.isSafeInteger(n)||n===0||Math.abs(n)>10000){preview.textContent='请输入非零整数，例如 12 或 -2';return;}
  const after=before+n;
  preview.textContent=after<0?`当前余额 ${before} 节 · 扣减后不能为负数`:`当前 ${before} 节 → 预计 ${after} 节（${n>0?'+':''}${n}）`;
 };
 deltaInput?.addEventListener('input',updatePreview);
 f.addEventListener('submit',async event=>{
  event.preventDefault();if(f.dataset.pending==='1')return;
  f.querySelector('.ld-inline-error')?.remove();
  if(!f.reportValidity())return;
  const data=new FormData(f),kind=String(data.get('type')||'');
  if(kind==='adjust'){
   const n=Number(data.get('delta')),before=Number(preview?.dataset.original);
   if(!Number.isSafeInteger(n)||n===0||n>10000||n< -10000)return displayError('请输入不为 0 的整数课时');
   if(before+n<0)return displayError(`余额只有 ${before} 节，不能扣减 ${Math.abs(n)} 节`);
  }else if(kind==='charge'){
   if(Number(data.get('lessons'))+Number(data.get('bonus'))<=0)return displayError('购买课时和赠送课时不能同时为 0');
  }
  const button=f.querySelector('button[type="submit"]'),original=button?.textContent||'提交';
  f.dataset.pending='1';if(button){button.disabled=true;button.textContent='正在保存…';}
  try{
   const result=await boundedJson(f.action,{method:'POST',body:data});
   toast('课时已保存，正在刷新余额');location.assign(result.redirect||location.pathname);
  }catch(ex){
   const network=ex.name==='AbortError'||ex instanceof TypeError;
   displayError(ex.message+(network?'。若网络中断，请刷新并核对余额及流水后再提交，避免重复操作。':''));
   if(button){button.disabled=false;button.textContent=original;}
  }finally{delete f.dataset.pending;}
  function displayError(msg){
   const alert=document.createElement('div');alert.className='ld-inline-error';
   alert.setAttribute('role','alert');alert.textContent=msg;
   f.append(alert);alert.scrollIntoView({block:'nearest',behavior:'smooth'});
  }
 });
});

document.querySelectorAll('.js-media-form').forEach(form=>form.addEventListener('submit',async event=>{
 event.preventDefault();const button=form.querySelector('button[type="submit"]'),file=form.querySelector('input[type="file"]')?.files?.[0];
 if(!file)return toast('请先选择图片');if(file.size>20*1024*1024)return toast('图片原件不能超过 20MB');
 button.disabled=true;button.textContent='正在压缩并上传…';
 try{
  const img=await decodePhoto(file);let compressed;
  try{compressed=await encodeCanvasPhoto(img);}finally{img.close?.();}
  const fd=new FormData(form);fd.set('photo',compressed,encodedFilename(compressed));const result=await requestJson(form.action,{method:'POST',body:fd});toast('图片上传成功');location.href=result.redirect||location.pathname;
 }catch(e){button.disabled=false;button.textContent='重新上传';toast(e.message);}
}));
document.querySelectorAll('[data-confirm]').forEach(f=>f.addEventListener('submit',ev=>{if(!f.dataset.confirmed){ev.preventDefault();f.dataset.confirmed='1';const b=f.querySelector('button[type="submit"]');if(b)b.textContent='再次点击确认';setTimeout(()=>{f.dataset.confirmed='';if(b)b.textContent='确认操作'},5000);}}));
// Artwork upload: let the teacher explicitly choose camera OR gallery.
// Preprocess the photo once at selection time, then transmit only compressed WebP.
const artForm=document.getElementById('art-form');
if(artForm){
 const gallery=document.getElementById('art-file'),camera=document.getElementById('art-camera');
 const submit=artForm.querySelector('button[type="submit"]'),preview=document.getElementById('art-preview');
 const selected=document.getElementById('art-selected'),wrap=document.getElementById('art-progress-wrap');
 const progress=document.getElementById('art-progress'),status=document.getElementById('art-upload-status');
 const view=document.getElementById('art-view'),again=document.getElementById('art-again');
 const diagnostics=document.getElementById('art-diagnostics'),metrics=document.getElementById('art-metrics');
 let prepared=null,previewURL=null,generation=0,inFlight=false,completed=false,prepareMs=0;
 const report=(message,percent)=>{wrap.hidden=false;status.textContent=message;if(percent!==undefined)progress.value=percent;};
 function formatSize(n){return n<1024*1024?Math.round(n/1024)+' KB':(n/1024/1024).toFixed(2)+' MB';}
 async function compressArtwork(file){
  if(!file||(!file.type.startsWith('image/')&&!/\.(heic|heif)$/i.test(file.name)))throw Error('请选择图片文件');
  if(file.size>25*1024*1024)throw Error('原照片超过 25MB，请在相册中缩小再试');
  const decoded=await decodePhoto(file);
  try{return await encodeCanvasPhoto(decoded);}finally{decoded.close?.();}
 }
 async function choose(input){
  const file=input.files?.[0];if(!file)return;
  const seq=++generation;prepared=null;artForm.dataset.state='preparing';submit.disabled=true;submit.textContent='照片处理中…';
  if(previewURL){URL.revokeObjectURL(previewURL);previewURL=null;}
  preview.removeAttribute('src');preview.hidden=true;
  selected.textContent='正在处理 '+file.name+'（'+formatSize(file.size)+'）…';report('正在手机本地压缩照片，不会上传原图。',0);
  const begin=performance.now();
  try{
   const blob=await compressArtwork(file);if(seq!==generation)return;
   prepareMs=Math.round(performance.now()-begin);prepared=blob;
   previewURL=URL.createObjectURL(blob);preview.src=previewURL;preview.hidden=false;
   selected.textContent='已选照片 · '+formatSize(file.size)+' → '+formatSize(blob.size)+'（'+(blob.type==='image/jpeg'?'JPEG':'WebP')+'）';
   status.textContent='图片已准备好，点击「上传作品」即可提交。';wrap.hidden=true;
   artForm.dataset.state='ready';submit.disabled=false;submit.textContent='上传作品';
  }catch(ex){if(seq!==generation)return;artForm.dataset.state='error';selected.textContent=ex.message;status.textContent='';wrap.hidden=true;submit.disabled=true;submit.textContent='请重新选图';}
 }
 gallery?.addEventListener('change',()=>{if(camera)camera.value='';choose(gallery);});
 camera?.addEventListener('change',()=>{if(gallery)gallery.value='';choose(camera);});
 function sendArtwork(data,onProgress){return new Promise((resolve,reject)=>{
  const xhr=new XMLHttpRequest();xhr.open('POST',artForm.action,true);xhr.withCredentials=true;xhr.timeout=90000;
  xhr.setRequestHeader('Accept','application/json');xhr.setRequestHeader('X-CSRF-Token',csrf);
  xhr.upload.onprogress=e=>{if(e.lengthComputable)onProgress(Math.min(100,Math.round(100*e.loaded/e.total)));};
  xhr.onload=()=>{let j;try{j=JSON.parse(xhr.responseText)}catch{reject(Error('服务器返回了非 JSON 响应（HTTP '+xhr.status+'）'));return;}
   if(xhr.status<200||xhr.status>=300||!j.ok){const ex=Error(j?.error||'上传失败（HTTP '+xhr.status+'）');ex.httpStatus=xhr.status;reject(ex);return;}resolve(j);
  };
  xhr.onerror=()=>reject(Error('上传连接中断'));xhr.ontimeout=()=>reject(Error('上传超时（90 秒）'));
  xhr.onabort=()=>reject(Error('上传已中断'));xhr.send(data);
 });}
 async function verifyUpload(nonce){
  const matched=artForm.action.match(/\/students\/(\d+)\/upload$/);if(!matched)return false;
  const endpoint='/api/students/'+matched[1]+'/upload-state/'+encodeURIComponent(nonce);
  for(let i=0;i<4;i++){
   try{const result=await requestJson(endpoint);if(result.completed)return true;}catch{}
   if(i<3)await new Promise(resolve=>setTimeout(resolve,1200));
  }return false;
 }
 artForm.addEventListener('submit',async ev=>{
  ev.preventDefault();if(inFlight||completed)return;if(!prepared)return toast('请先拍照或从相册选择照片，并等待压缩完成');
  inFlight=true;artForm.dataset.state='uploading';submit.disabled=true;submit.textContent='上传中…';
  const data=new FormData(artForm),nonce=String(data.get('upload_nonce')||'');
  data.set('photo',prepared,encodedFilename(prepared,'artwork'));
  const started=performance.now();let transferDone=null;
  report('正在传输 '+formatSize(prepared.size)+' 的压缩图片…',0);
  try{
   const j=await sendArtwork(data,n=>{
    if(n===100&&transferDone===null)transferDone=performance.now();
    report(n===100?'文件已发出，正在等待 R2 保存及 D1 登记…':`上传图片：${n}%`,n);
   });
   const elapsed=Math.round(performance.now()-started),m=j.upload_metrics||{};
   const message=`手机处理 ${prepareMs}ms，整次请求 ${elapsed}ms，R2 ${m.r2_ms??'?'}ms，D1 ${m.d1_ms??'?'}ms`;
   if(metrics)metrics.textContent=message;if(diagnostics)diagnostics.hidden=false;
   report('✓ 作品已上传成功',100);
   completed=true;artForm.dataset.state='complete';gallery.disabled=true;camera.disabled=true;submit.textContent='✓ 上传成功';view.hidden=false;again.hidden=false;
   // Stay on the lightweight confirmation instead of automatically loading the full student gallery.
  }catch(ex){
   if(ex.httpStatus>=400&&ex.httpStatus<500){artForm.dataset.state='ready';report('上传失败：'+ex.message,progress.value);submit.disabled=false;submit.textContent='重试上传';return;}
   report('请求未确认，正在检查作品是否已经保存；请勿重复点击上传。',progress.value);
   if(await verifyUpload(nonce)){
    const message='已从数据库确认：作品上传成功，可能只是返回消息在网络中断时丢失。';
    report(message,100);completed=true;artForm.dataset.state='complete';gallery.disabled=true;camera.disabled=true;submit.textContent='✓ 已确认上传成功';view.hidden=false;again.hidden=false;
   }else{
    report(ex.message+'；未确认是否已写入。请先打开「查看现有作品」核对，避免重复上传。',progress.value);
    artForm.dataset.state='uncertain';view.hidden=false;submit.textContent='请先核对作品';gallery.disabled=true;camera.disabled=true;
    toast('上传状态不明确；不要重复提交，先到作品列表核对。');
   }
  }finally{inFlight=false;}
 });
 window.addEventListener('pagehide',()=>{if(previewURL)URL.revokeObjectURL(previewURL);});
}
try{const info=sessionStorage.getItem('ld-last-upload');if(info){sessionStorage.removeItem('ld-last-upload');toast(info);}}catch{}
const share=document.getElementById('share-url');if(share)document.getElementById('copy-share')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(share.value);toast('分享链接已复制')}catch{share.select();toast('请手动复制选中的链接')}});
})();
