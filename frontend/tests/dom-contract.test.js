/**
 * CLEAN-04: hợp đồng giữa JS cũ (js/*.js) và index.html — thay cho các test chỉ kiểm tra
 * "index.html có chứa chuỗi id=...". Mọi `document.getElementById('x')` trong js/ phải trỏ tới
 * một phần tử có thật trong index.html (đổi tên/xoá id ở HTML sẽ làm test này đỏ), và id không
 * được trùng lặp (trùng id làm getElementById bám sai node).
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const htmlWithoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
const JS_FILES = ['auth.js', 'api.js', 'chat.js', 'rooms.js', 'pve.js'];

function htmlIds() {
  return [...htmlWithoutComments.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
}

// id mà JS tự tạo lúc chạy (innerHTML / createElement) nên không có sẵn trong index.html
const DYNAMIC_IDS = new Set();

function referencedIds() {
  const used = new Map();
  for (const file of JS_FILES) {
    const source = fs.readFileSync(path.join(ROOT, 'js', file), 'utf8');
    for (const m of source.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (!used.has(m[1])) used.set(m[1], file);
    }
  }
  return used;
}

describe('CLEAN-04: hợp đồng DOM giữa js/*.js và index.html', () => {
  test('mọi id mà JS tra cứu bằng getElementById đều tồn tại trong index.html', () => {
    const present = new Set(htmlIds());
    const used = referencedIds();
    assert.ok(used.size > 50, `phải tìm thấy nhiều id được JS tham chiếu (thấy ${used.size})`);

    const missing = [...used].filter(([id]) => !present.has(id) && !DYNAMIC_IDS.has(id))
      .map(([id, file]) => `${id} (${file})`);
    assert.deepStrictEqual(missing, [], `JS tham chiếu id không có trong index.html: ${missing.join(', ')}`);
  });

  test('index.html không có id trùng lặp', () => {
    const seen = new Set();
    const duplicated = new Set();
    for (const id of htmlIds()) {
      if (seen.has(id)) duplicated.add(id);
      seen.add(id);
    }
    assert.deepStrictEqual([...duplicated], [], `id bị trùng: ${[...duplicated].join(', ')}`);
  });

  test('các hộp thoại xác thực không nằm bên trong roomModal bị ẩn', () => {
    const document = new JSDOM(html).window.document;
    for (const id of ['loginModal', 'registerModal', 'forgotPasswordModal', 'resetPasswordModal']) {
      const modal = document.getElementById(id);
      assert.ok(modal, `phải có hộp thoại #${id}`);
      assert.strictEqual(modal.parentElement, document.body, `#${id} phải là phần tử con trực tiếp của body`);
    }
  });

  test('BE-14: ô nhập mã phòng cho phép 10 ký tự (mã riêng tư) chứ không chỉ 6 chữ số', () => {
    const input = htmlWithoutComments.match(/<input[^>]*id="roomCodeInput"[^>]*>/);
    assert.ok(input, 'phải có ô nhập mã phòng roomCodeInput');
    assert.match(input[0], /maxlength="10"/);
  });
});
