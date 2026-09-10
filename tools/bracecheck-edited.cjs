const fs = require("fs");
const files = [
  "app/src/main/java/com/dsh/launcher/core/DshFlow.kt",
  "app/src/main/java/com/dsh/launcher/core/DshWatchdog.kt",
  "app/src/main/java/com/dsh/launcher/service/StatusBridgeService.kt",
  "app/src/main/java/com/dsh/launcher/service/KeepAliveAccessibilityService.kt",
  "app/src/main/java/com/dsh/launcher/ui/WebViewActivity.kt",
];
let fail = 0;
for (const f of files) {
  const s = fs.readFileSync(f, "utf8");
  let braces = 0, parens = 0;
  let inS = null, inLine = false, inBlock = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i+1];
    if (inLine) { if (c === "\n") inLine = false; continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
    if (inS) { if (c === "\\") { i++; continue; } if (c === inS) inS = null; continue; }
    if (c === "/" && n === "/") { inLine = true; i++; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    if (c === "\"" || c === "'") { inS = c; continue; }
    if (c === "{") braces++;
    if (c === "}") braces--;
    if (c === "(") parens++;
    if (c === ")") parens--;
  }
  const ok = braces === 0 && parens === 0;
  if (!ok) fail++;
  console.log(f.split("/").pop() + ": braces=" + braces + " parens=" + parens + (ok ? " OK" : " ** IMBALANCE **"));
}
process.exit(fail);
