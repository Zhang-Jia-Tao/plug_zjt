// tools/gen-brand-logo.mjs — 生成搜索框上方的品牌图（brand.png）
// 零依赖 Node 脚本：手写 PNG 编码器 + 软件光栅渲染（抗锯齿圆角、渐变、高光、投影）。
// 重新生成：node tools/gen-brand-logo.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const W = 480, H = 240; // 画布 2x 渲染（实际显示 56px 高，留足余量）

// ---------- 小工具 ----------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

// 品牌渐变色（与 CSS --grad-brand 一致）：#6d5efc → #4285f4
const C1 = [109, 94, 252], C2 = [66, 133, 244];

function gradColor(x, y) {
  // 135° 对角渐变
  const t = clamp((x + y) / (W + H), 0, 1);
  return [mix(C1[0], C2[0], t), mix(C1[1], C2[1], t), mix(C1[2], C2[2], t)];
}

// ---------- 圆角方形 SDF ----------
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

// ---------- 圆 SDF ----------
function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

// 主体：左侧圆角方块 logo 磁贴
const TILE = { cx: 96, cy: 120, hw: 62, hh: 62, r: 22 };
// 右侧文字
const TEXT = 'NewTab · 新标签页';

// ---------- 渲染 ----------
const px = new Float32Array(W * H * 4);

function setPix(i, r, g, b, a) {
  const o = i * 4;
  // source-over（直通 alpha）：out = src·a + dst·(1-a)
  const na = a + px[o + 3] * (1 - a);
  if (na > 0) {
    px[o]     = (r * a + px[o]     * px[o + 3] * (1 - a)) / na;
    px[o + 1] = (g * a + px[o + 1] * px[o + 3] * (1 - a)) / na;
    px[o + 2] = (b * a + px[o + 2] * px[o + 3] * (1 - a)) / na;
    px[o + 3] = na;
  }
}

// 简易 5x7 像素字体（大写字母+数字+符号）— 文字用高分辨率点阵绘制
const FONT = {
  'N': ['10001','11011','10101','10011','10001','10001','10001'],
  'E': ['11111','10000','10000','11110','10000','10000','11111'],
  'W': ['10001','10001','10001','10101','10101','11011','10001'],
  'T': ['11111','00100','00100','00100','00100','00100','00100'],
  'A': ['01110','10001','10001','11111','10001','10001','10001'],
  'B': ['11110','10001','11110','10001','10001','10001','11110'],
  ' ': ['00000','00000','00000','00000','00000','00000','00000'],
  '·': ['00000','00000','00000','00100','00000','00000','00000'],
};

function drawText(str, x0, y0, size, color) {
  const cw = size, chh = size; // 每像素单元
  let cx = x0;
  for (const ch of str) {
    const glyph = FONT[ch] || FONT[' '];
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy][gx] !== '1') continue;
        const rx0 = cx + gx * cw, ry0 = y0 + gy * chh;
        const rx1 = rx0 + cw, ry1 = ry0 + chh;
        for (let y = Math.floor(ry0); y < Math.ceil(ry1); y++) {
          for (let x = Math.floor(rx0); x < Math.ceil(rx1); x++) {
            if (x < 0 || x >= W || y < 0 || y >= H) continue;
            // 单元内覆盖率（抗锯齿）
            const cov = clamp(Math.min(rx1, x + 1) - Math.max(rx0, x), 0, 1)
                      * clamp(Math.min(ry1, y + 1) - Math.max(ry0, y), 0, 1);
            if (cov <= 0) continue;
            setPix(y * W + x, color[0], color[1], color[2], cov);
          }
        }
      }
    }
    cx += 6 * cw; // 字宽 5 + 1 间隔
  }
}

// --- 1. 磁贴投影（下方偏移的柔和椭圆阴影） ---
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const d = sdRoundRect(x, y, TILE.cx + 2, TILE.cy + 7, TILE.hw, TILE.hh, TILE.r);
    const a = smooth(-d / 12) * 0.35;
    if (a > 0) setPix(y * W + x, 10, 12, 20, a);
  }
}

// --- 2. 磁贴本体：渐变底 + 边框高光 ---
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const d = sdRoundRect(x, y, TILE.cx, TILE.cy, TILE.hw, TILE.hh, TILE.r);
    if (d >= 1.5) continue;
    const edge = smooth(1.5 - d); // 1.5px 边缘抗锯齿
    const base = gradColor(x, y);
    // 顶部左上受光：亮度向左上提升
    const lit = clamp(1 - (Math.hypot(x - (TILE.cx - TILE.hw), y - (TILE.cy - TILE.hh)) / (TILE.hw * 3)), 0, 1);
    const r = mix(base[0], 255, lit * 0.22);
    const g = mix(base[1], 255, lit * 0.22);
    const b = mix(base[2], 255, lit * 0.22);
    setPix(y * W + x, r, g, b, edge);
    // 内描边亮线（-2px 的圆环）
    const d2 = Math.abs(sdRoundRect(x, y, TILE.cx, TILE.cy, TILE.hw - 2, TILE.hh - 2, TILE.r - 2) + 1);
    if (d2 < 0.8) setPix(y * W + x, 255, 255, 255, 0.28 * (1 - d2 / 0.8));
  }
}

// --- 3. 磁贴内部图形：白色圆环 + 中心十字星（newtab 的「+」意象） ---
const RING = { cx: TILE.cx, cy: TILE.cy, r: 34, w: 7 };
const STAR = { cx: TILE.cx, cy: TILE.cy, r: 17 };
for (let y = TILE.cy - 45; y < TILE.cy + 45; y++) {
  for (let x = TILE.cx - 45; x < TILE.cx + 45; x++) {
    const dr = Math.abs(sdCircle(x, y, RING.cx, RING.cy, RING.r) + RING.w / 2);
    if (dr < 1.2) setPix(y * W + x, 255, 255, 255, smooth(1.2 - dr) * 0.95);
    // 中心四角星：|dx|、|dy| 菱形渐缩
    const dx = Math.abs(x - STAR.cx), dy = Math.abs(y - STAR.cy);
    const ds = Math.max(dx, dy) * 0.55 + Math.hypot(dx, dy) * 0.45 - STAR.r;
    if (ds < 1) setPix(y * W + x, 255, 255, 255, smooth(1 - ds) * 0.95);
  }
}

// --- 4. 右侧文字 ---
const tc = [236, 238, 242];
drawText('NEWTAB', TILE.cx + TILE.hw + 26, TILE.cy - 44, 11, tc);
drawText('CUSTOMIZABLE DASHBOARD', TILE.cx + TILE.hw + 26, TILE.cy + 2, 6, [154, 163, 173]);

// ---------- PNG 编码 ----------
function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// RGBA float → 8bit 行数据（带 filter 0）
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0;
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4, ro = y * (1 + W * 4) + 1 + x * 4;
    // 预乘处理：直接取存储的直通 alpha 值
    raw[ro]     = Math.round(clamp(px[o], 0, 255));
    raw[ro + 1] = Math.round(clamp(px[o + 1], 0, 255));
    raw[ro + 2] = Math.round(clamp(px[o + 2], 0, 255));
    raw[ro + 3] = Math.round(clamp(px[o + 3] * 255, 0, 255));
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'img', 'brand.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`brand.png 生成完毕：${W}x${H} → ${out}`);
