// 回归测试：Notion 推送按 database schema 过滤列，缺列/类型不符时跳过
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNoteProperties } from '../extension/lib/notion.js';

const FULL_NOTE = {
  id: 'note-1',
  category: 'account',
  title: '标题',
  content: '内容',
  pinned: true,
  url: 'https://example.com',
  remindAt: '2026-10-27T10:00:00.000Z',
  username: 'user',
  password: 'pass',
  host: '10.0.0.1',
  port: '22',
  name: '张三',
  phone: '13800000000',
  email: 'a@b.com',
  idCard: '110101199001010000',
  fields: [{ label: '工号', value: '001' }],
};

function schemaOf(types) {
  return new Map(Object.entries(types));
}

test('只写入数据库中已存在且类型匹配的列', () => {
  const props = buildNoteProperties(FULL_NOTE, schemaOf({
    Title: 'title',
    Category: 'select',
    Content: 'rich_text',
    Pinned: 'checkbox',
    NoteID: 'rich_text',
    URL: 'url',
    Username: 'rich_text',
    Password: 'rich_text',
    CustomFields: 'rich_text',
  }));

  assert.equal(props.Title.title[0].text.content, '标题');
  assert.equal(props.URL.url, 'https://example.com');
  assert.equal(props.Username.rich_text[0].text.content, 'user');
  assert.equal(props.Password.rich_text[0].text.content, 'pass');
  assert.equal(props.CustomFields.rich_text[0].text.content, '工号: 001');
  // 数据库没有的列不应出现
  assert.equal(props.RemindAt, undefined);
  assert.equal(props.Host, undefined);
  assert.equal(props.Port, undefined);
  assert.equal(props.Name, undefined);
});

test('列存在但类型不符时跳过（避免 Notion 400）', () => {
  const props = buildNoteProperties(FULL_NOTE, schemaOf({
    Title: 'title',
    Category: 'select',
    Content: 'rich_text',
    Pinned: 'checkbox',
    NoteID: 'rich_text',
    URL: 'rich_text',      // 类型不符
    RemindAt: 'date',
  }));
  assert.equal(props.URL, undefined);
  assert.equal(props.RemindAt.date.start, '2026-10-27T10:00:00.000Z');
  assert.equal(props.Username, undefined);
});

test('不传 schema 时保持旧行为（写全部字段）', () => {
  const props = buildNoteProperties(FULL_NOTE);
  assert.ok(props.URL);
  assert.ok(props.RemindAt);
  assert.ok(props.Username);
  assert.ok(props.Password);
  assert.ok(props.CustomFields);
});
