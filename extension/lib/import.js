// import.js — 导入/备份 JSON 的纯解析逻辑（便于回归测试）
// 支持的形状：
//   { notes: [...] }                 // 新版
//   { exportedAt, notes: [...] }     // exportJson
//   { json: { notes: [...] } }       // 旧版 message 包装
//   [ ... ]                          // 直接数组

export function extractNotesFromBackup(obj) {
  if (Array.isArray(obj)) return obj;
  if (obj && Array.isArray(obj.notes)) return obj.notes;
  if (obj && Array.isArray(obj.json)) return obj.json;
  if (obj && Array.isArray(obj.json?.notes)) return obj.json.notes;
  throw new Error('导入文件格式不正确：缺少 notes 数组');
}

export function extractImportNotes(payload) {
  const notes = extractNotesFromBackup(payload);
  if (notes.length === 0) throw new Error('导入文件没有便利贴，已保留当前数据');
  return notes;
}
