
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const NODE = process.env.NODE;
const HOME = process.env.HOME_DIR;
const RELAY = HOME + "/tmp/relay-live.mjs";
const EGO = HOME + "/plugins/dsh-ego-browser/runtime/ego-linux/bin/ego-browser.mjs";
const SOCK = "@disc_webview";
const SOCK_PATH = "\0disc_webview";
const PORT = 42088;
const GUI_URL = "http://127.0.0.1:3080/";

const evaluateExprs = [];           // 上游收到的所有 Runtime.evaluate 表达式
const allMethods = [];              // 上游收到的**全部**方法（含 Page.navigate）
const targets = [{ targetId: "GUI_TARGET", type: "page", url: GUI_URL, title: "DSH GUI" }];

function readFrames(buf){const frames=[];let off=0;for(;;){if(buf.length-off<2)break;const b0=buf[off],b1=buf[off+1];const opcode=b0&0x0f;const masked=(b1&0x80)!==0;let len=b1&0x7f;let p=off+2;if(len===126){if(buf.length-p<2)break;len=buf.readUInt16BE(p);p+=2;}else if(len===127){if(buf.length-p<8)break;len=Number(buf.readBigUInt64BE(p));p+=8;}let key=null;if(masked){if(buf.length-p<4)break;key=buf.subarray(p,p+4);p+=4;}if(buf.length-p<len)break;let pl=buf.subarray(p,p+len);if(masked){const o=Buffer.allocUnsafe(len);for(let i=0;i<len;i++)o[i]=pl[i]^key[i&3];pl=o;}frames.push({opcode,payload:pl});off=p+len;}return{frames,rest:buf.subarray(off)};}
function frame(pl,op=0x1){const d=Buffer.isBuffer(pl)?pl:Buffer.from(pl);const len=d.length;let h;if(len<126){h=Buffer.alloc(2);h[1]=len;}else if(len<65536){h=Buffer.alloc(4);h[1]=126;h.writeUInt16BE(len,2);}else{h=Buffer.alloc(10);h[1]=127;h.writeBigUInt64BE(BigInt(len),2);}h[0]=0x80|op;return Buffer.concat([h,d]);}

let sessSeq = 0; const sessTarget = new Map();
function handleCdp(conn,msg){
  allMethods.push(msg.method);
  const reply=(r)=>conn.write(frame(JSON.stringify({id:msg.id,result:r,...(msg.sessionId?{sessionId:msg.sessionId}:{})})));
  if(msg.method==="Target.getTargets")return reply({targetInfos:targets.map(t=>({...t}))});
  if(msg.method==="Target.attachToTarget"){const sid="S_"+(++sessSeq);sessTarget.set(sid,(msg.params&&msg.params.targetId)||targets[0].targetId);return reply({sessionId:sid});}
  if(msg.method==="Page.navigate")return reply({frameId:"F"});
  if(msg.method==="Runtime.evaluate"){
    const expr=String((msg.params&&msg.params.expression)||"");
    evaluateExprs.push(expr);
    return reply({result:{type:"number",value:1}});
  }
  return reply({});
}

const upstream=net.createServer((conn)=>{
  let pending=Buffer.alloc(0);let upgraded=false;
  conn.on("data",(chunk)=>{
    if(upgraded)return;
    pending=Buffer.concat([pending,chunk]);
    for(;;){const end=pending.indexOf("\r\n\r\n");if(end<0)break;const head=pending.subarray(0,end+4).toString("latin1");const rest=pending.subarray(end+4);pending=Buffer.alloc(0);
      const key=/sec-websocket-key: *([^\r\n]+)/i.exec(head);
      if(/upgrade: websocket/i.test(head)&&key){upgraded=true;const acc=crypto.createHash("sha1").update(key[1].trim()+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        conn.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+acc+"\r\n\r\n");
        let fb=rest;const onD=(d)=>{fb=Buffer.concat([fb,d]);const r2=readFrames(fb);fb=r2.rest;for(const f of r2.frames)if(f.opcode===0x1)handleCdp(conn,JSON.parse(f.payload.toString("utf8")));};
        conn.on("data",onD);return;}
      const body=JSON.stringify({"Android-Package":"com.dsh.nextapp1",Browser:"Chrome/153.0.8010.36","Protocol-Version":"1.3",webSocketDebuggerUrl:"ws://127.0.0.1/devtools/browser"});
      conn.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "+Buffer.byteLength(body)+"\r\n\r\n"+body);}
  });conn.on("error",()=>{});
});
await new Promise((res)=>upstream.listen(SOCK_PATH,res));

const relay=spawn(NODE,[RELAY],{env:{...process.env,HOME,EGO_LINUX_WEBVIEW_SOCKET:SOCK,EGO_LINUX_WEBVIEW_RELAY_PORT:String(PORT),EGO_LINUX_WEBVIEW_CREATE_TIMEOUT_MS:"3000"},stdio:["ignore","pipe","pipe"]});
await new Promise((s)=>setTimeout(s,1500));

// 无 MULTIWINDOW：走拒绝分支
const ego=spawn(NODE,[EGO],{env:{...process.env,HOME,EGO_LINUX_CDP_URL:"ws://127.0.0.1:"+PORT+"/devtools/browser",EGO_LINUX_CHROME:RELAY,EGO_LINUX_WEBVIEW_RELAY_PORT:String(PORT)},stdio:["pipe","pipe","pipe"]});
let out="";ego.stdout.on("data",(d)=>out+=d);ego.stderr.on("data",(d)=>out+="[ego!] "+d);
ego.stdin.end('try { await taskSpaces.useOrCreate({ name: "disc", url: "https://example.com/" }); console.log("OUTCOME success"); } catch (e) { console.log("OUTCOME refusal"); }\n');
await new Promise((res)=>ego.on("exit",res));

const windowOpens = evaluateExprs.filter((e) => /window\.open/.test(e));
console.log("ego: " + (out.includes("OUTCOME refusal") ? "refusal" : out.trim().slice(0,200)));
console.log("upstream methods (all)         : " + allMethods.join(", "));
console.log("upstream Page.navigate count   : " + allMethods.filter(m => m === "Page.navigate").length);
console.log("upstream Runtime.evaluate count : " + evaluateExprs.length);
console.log("of which window.open           : " + windowOpens.length);
console.log("targets                        : " + targets.map(t=>t.targetId).join(", "));
console.log("GUI url                        : " + targets[0].url);
const navigates = allMethods.filter(m => m === "Page.navigate").length;
const hasOpen = windowOpens.length > 0;
console.log((!hasOpen && navigates === 0 && targets.length === 1 && targets[0].url === GUI_URL)
  ? "STRUCTURAL_PASS: 拒绝分支既没发 window.open 也没发 Page.navigate —— 用户页既不会被 window.open 导航，也不存在事后 restore 的导航"
  : "STRUCTURAL_FAIL hasOpen=" + hasOpen + " navigates=" + navigates);
relay.kill("SIGKILL");upstream.close();setTimeout(()=>process.exit(0),300);
