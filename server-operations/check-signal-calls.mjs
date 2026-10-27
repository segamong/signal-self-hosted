// End-to-end call signaling between two disposable accounts owned by this test.
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const require=createRequire('/opt/signal/app/package.json');
const WebSocket=require('ws');
const {RoomServiceClient}=require('livekit-server-sdk');
const HOST='signal-on.ru',IP='177.3.212.182';
const directory=process.argv[2];
if(!directory?.startsWith('/root/signal-call-check-'))throw Error('Unexpected state directory');
mkdirSync(directory,{recursive:true,mode:0o700});
const state={users:[],channels:[],calls:[]};
const save=()=>writeFileSync(join(directory,'state.json'),JSON.stringify(state),{mode:0o600});
const report={};
const lookup=(host,options,callback)=>{if(typeof options==='function'){callback=options;options={};}callback(null,options?.all?[{address:IP,family:4}]:IP,4);};
function request(client,path,body){return new Promise((resolve,reject)=>{
 const data=body===undefined?null:Buffer.from(JSON.stringify(body));
 const req=https.request({hostname:HOST,port:443,path:'/api'+path,method:data?'POST':'GET',lookup,
  headers:{Origin:'https://'+HOST,Accept:'application/json',...(client.cookie?{Cookie:client.cookie}:{}),...(data?{'Content-Type':'application/json','Content-Length':data.length}:{})}},res=>{
  const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{
   const cookie=res.headers['set-cookie']?.find(c=>c.startsWith('signal_session='));
   if(cookie)client.cookie=cookie.split(';',1)[0];
   let parsed={};try{parsed=JSON.parse(Buffer.concat(chunks).toString());}catch{}
   resolve({status:res.statusCode,data:parsed});
  });
 });req.setTimeout(12000,()=>req.destroy(Error('API timeout')));req.on('error',reject);if(data)req.write(data);req.end();
});}
function ensure(result,status,stage){if(result.status!==status){report.failedStage=stage;report.httpStatus=result.status;report.serverError=String(result.data?.error||'').slice(0,220);throw Error(stage);}}
function events(client){return new Promise((resolve,reject)=>{
 const ws=new WebSocket('wss://'+HOST+'/api/ws',{lookup,headers:{Origin:'https://'+HOST,Cookie:client.cookie}});client.ws=ws;client.events=[];
 const timer=setTimeout(()=>{ws.terminate();reject(Error('Application WebSocket timeout'));},10000);
 ws.on('message',data=>{try{client.events.push(JSON.parse(data.toString()));}catch{}});
 ws.once('open',()=>{clearTimeout(timer);resolve();});ws.once('error',error=>{clearTimeout(timer);reject(error);});
});}
async function waitEvent(client,status){for(let i=0;i<40;i++){if(client.events.some(e=>e.type==='direct-call'&&e.call?.status===status))return true;await new Promise(r=>setTimeout(r,100));}return false;}
function signalSocket(credentials){return new Promise((resolve,reject)=>{
 const address=new URL(credentials.url);address.pathname='/rtc';address.search=new URLSearchParams({access_token:credentials.token,auto_subscribe:'0',sdk:'js',version:'2.23.0',protocol:'16'}).toString();
 const ws=new WebSocket(address,{lookup,headers:{Origin:'https://'+HOST}});
 const timer=setTimeout(()=>{ws.terminate();reject(Error('Media signaling timeout'));},10000);
 ws.once('message',data=>{clearTimeout(timer);ws.close();resolve({receivedBytes:data.length});});
 ws.once('error',()=>{clearTimeout(timer);reject(Error('Media signaling rejected'));});
 ws.once('unexpected-response',(req,res)=>{clearTimeout(timer);ws.terminate();reject(Error('Media signaling HTTP '+res.statusCode));});
});}
const a={},b={};let channel,call;
const rooms=new RoomServiceClient(process.env.LIVEKIT_URL,process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET||process.env.LIVEKIT_SECRET,{requestTimeout:5});
try{
 const stamp=Date.now().toString(36);
 for(const [client,suffix] of [[a,'a'],[b,'b']]){
  const name='qa_call_'+stamp+'_'+suffix;
  const result=await request(client,'/register',{username:name,password:randomBytes(24).toString('base64url')});ensure(result,201,'register');
  client.user=result.data.user;state.users.push({id:client.user.id,username:name});save();
 }
 report.registration=true;
 await Promise.all([events(a),events(b)]);report.applicationWebSockets=true;
 const friend=await request(a,'/friend-requests',{username:b.user.username});ensure(friend,201,'friend-request');
 const accepted=await request(b,'/friend-requests/'+friend.data.request.id+'/respond',{action:'accept'});ensure(accepted,200,'friend-accept');
 const started=await request(a,'/direct-calls',{userId:b.user.id});ensure(started,201,'create-call');
 call=started.data.call;channel=started.data.channel;state.calls.push(call.id);state.channels.push(channel.id);save();report.callCreated=true;
 report.incomingRingDelivered=await waitEvent(b,'pending');if(!report.incomingRingDelivered)throw Error('Recipient received no ringing event');
 const response=await request(b,'/direct-calls/'+call.id+'/respond',{action:'accept'});ensure(response,200,'accept-call');
 report.callerAcceptanceDelivered=await waitEvent(a,'accepted');
 const grants=[];
 for(const client of [a,b]){const result=await request(client,'/channels/'+channel.id+'/join',{encryptionVersion:1});ensure(result,200,'join-media');grants.push(result.data);}
 report.encryptedRoomGrants=true;report.sameEncryptionKey=grants[0].encryption.key===grants[1].encryption.key;
 const media=await Promise.all(grants.map(signalSocket));report.mediaWebSockets=media.every(r=>r.receivedBytes>0);
 const ended=await request(a,'/direct-calls/'+call.id+'/respond',{action:'end'});ensure(ended,200,'end-call');report.callEnded=true;
}catch(error){report.failure=String(error.message).replace(/(?:https?|wss?):\/\/\S+/g,'<address>').slice(0,180);process.exitCode=1;}
finally{
 if(call){try{await request(a,'/direct-calls/'+call.id+'/respond',{action:'end'});}catch{}}
 for(const client of [a,b]){client.ws?.terminate();if(client.user)try{await request(client,'/logout',{});}catch{}}
 if(channel)try{await rooms.deleteRoom(channel.id);}catch{}
 save();writeFileSync(join(directory,'result.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
}
