import {spawn} from 'node:child_process';
// Use GTK window controls and explicit buttons. Never put account/session data
// in process arguments or interpret remote strings as markup.
export function callDialog(kind,{video=false,signal,muteControl=false,muted=false},launch=spawn) {
  if(!['consent','active','error','dialing'].includes(kind) || !signal || typeof signal.addEventListener!=='function')
    return Promise.reject(new Error('Invalid native call dialog'));
  if(signal.aborted)return Promise.reject(new Error('Call dialog canceled'));
  const args=kind==='dialing'?['--info','--title=Zalo — Cuộc gọi đi','--no-markup',
    '--text=Đang gọi… Chờ bên kia trả lời.','--ok-label=Kết thúc']:kind==='error'?['--error','--title=Zalo — Cuộc gọi bị gián đoạn','--no-markup',
    '--text=Không thể tiếp tục cuộc gọi. Hãy kiểm tra kết nối mạng và thiết bị mic, loa'+(video?', camera':'')+' rồi thử lại.',
    '--ok-label=Đóng','--timeout=15']:kind==='consent'?['--question','--title=Zalo — Cuộc gọi đến','--no-markup',
    `--text=${video?'Cuộc gọi video đến':'Cuộc gọi thoại đến'}`,'--ok-label=Trả lời','--cancel-label=Bỏ qua']:
    muteControl?['--question','--title=Zalo — Cuộc gọi','--no-markup',
      `--text=${muted?'Mic đã tắt — bên kia không nghe tiếng từ mic.':'Mic đang bật.'}`,
      `--ok-label=${muted?'Bật mic':'Tắt mic'}`,'--cancel-label=Kết thúc']:
    ['--info','--title=Zalo — Cuộc gọi','--no-markup','--text=Đã trả lời. Bạn có thể kết thúc cuộc gọi tại đây.','--ok-label=Kết thúc'];
  return new Promise((resolve,reject)=>{
    let child,timer,failed=false;
    const abort=()=>{child?.kill('SIGTERM');timer??=setTimeout(()=>child?.kill('SIGKILL'),1000);};
    const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};
    try {child=launch('zenity',args,{stdio:'ignore'});}catch {reject(new Error('Native call dialog unavailable'));return;}
    child.once('error',()=>{failed=true;});
    child.once('close',code=>{
      cleanup();
      if(signal.aborted)reject(new Error('Call dialog canceled'));
      else if(failed || ![0,1,...(kind==='error'?[5]:[])].includes(code))reject(new Error('Native call dialog unavailable'));
      else resolve(kind==='consent'?code===0:kind==='active' && muteControl?(code===0?'toggle':'end'):true);
    });
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  });
}
// One command at a time; the next dialog only reflects acknowledged state.
// Joining the in-flight request on cancellation prevents worker teardown from
// racing a queued mute command. Native request timeout bounds this wait.
// Reports acknowledged mic/camera state so the peer UI can follow it.
let mediaStateReporter=null;
export function setMediaStateReporter(fn) {mediaStateReporter=typeof fn==='function'?fn:null;}
export async function activeCallControls(worker,{video=false,signal,cameraControl},dialog=callDialog) {
  let muted=false,cameraEnabled=true;
  const report=()=>{try{Promise.resolve(mediaStateReporter?.({video,muted,cameraEnabled})).catch(()=>{});}catch{}};
  while(!signal.aborted) {
    const action=await dialog('active',{video,signal,muteControl:true,muted,cameraControl:!!cameraControl,cameraEnabled});
    if(signal.aborted || action==='end')return;
    if(action==='camera' && video && cameraControl) {
      try {await cameraControl.setEnabled(!cameraEnabled);}
      catch {if(signal.aborted)return;throw new Error('Camera control unavailable');}
      if(signal.aborted)return;
      cameraEnabled=!cameraEnabled;report();continue;
    }
    if(action!=='toggle')throw new Error('Invalid native call control');
    let reply;
    try {reply=await worker.request('microphoneMute',{muted:!muted});}
    catch {if(signal.aborted)return;throw new Error('Microphone control unavailable');}
    if(signal.aborted)return;
    if(reply?.code!==0)throw new Error('Microphone control unavailable');
    muted=!muted;report();
  }
}
