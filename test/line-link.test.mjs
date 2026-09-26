import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLinkCode, parseLinkCode } from '../src/line-link.mjs';

test('makeLinkCode: MEO- と紛らわしくない6文字', () => {
  for (let i = 0; i < 200; i++) {
    const code = makeLinkCode();
    assert.match(code, /^MEO-[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(parseLinkCode(code), code);
  }
});

test('parseLinkCode: 小文字・ハイフン無し・前後の空白を許す', () => {
  assert.equal(parseLinkCode(' meo-abc234 '), 'MEO-ABC234');
  assert.equal(parseLinkCode('MEOABC234'), 'MEO-ABC234');
  assert.equal(parseLinkCode('MEO- ABC234'), 'MEO-ABC234');
});

test('parseLinkCode: GBP Notify の6文字コードや普通の文は拾わない', () => {
  assert.equal(parseLinkCode('ABC234'), null);
  assert.equal(parseLinkCode('こんにちは'), null);
  assert.equal(parseLinkCode('MEO-ABC23'), null);
  assert.equal(parseLinkCode('MEO-ABC0I1'), null);
  assert.equal(parseLinkCode(undefined), null);
});
