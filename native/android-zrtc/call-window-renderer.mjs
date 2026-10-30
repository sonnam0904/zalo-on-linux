import {createCanvasVideoRenderer} from './canvas-video-renderer.mjs';
const get=id=>document.getElementById(id);
const videoRenderer=createCanvasVideoRenderer(get('remote'));
const localRenderer=createCanvasVideoRenderer(get('local'));
window.linuxCall.onFrame(frame=>{
  try {
    if(frame.source==='local'){localRenderer.render(frame);get('preview').hidden=false;}
    else {videoRenderer.render(frame);get('remote').hidden=false;document.body.classList.add('with-video');}
  }
  finally {frame.pixels.fill(0);}
},source=>{
  if(source==='local'){localRenderer.clear();get('preview').hidden=true;}
  else {videoRenderer.clear();get('remote').hidden=true;document.body.classList.remove('with-video');}
});
window.addEventListener('pagehide',()=>{videoRenderer.dispose();localRenderer.dispose();},{once:true});
let revision=0,state,busy=true;
let avatarRevision=0;
function setAvatar(url) {
  const image=get('avatar-image'),fallback=get('avatar-fallback'),current=++avatarRevision;
  image.hidden=true;fallback.hidden=false;
  image.onload=()=>{if(current===avatarRevision){image.hidden=false;fallback.hidden=true;}};
  image.onerror=()=>{if(current===avatarRevision){image.hidden=true;fallback.hidden=false;}};
  if(url)image.src=url;else image.removeAttribute('src');
}
function controls() {
  const incoming=state?.kind==='consent',error=state?.kind==='error';
  for(const id of ['end','answer','mic'])get(id).disabled=busy;
  if(incoming || error) get('end').disabled=false;
  if(incoming) get('answer').disabled=false;
  get('camera').disabled=busy || !state?.cameraControl;
}
window.linuxCall.subscribe((id,next)=>{
  revision=id;state=next;busy=state.ready===false;
  get('name').textContent=state.peerName || 'Cuộc gọi Zalo';
  setAvatar(state.peerAvatar);
  const incoming=state.kind==='consent',active=state.kind==='active',error=state.kind==='error';
  get('status').textContent=incoming?(state.video?'Cuộc gọi video đến':'Cuộc gọi thoại đến'):
    state.kind==='preparing'?'Đang chuẩn bị cuộc gọi':state.kind==='dialing'?'Đang đổ chuông':error?'Cuộc gọi bị gián đoạn':state.muted?'Mic đã tắt':'Đang trong cuộc gọi';
  get('answer').hidden=!incoming;
  const answerVideo=incoming && state.video===true,answerLabel=answerVideo?'Trả lời video':'Trả lời';
  get('answer').setAttribute('aria-label',answerLabel);get('answer').title=answerLabel;
  get('answer').toggleAttribute('data-video',answerVideo);
  get('answer-voice').toggleAttribute('hidden',answerVideo);get('answer-video').toggleAttribute('hidden',!answerVideo);
  get('answer-text').toggleAttribute('hidden',!answerVideo);
get('mic').hidden=!active;get('camera').hidden=incoming || error || !state.video;
  const endLabel=incoming?'Từ chối':error?'Đóng':state.kind==='preparing'?'Hủy':'Kết thúc';
  get('end').setAttribute('aria-label',endLabel);get('end').title=endLabel;
  const micLabel=state.muted?'Bật mic':'Tắt mic';
  get('mic').setAttribute('aria-label',micLabel);get('mic').title=micLabel;
  get('mic').setAttribute('aria-pressed',String(state.muted));get('mic-slash').toggleAttribute('hidden',!state.muted);
  const cameraLabel=!state.cameraControl?'Điều khiển camera chưa khả dụng':state.cameraEnabled?'Tắt camera':'Bật camera';
  get('camera').setAttribute('aria-label',cameraLabel);get('camera').title=cameraLabel;
  get('camera').setAttribute('aria-pressed',String(!state.cameraEnabled));
  get('camera-slash').toggleAttribute('hidden',state.cameraEnabled);
  get('duration').hidden=!active;get('error').hidden=!error;controls();tick();
},id=>{if(id===revision){busy=true;controls();}});
for(const [id,action] of [['end','end'],['answer','answer'],['mic','toggle'],['camera','camera']])get(id).addEventListener('click',()=>{
  const incoming=state?.kind==='consent';
  if(!incoming && busy)return;
  busy=true;controls();window.linuxCall.act(revision,action);
});
function tick() {
  if(state?.startedAt==null)return;
  const seconds=Math.max(0,Math.floor((Date.now()-state.startedAt)/1000));
  get('duration').textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
}
const timer=setInterval(tick,1000);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
