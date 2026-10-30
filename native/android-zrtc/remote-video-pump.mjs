import {setTimeout as delay} from 'node:timers/promises';
import {decodeVideoSnapshot} from './video-snapshot.mjs';
const owners=new WeakSet();
// render must finish consuming the owned pixels before resolving. Neither
// callbacks nor this pump may log frame data. Abort is joined before cleanup.
export async function runRemoteVideo(worker,{signal,render,clear,fps=30}) {
  if(!signal || typeof signal.addEventListener!=='function' || typeof render!=='function' ||
    typeof clear!=='function' || !Number.isInteger(fps) || fps<1 || fps>60)
    throw new TypeError('Remote video requires an abort signal and renderer lifecycle');
  if(owners.has(worker))throw new Error('Remote video consumer already active');
  if(signal.aborted)return;
  owners.add(worker);
  let previous=0n,visible=false;
  try {
    while(!signal.aborted) {
      const started=performance.now();
      const reply=await worker.request('videoSnapshot');
      if(signal.aborted)break;
      const frame=decodeVideoSnapshot(reply);
      if(frame) {
        if(frame.sequence<previous)throw new Error('Remote video sequence regressed');
        if(frame.sequence>previous) {
          previous=frame.sequence;visible=true;
          try {await render(frame);} finally {frame.pixels.fill(0);}
        } else frame.pixels.fill(0);
      } else if(visible) {await clear();visible=false;}
      const remaining=Math.max(1,1000/fps-(performance.now()-started));
      try {await delay(remaining,undefined,{signal});}
      catch(error) {if(!signal.aborted)throw error;}
    }
  } finally {
    try {await clear();} finally {owners.delete(worker);}
  }
}
