/**
 * runtime-provision — 运行时自解析与自带供给。
 * 目标：普通用户不需要手写 D:/other/Git/... 这种机器专属路径。
 * 顺序：env DSH_BASH_PATH → 自带 bundle → Git for Windows 常见位置 → MSYS2 → PATH。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { sha256File, validateManifest, verifyRuntime } from "./runtime-layout.mjs";

export const PROVISION_VERSION = "1";

export function candidateRuntimes(options) {
  const o = options || {};
  const env = o.env || {};
  const platform = o.platform || process.platform;
  const bundledRuntimeDir = o.bundledRuntimeDir || null;
  const list = [];
  if (env.DSH_BASH_PATH) list.push({ source: "env", path: env.DSH_BASH_PATH, why: "环境变量 DSH_BASH_PATH 显式指定" });
  if (bundledRuntimeDir) {
    list.push({ source: "bundled", path: join(bundledRuntimeDir, "usr", "bin", platform === "win32" ? "bash.exe" : "bash"), why: "插件自带运行时（无需任何系统依赖）" });
  }
  if (platform === "win32") {
    const pf = env.ProgramFiles || "C:/Program Files";
    const pf86 = env["ProgramFiles(x86)"] || "C:/Program Files (x86)";
    const la = env.LOCALAPPDATA || null;
    for (const base of [pf, pf86]) list.push({ source: "git-for-windows", path: join(base, "Git", "bin", "bash.exe"), why: "已安装 Git for Windows" });
    if (la) list.push({ source: "git-for-windows", path: join(la, "Programs", "Git", "bin", "bash.exe"), why: "已安装 Git for Windows（用户级）" });
    for (const base of ["C:/msys64", "D:/msys64"]) list.push({ source: "msys2", path: join(base, "usr", "bin", "bash.exe"), why: "已安装 MSYS2" });
    list.push({ source: "path", path: "bash.exe", why: "PATH 上的 bash" });
  } else {
    list.push({ source: "path", path: "/bin/bash", why: "系统 bash" });
  }
  return list.map((c) => ({ ...c, explicit: c.source === "env" || c.source === "bundled" }));
}

const CACHE_TTL_MS = 300000;
let cache = null;
export function clearBashRuntimeCache() { cache = null; }
function fingerprint(path) { try { const s=statSync(path);return path+':'+s.mtimeMs+':'+s.size; } catch { return path+':missing'; } }
function pathEnv(env) { return Object.entries(env).find(([k])=>k.toLowerCase()==='path')?.[1]||''; }
function locate(path,env,platform) {
  if(path.includes('/')||path.includes(String.fromCharCode(92)))return path;
  for(const dir of pathEnv(env).split(platform==='win32'?';':':').filter(Boolean)){const p=join(dir.replace(/^"|"$/g,''),path);if(existsSync(p))return p;}return path;
}
async function runProbe(command,args,o,limit) {
  if(o.signal?.aborted)return{cancelled:true};
  return new Promise(resolve=>{
    let child,timer,reapTimer,finished=false,cancelled=false,timedOut=false,output='',error='';
    const finish=r=>{if(finished)return;finished=true;clearTimeout(timer);clearTimeout(reapTimer);o.signal?.removeEventListener('abort',abort);resolve(r);};
    const stop=()=>{try{child?.kill('SIGKILL');}catch{}
      if (!reapTimer && !finished) reapTimer=setTimeout(()=>finish({cancelled,timedOut,cleanupUnconfirmed:true,error:new Error('probe-exit-not-confirmed')}),o.probeReapMs || 2000);};
    const abort=()=>{cancelled=true;stop();};
    try {
      child=(o.spawn||spawn)(command,args,{env:o.env||process.env,cwd:o.cwd,stdio:['ignore','pipe','pipe'],windowsHide:true});
      if(typeof child?.then==='function'){child.then(r=>finish(o.signal?.aborted?{cancelled:true}:r),e=>finish({error:e}));return;}
      child.stdout?.on('data',b=>{output=(output+b.toString('utf8')).slice(-8192);});
      child.stderr?.on('data',b=>{error=(error+b.toString('utf8')).slice(-8192);});
      child.once('error',e=>finish({error:e}));
      child.once('close',status=>finish({status,stdout:output,stderr:error,cancelled,timedOut}));
      o.signal?.addEventListener('abort',abort,{once:true});if(o.signal?.aborted)abort();
      timer=setTimeout(()=>{timedOut=true;stop();},limit);
    }catch(e){finish({error:e});}
  });
}
export async function probeRuntime(path,spawnFn,options={}) {
  if(options.signal?.aborted)return{ok:false,cancelled:true,path};
  if(!path)return{ok:false,path,reason:'empty-path'};
  if((path.includes('/')||path.includes(String.fromCharCode(92)))&&!existsSync(path))return{ok:false,path,reason:'file-not-found'};
  const r=await runProbe(path,['--version'],{...options,spawn:spawnFn||options.spawn},20000);
  if(r.cleanupUnconfirmed)return{ok:false,cancelled:!!r.cancelled,cleanupUnconfirmed:true,path,reason:'probe-exit-not-confirmed'};
  if(r.cancelled)return{ok:false,cancelled:true,path};
  const first=String(r.stdout||'').split(String.fromCharCode(10))[0].trim();
  return r.status===0&&/bash/i.test(first)?{ok:true,path,version:first}:{ok:false,path,reason:r.timedOut?'probe-timeout':String(r.error?.message||r.stderr||'not-bash').slice(0,200)};
}
export async function discoverFromGit(spawnFn,options={}) {
  const r=await runProbe('git',['--exec-path'],{...options,spawn:spawnFn||options.spawn},15000);
  if(r.cleanupUnconfirmed)return{cleanupUnconfirmed:true};
  if(r.cancelled)return{cancelled:true};if(r.status!==0)return null;
  const normalized=String(r.stdout||'').trim().split(String.fromCharCode(92)).join('/');const i=normalized.lastIndexOf('/mingw64/');if(i<0)return null;
  const root=normalized.slice(0,i);return{source:'git-on-path',root,why:'git --exec-path',candidates:[join(root,'bin','bash.exe'),join(root,'usr','bin','bash.exe')]};
}
export async function resolveBashRuntime(options={}) {
  const started=Date.now(),env=options.env||process.env,platform=options.platform||process.platform;
  const candidates=candidateRuntimes({...options,env,platform}).map(c=>({...c,path:locate(c.path,env,platform)}));
  const key=JSON.stringify({platform,candidates,PATH:pathEnv(env)}),prints=candidates.map(c=>fingerprint(c.path));
  if(options.signal?.aborted)return{ok:false,cancelled:true,repair:['运行时探测已取消'],cacheHit:false};
  if(cache&&cache.key===key&&Date.now()-cache.at<CACHE_TTL_MS&&JSON.stringify(prints)===JSON.stringify(cache.prints)&&fingerprint(cache.result.path)===cache.selected)return structuredClone({...cache.result,cacheHit:true,probeMs:0});
  const probes=[];
  const accept=(r,c)=>{const value={ok:true,path:r.path,version:r.version,source:c.source,why:c.why,probes};cache={key,at:Date.now(),prints,selected:fingerprint(value.path),result:structuredClone(value)};return{...value,cacheHit:false,probeMs:Date.now()-started};};
  for(const c of candidates){const r=await probeRuntime(c.path,options.spawn,{...options,env});probes.push({...c,...r});if(r.cleanupUnconfirmed)return{ok:false,cleanupUnconfirmed:true,repair:['运行时探测未确认退出，停止后续候选探测；请核对进程收尾。'],probes};if(r.cancelled)return{ok:false,cancelled:true,repair:['运行时探测已取消'],probes};if(r.ok)return accept(r,c);}
  const git=await discoverFromGit(options.spawn,{...options,env});if(git?.cleanupUnconfirmed)return{ok:false,cleanupUnconfirmed:true,repair:['git探测未确认退出，停止后续探测。'],probes};if(git?.cancelled)return{ok:false,cancelled:true,repair:['运行时探测已取消'],probes};
  if(git)for(const path of git.candidates){const r=await probeRuntime(path,options.spawn,{...options,env});probes.push({...r,source:git.source});if(r.cleanupUnconfirmed)return{ok:false,cleanupUnconfirmed:true,repair:['运行时探测未确认退出，停止后续候选探测；请核对进程收尾。'],probes};if(r.cancelled)return{ok:false,cancelled:true,repair:['运行时探测已取消'],probes};if(r.ok)return accept(r,git);}
  return{ok:false,path:null,probes,cacheHit:false,probeMs:Date.now()-started,repair:['没有找到可用 Bash；请安装 Git for Windows，或用 DSH_BASH_PATH 指定运行时。']};
}

/** 从发布包/自带 bundle 供给运行时：先校验清单，再复制到目标目录。 */
export function provisionFromBundle(options) {
  const o = options || {};
  const bundleDir = o.bundleDir;
  const targetDir = o.targetDir;
  if (!bundleDir || !targetDir) throw new TypeError("bundleDir / targetDir required");
  const manifestPath = join(bundleDir, "manifest.json");
  if (!existsSync(manifestPath)) return { ok: false, errno: "BUNDLE_MANIFEST_MISSING", repair: ["bundle 缺少 manifest.json：" + bundleDir] };
  let manifest;
  try { manifest = validateManifest(JSON.parse(readFileSync(manifestPath, "utf8"))); }
  catch (e) { return { ok: false, errno: "BUNDLE_MANIFEST_INVALID", repair: ["修复 " + manifestPath + "：" + String(e && e.message || e)] }; }
  const verified = verifyRuntime({ manifest, runtimeRoot: bundleDir });
  if (!verified.ok) return { ok: false, errno: "BUNDLE_INTEGRITY_FAILED", problems: verified.problems, repair: ["bundle 与清单不符，拒绝安装（不要绕过校验）：" + JSON.stringify(verified.problems.slice(0, 2))] };
  rmSync(targetDir, { recursive: true, force: true });
  const copyTree = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) {
      const f = join(from, entry);
      const t = join(to, entry);
      if (statSync(f).isDirectory()) copyTree(f, t);
      else copyFileSync(f, t);
    }
  };
  copyTree(bundleDir, targetDir);
  const bashPath = join(targetDir, manifest.bash);
  return { ok: true, targetDir, bashPath, version: manifest.version, fileCount: manifest.files.length, bashExists: existsSync(bashPath) };
}
