const {Socket}=require('node:net');
const {createInterface}=require('node:readline');
const {createVideoPipeSink}=require('./video-pipe.cjs');
const assert=require('node:assert/strict');
const sink=createVideoPipeSink(new Socket({fd:3,readable:true,writable:true}));
const width=640,height=480,pixels=Buffer.alloc(width*height*3/2);
const colors=[[16,128,128],[235,128,128],[81,90,240],[41,240,110]];
for(let y=0;y<height;y++)for(let x=0;x<width;x++)pixels[y*width+x]=colors[Math.floor(x/160)][0];
for(let y=0;y<height/2;y++)for(let x=0;x<width/2;x++) {
  const color=colors[Math.floor(x/80)];pixels[width*height+y*width/2+x]=color[1];pixels[width*height*5/4+y*width/2+x]=color[2];
}
let sequence=0n,chain=Promise.resolve();
async function command(value){
  if(value==='frame'){await sink.render({format:'I420',width,height,pixels,sequence:++sequence});console.log('PASS real inherited pipe + renderer ACK');}
  else if(value==='clear'){await sink.clear();console.log('PASS display clear ACK');}
  else if(value==='reopen') {
    await assert.rejects(sink.render({format:'I420',width,height,pixels,sequence:sequence+1n}),/canceled/);
    await sink.clear();await command('frame');console.log('PASS user cancel -> clear -> new call on same display pipe');
  }
  else if(value==='quit'){sink.close();process.exit(0);}
}
function enqueue(value){chain=chain.then(()=>command(value)).catch(()=>{console.error('FAIL display fixture');sink.close();process.exitCode=1;process.stdin.destroy();});}
enqueue('frame');
createInterface({input:process.stdin}).on('line',enqueue).on('close',()=>sink.close());
