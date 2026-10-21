// offscreen.js — offscreen 文档脚本：代 SW 读写系统剪贴板
// SW 没有聚焦文档，navigator.clipboard 在其中不可用；offscreen 文档可代持。

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.action === 'offscreen:clipboard-read') {
    navigator.clipboard.readText()
      .then(text => sendResponse({ ok: true, data: { text } }))
      .catch(e => sendResponse({ ok: false, message: String(e && e.message || e) }));
    return true;
  }
  if (msg?.action === 'offscreen:clipboard-write') {
    navigator.clipboard.writeText(msg.payload.text)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, message: String(e && e.message || e) }));
    return true;
  }
});
