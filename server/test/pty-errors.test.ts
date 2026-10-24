import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { containPtyErrors } from '../src/direct.ts';

test('a closed PTY socket error stays inside the terminal instead of crashing the server', () => {
  const pty = new EventEmitter();
  // node-pty installs this listener first and throws unless its host installs another one.
  pty.on('error', (error) => { if (pty.listenerCount('error') < 2) throw error; });
  containPtyErrors(pty as any);
  assert.doesNotThrow(() => pty.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })));
});
