try {
  const task = await taskSpaces.useOrCreate({ name: "proof", url: "https://example.com/" });
  const __tabs = await browser.listTabs();
  const __real = __tabs.find(t => !t.url.startsWith("about:") && !t.url.startsWith("chrome://")) ?? __tabs[0];
  if (__real) await browser.switchTab(__real.targetId);
  const pginfo = await page.info();
  const snap = await page.snapshot();
  const text = String((snap && snap.content) || "");
  console.log("RESULT_OK " + JSON.stringify({ page: pginfo, snapshotChars: text.length }).slice(0, 500));
} catch (e) {
  console.log("RESULT_ERR " + String((e && e.message) || e).slice(0, 400));
}
