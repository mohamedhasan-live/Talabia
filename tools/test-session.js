'use strict';
/* Sign in through the real app, quit, start again: the session must survive a restart. */
// sign in through the real app, quit, start again: still signed in?
const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
const ROOT=path.join(__dirname,'..'); const {startMock}=require(ROOT+'/tools/mock-supabase');
const ELECTRON=require(ROOT+'/node_modules/electron'); const EXE=process.env.DAFTAR_EXE;
const PROFILE=fs.mkdtempSync(path.join(os.tmpdir(),'persist-')); const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let PORT=9400+Math.floor(Math.random()*300);
async function run(m, fn){
  const args=['--user-data-dir='+PROFILE,'--remote-debugging-port='+PORT,'--password-store=basic'];
  const env=Object.assign({},process.env,{DAFTAR_CLOUD_URL:m.url,DAFTAR_CLOUD_KEY:'k'});
  const p=EXE?spawn(EXE,args,{env}):spawn(ELECTRON,['.'].concat(args),{cwd:ROOT,env});
  let t; for(let i=0;i<80;i++){try{t=(await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json()).find(x=>x.type==='page');if(t)break}catch(e){} await sleep(400)}
  const ws=new WebSocket(t.webSocketDebuggerUrl); let id=0; const w=new Map();
  ws.onmessage=e=>{const x=JSON.parse(e.data); if(x.id&&w.has(x.id)){w.get(x.id)(x);w.delete(x.id)}}; await new Promise(r=>ws.onopen=r);
  const ev=async x=>{const n=++id; const r=await new Promise(res=>{w.set(n,res);ws.send(JSON.stringify({id:n,method:'Runtime.evaluate',params:{expression:x,awaitPromise:true,returnByValue:true}}))}); return r.result.result.value};
  for(let i=0;i<60;i++){ if(await ev('!!(window.S&&S.ready&&S.cloud)')) break; await sleep(300) }
  const out=await fn(ev);
  // Close the window as a person would. Killing the process outright on a fresh
  // profile never writes Chromium's "Local State", where the key that encrypts
  // the saved session lives, so the next run could not read it — the test was
  // failing on its own kill, not on the app.
  const exited=new Promise(r=>p.on('exit',r));
  try{ await ev('window.close()') }catch(e){}
  await Promise.race([exited,sleep(10000)]);
  ws.close(); try{p.kill()}catch(e){} await sleep(1500); PORT++; return out;
}
(async()=>{
  const m=await startMock({key:'k'}); m.addUser('owner@shop.sa','Owner-pass-1');
  const r1=await run(m, async ev=>{
    // sign in the way a person does: the sign-in screen every device shows first
    for(let i=0;i<40;i++){ if(await ev('!!(document.getElementById("gate")&&!document.getElementById("gate").hidden&&!document.getElementById("gateForm").hidden)')) break; await sleep(300) }
    await ev('document.getElementById("gateEmail").value="owner@shop.sa";document.getElementById("gatePass").value="Owner-pass-1";document.getElementById("gateBtn").click()');
    for(let i=0;i<40;i++){ if(await ev('!!(S.cloud&&S.cloud.status==="ok")')) break; await sleep(300) }
    return await ev('JSON.stringify({status:S.cloud.status, signed:S.cloudSet&&S.cloudSet.auth&&S.cloudSet.auth.signedIn, stored:S.cloudSet&&S.cloudSet.auth&&S.cloudSet.auth.stored})');
  });
  console.log('first run :', r1, ' session file:', fs.existsSync(path.join(PROFILE,'cloud-session.bin')));
  const r2=await run(m, async ev=>{
    for(let i=0;i<40;i++){ if(await ev('!!(S.cloud&&S.cloud.status==="ok")')) break; await sleep(300) }
    return await ev('JSON.stringify({status:S.cloud.status, signed:S.cloudSet&&S.cloudSet.auth&&S.cloudSet.auth.signedIn, email:S.cloudSet&&S.cloudSet.auth&&S.cloudSet.auth.email})');
  });
  console.log('after restart:', r2);
  const ok=JSON.parse(r2).signed===true && JSON.parse(r2).status==='ok';
  console.log(ok?'PASS  stays signed in after restart':'FAIL  signed out after restart');
  await m.close(); process.exit(ok?0:1);
})();
