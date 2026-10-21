// picker.js — file-picker.html 脚本（回退用的独立选择小窗）
// showDirectoryPicker 必须由用户手势（点击）触发。本页点「选择目录」后调起系统选择器；
// 句柄直接写入共享 IDB（消息通道无法序列化 FileSystemDirectoryHandle），
// 再通知 SW 广播刷新所有 tree iframe。

import { saveDirHandle } from './handle-store.js';

const $ = (sel) => document.querySelector(sel);

async function pick() {
  const btn = $('#picker-btn');
  btn.disabled = true;
  btn.textContent = '正在调起系统对话框…';
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      const granted = await handle.requestPermission({ mode: 'readwrite' });
      if (granted !== 'granted') throw new Error('未授予目录访问权限');
    }
    // 直接写共享 IDB
    const id = crypto.randomUUID();
    await saveDirHandle({ id, name: handle.name, handle });
    // 通知 SW 广播
    chrome.runtime.sendMessage({ action: 'tree:changed-broadcast' }, () => {
      void chrome.runtime.lastError;
    });
    $('#picker-result').textContent = `✓ 已添加目录：${handle.name}`;
    setTimeout(() => window.close(), 700);
  } catch (e) {
    if (e && e.name === 'AbortError') { // 用户取消
      window.close();
      return;
    }
    $('#picker-result').textContent = `未完成：${e.message || e}`;
    btn.disabled = false;
    btn.textContent = '选择目录';
  }
}

$('#picker-btn').addEventListener('click', pick);
