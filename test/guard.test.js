import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedHosts, checkOrigin, hostName } from '../lib/guard.js';

const hosts = allowedHosts('guild.example');
const refused = (headers) => assert.throws(() => checkOrigin(headers, hosts), (e) => e.status === 403);

test('host names lose their port and brackets', () => {
  assert.equal(hostName('LocalHost:7777'), 'localhost');
  assert.equal(hostName('[::1]:7777'), '::1');
  assert.equal(hostName('127.0.0.1'), '127.0.0.1');
});

test('requests without an Origin pass when the Host is this server', () => {
  for (const host of ['localhost:7777', '127.0.0.1:7777', '[::1]:7777', 'guild.example']) checkOrigin({ host }, hosts);
});

test('an unknown Host is refused (DNS rebinding)', () => {
  refused({ host: 'evil.example:7777' });
  refused({});
});

test('a same-origin browser request passes; a cross-site one is refused', () => {
  checkOrigin({ host: 'localhost:7777', origin: 'http://localhost:7777' }, hosts);
  refused({ host: 'localhost:7777', origin: 'https://evil.example' });
  refused({ host: 'localhost:7777', origin: 'http://localhost:8080' });
  refused({ host: 'localhost:7777', origin: 'null' }); // sandboxed attachments
});
