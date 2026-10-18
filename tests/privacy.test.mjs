import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripPrivate, isFullyPrivate, redactSecrets, truncate, clean } from '../plugin/lib/privacy.mjs';

test('private tags are removed', () => {
  assert.equal(stripPrivate('a <private>secret plan</private> b'), 'a [private content removed] b');
  assert.equal(stripPrivate('x <PRIVATE>unterminated'), 'x [private content removed]');
  assert.ok(isFullyPrivate('<private>all of it</private>'));
  assert.ok(isFullyPrivate('  <private>a</private> <private>b</private> '));
  assert.ok(!isFullyPrivate('hello <private>a</private>'));
  assert.ok(!isFullyPrivate('no tags'));
});

test('known secret formats are redacted', () => {
  const cases = [
    'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
    'AKIAIOSFODNN7EXAMPLE',
    'xoxb-1234567890-abcdefghij',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
  ];
  for (const c of cases) {
    const out = redactSecrets(`value: ${c} end`);
    assert.ok(!out.includes(c), `not redacted: ${c} -> ${out}`);
    assert.match(out, /\[REDACTED:/);
  }
});

test('secret-looking assignments are redacted but code stays readable', () => {
  assert.equal(redactSecrets('password=hunter2xyz'), 'password=[REDACTED:secret]');
  assert.equal(redactSecrets('"api_key": "abc123def456"'), '"api_key": "[REDACTED:secret]"');
  assert.equal(redactSecrets('DB_PASSWORD: s3cr3tvalue'), 'DB_PASSWORD: [REDACTED:secret]');
  assert.equal(redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123'), 'Authorization: Bearer [REDACTED:token]');
  assert.equal(redactSecrets('postgres://user:pa55word@db:5432/x'), 'postgres://[REDACTED:credentials]@db:5432/x');
  // references to env vars are not secrets
  assert.equal(redactSecrets('token = process.env.GITHUB_TOKEN'), 'token = process.env.GITHUB_TOKEN');
  assert.equal(redactSecrets('const tokenizer = new Tokenizer()'), 'const tokenizer = new Tokenizer()');
});

test('truncate keeps head and tail', () => {
  const t = truncate('a'.repeat(100) + 'END', 50);
  assert.ok(t.length < 120);
  assert.match(t, /truncated/);
  assert.ok(t.endsWith('END'));
  assert.equal(truncate('short', 50), 'short');
});

test('clean stringifies objects and applies everything', () => {
  const out = clean({ cmd: 'curl -H "x-api-key: sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"', note: '<private>hide</private>' });
  assert.ok(!out.includes('sk-ant-api03'));
  assert.ok(!out.includes('hide'));
});
