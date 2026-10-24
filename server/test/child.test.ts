import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { containChildStdio } from '../src/child.ts';

test('a child stdout Pipe error is contained and stops that child, not the server', () => {
  const stdout = new EventEmitter();
  let killed = 0;
  containChildStdio({ stdin: null, stdout, stderr: null, killed: false, kill: () => { killed++; return true; } } as any);
  assert.equal(stdout.listenerCount('error'), 1);
  const original = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => stdout.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })));
  } finally { console.error = original; }
  assert.equal(killed, 1);
});
