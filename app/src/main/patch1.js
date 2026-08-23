const fs=require("fs");
let f="EdgeTts.kt", s=fs.readFileSync(f,"utf8");
const a="        disarmTimeout()\n        stopPlayer()\n    }";
const n="        disarmTimeout()\n        stopPlayer()\n        // 关键：被打断的旧任务不会再走 finish/fail 回调，必须在这里释放流水线，\n        // 否则 busy 永远卡在 true，后续所有 enqueue 都被静默丢弃（换音色即触发）\n        busy.set(false)\n    }";
if(!s.includes(a)){console.log("E MISS");process.exit(1)}
s=s.replace(a,n);
fs.writeFileSync(f,s);
console.log("deadlock fixed");

let o="OverlaySettingsActivity.kt", t=fs.readFileSync(o,"utf8");
const vStart=t.indexOf('            val voices = linkedMapOf(');
const vEnd=t.indexOf('            )', vStart);
if(vStart<0||vEnd<0){console.log("V MISS");process.exit(1)}
const lines=[
 '            val voices = linkedMapOf(',
 '                "zh-CN-XiaoxiaoNeural" to "晓晓 · 女声自然",',
 '                "en-US-EmmaMultilingualNeural" to "艾玛 · 中英双语",',
 '                "zh-CN-XiaoyiNeural" to "晓伊 · 女声活泼",',
 '                "zh-CN-YunxiNeural" to "云希 · 男声年轻",',
 '                "zh-CN-YunjianNeural" to "云健 · 男声运动",',
 '                "zh-CN-YunyangNeural" to "云扬 · 男声新闻",',
 '                "zh-CN-liaoning-XiaobeiNeural" to "晓北 · 女声东北",',
 '                "zh-CN-shaanxi-XiaoniNeural" to "晓妮 · 女声陕西"',
 '            )'
];
t=t.slice(0,vStart)+lines.join("\n")+t.slice(vEnd+12);
fs.writeFileSync(o,t);
console.log("voices updated");
