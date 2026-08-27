// tests/apkg-core.test.mjs —— Anki .apkg 解析纯函数单测（Node 可测）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTags, stripHtml, renderAnkiTemplate, parseModels, noteToCard, buildCardsFromRows,
} from '../src/utils/apkg-core.js';

test('parseTags：空格分隔、空值过滤、上限 16', () => {
  assert.deepEqual(parseTags('tag1 tag2'), ['tag1', 'tag2']);
  assert.deepEqual(parseTags('  计组  408  '), ['计组', '408']);
  assert.deepEqual(parseTags(''), []);
  assert.equal(parseTags(Array.from({ length: 20 }, (_, i) => 't' + i).join(' ')).length, 16);
});

test('stripHtml：br/div 转换行、去标签、解实体', () => {
  assert.equal(stripHtml('<p>hello<br>world</p>'), 'hello\nworld');
  assert.equal(stripHtml('<div>a</div><div>b</div>'), 'a\nb');
  assert.equal(stripHtml('x &amp; y &lt; z &gt; w &nbsp; '), 'x & y < z > w');
});

test('renderAnkiTemplate：{{字段}} 与 {{cloze:字段}} 占位符替换', () => {
  const fields = [{ name: '正面', value: '什么是死锁' }, { name: '背面', value: '互相等待' }];
  assert.equal(renderAnkiTemplate('{{正面}}', fields), '什么是死锁');
  assert.equal(renderAnkiTemplate('{{cloze:正面}}', fields), '什么是死锁');
  assert.equal(renderAnkiTemplate('{{正面}} <br> {{背面}}', fields), '什么是死锁 <br> 互相等待');
});

test('parseModels：字段按 ord 排序、取首模板', () => {
  const json = JSON.stringify({
    '123': {
      flds: [{ name: 'B', ord: 1 }, { name: 'A', ord: 0 }],
      tmpls: [{ name: 'card1', qfmt: '{{A}}', afmt: '{{B}}' }],
    },
  });
  const models = parseModels(json);
  assert.deepEqual(models['123'].fields, ['A', 'B']);
  assert.equal(models['123'].qfmt, '{{A}}');
  assert.equal(models['123'].afmt, '{{B}}');
});

test('parseModels：非法 JSON 回退空对象', () => {
  assert.deepEqual(parseModels('not json'), {});
  assert.deepEqual(parseModels(''), {});
});

test('noteToCard：模板渲染（HTML 清洗）', () => {
  const model = { fields: ['问题', '答案'], qfmt: '{{问题}}', afmt: '{{答案}}<br>助记' };
  const r = noteToCard('什么是死锁\x1f互相等待资源', model);
  assert.equal(r.front, '什么是死锁');
  assert.equal(r.back, '互相等待资源\n助记');
});

test('noteToCard：无模板降级为「第 1 字段正面 + 其余背面」', () => {
  const r = noteToCard('正面文本\x1f背面文本1\x1f背面文本2', { fields: ['a', 'b', 'c'], qfmt: '', afmt: '' });
  assert.equal(r.front, '正面文本');
  assert.equal(r.back, '背面文本1\n背面文本2');
});

test('buildCardsFromRows：聚合 + 跳过空正面', () => {
  const models = { '1': { fields: ['q', 'a'], qfmt: '{{q}}', afmt: '{{a}}' } };
  const rows = [
    [1, '1', 'Q1\x1fA1', 't1 t2'],
    [2, '1', '\x1fA2', 't3'],        // 正面空 → 跳过
    [3, '1', 'Q3\x1fA3', ''],
  ];
  const cards = buildCardsFromRows(rows, models);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].front, 'Q1');
  assert.deepEqual(cards[0].tags, ['t1', 't2']);
  assert.equal(cards[1].front, 'Q3');
  assert.deepEqual(cards[1].tags, []);
});
