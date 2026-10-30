
import http from "node:http";
import { spawn } from "node:child_process";
const NODE = process.env.NODE, HOME = process.env.HOME_DIR;
const RELAY = HOME + "/tmp/relay-live.mjs";
const EGO = HOME + "/plugins/dsh-ego-browser/runtime/ego-linux/bin/ego-browser.mjs";
const PORT = 42111, GUI_URL = "http://127.0.0.1:3080/";
function list(port){return new Promise(r=>{const q=http.request({host:"127.0.0.1",port,path:"/json/list"},res=>{let b="";res.on("data",d=>b+=d);res.on("end",()=>{try{r(JSON.parse(b))}catch{r(null)}})});q.on("error",()=>r(null));q.end()})}
// ⚠ 不设 EGO_LINUX_WEBVIEW_SOCKET：让中继去解析**真**应用的抽象 socket
const relay = spawn(NODE,[RELAY],{env:{...process.env,HOME,EGO_LINUX_WEBVIEW_RELAY_PORT:String(PORT),RELAY_DEBUG:"1"},stdio:["ignore","pipe","pipe"]});
let rOut=""; relay.stdout.on("data",d=>rOut+=d); relay.stderr.on("data",d=>rOut+=d);
await new Promise(s=>setTimeout(s,2500));
console.log("relay: " + rOut.trim().split("\n")[0]);
console.log("(中继自行解析到的 socket 名即证明它连的是真应用 WebView)");
const before = await list(PORT);
const guiBefore = (before||[]).find(p=>String(p.url).includes(":3080"));
console.log("GUI BEFORE: url=" + (guiBefore&&guiBefore.url) + " title=" + (guiBefore&&guiBefore.title));
const ego = spawn(NODE,[EGO],{env:{...process.env,HOME,EGO_LINUX_CDP_URL:"ws://127.0.0.1:"+PORT+"/devtools/browser",EGO_LINUX_CHROME:RELAY,EGO_LINUX_WEBVIEW_RELAY_PORT:String(PORT)},stdio:["pipe","pipe","pipe"]});
let out=""; ego.stdout.on("data",d=>out+=d); ego.stderr.on("data",d=>out+="[ego!] "+d);
ego.stdin.end('try { await taskSpaces.useOrCreate({ name: "real", url: "https://example.com/" }); console.log("OUTCOME success"); } catch (e) { console.log("OUTCOME refusal: " + String((e && e.message) || e).slice(0,300)); }\n');
await new Promise(r=>ego.on("exit",r));
console.log("ego: " + (out.trim().split("\n").find(l=>l.startsWith("OUTCOME"))||out.trim().slice(0,200)));
const after = await list(PORT);
const guiAfter = (after||[]).find(p=>p.id === (guiBefore&&guiBefore.id));
console.log("GUI AFTER : url=" + (guiAfter&&guiAfter.url) + " title=" + (guiAfter&&guiAfter.title));
console.log("page count: before=" + (before||[]).filter(p=>p.type==="page").length + " after=" + (after||[]).filter(p=>p.type==="page").length);
console.log("relay debug lines  : " + JSON.stringify(rOut.trim().split("\n").filter(l=>/DBG/.test(l))));
console.log("restoreUserPage 是否导航过: " + (/DBG restored user page/.test(rOut) ? "是（发生了事后还原）" : "否（从未导航，无需还原）"));
console.log((guiAfter && guiAfter.url === GUI_URL && !/DBG restored user page/.test(rOut))
  ? "REAL_REFUSAL_PASS: 真 WebView 上被拒绝、用户页 url/title 未变、且中继从未执行还原导航"
  : "REAL_REFUSAL_FAIL");
relay.kill("SIGKILL"); setTimeout(()=>process.exit(0),300);
