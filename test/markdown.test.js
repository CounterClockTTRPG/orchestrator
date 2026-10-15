import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdown } from '../web/markdown.js';

test('escapes HTML everywhere', () => {
  const html = markdown('# <b>x</b>\n\n<script>alert(1)</script> and `<i>`\n\n- <img src=x onerror=alert(1)>');
  assert.ok(!/<script|<img|<b>|<i>/.test(html), html);
  assert.match(html, /&lt;script&gt;/);
});

test('only http(s) links become anchors, with noreferrer', () => {
  assert.match(markdown('[a](https://e.com/x)'), /<a href="https:\/\/e.com\/x" target="_blank" rel="noopener noreferrer">a<\/a>/);
  assert.ok(!markdown('[a](javascript:alert(1))').includes('<a '));
});

test('emphasis does not reach inside link targets or code', () => {
  const html = markdown('[a](https://e.com/_a_b_) and `x_y_z` and _real_');
  assert.match(html, /href="https:\/\/e.com\/_a_b_"/);
  assert.match(html, /<code>x_y_z<\/code>/);
  assert.match(html, /<em>real<\/em>/);
});

test('double-backtick code spans may contain backticks', () => {
  assert.match(markdown('returns `` `Hail, ${name}!` `` today'), /<code>`Hail, \$\{name\}!`<\/code> today/);
});

test('NUL characters in the text cannot forge placeholders', () => {
  const html = markdown('a \u00000\u0000 b `c`');
  assert.ok(!html.includes('undefined'), html);
  assert.match(html, /<code>c<\/code>/);
});

test('block structure: lists, tables, code fences, quotes', () => {
  const html = markdown('- one\n- two\n\n1. a\n2. b\n\n| h | i |\n|---|---|\n| 1 | 2 |\n\n```js\nlet x = 1 < 2;\n```\n\n> quoted');
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>a<\/li><li>b<\/li><\/ol>/);
  assert.match(html, /<table><thead><tr><th>h<\/th><th>i<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr>/);
  assert.match(html, /<pre><code>let x = 1 &lt; 2;<\/code><\/pre>/);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
});
