import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { appsumoSignature } from './appsumo.ts';
import { appsumoPeople, personKey } from '../src/lib/plans.ts';

test('webhook signature is HMAC-SHA256 of timestamp + body with the API key', async () => {
  const body = JSON.stringify({ license_key: 'abc', event: 'activate', tier: 2 });
  const want = createHmac('sha256', 'secret-key').update('1700000000' + body).digest('hex');
  expect(await appsumoSignature('secret-key', '1700000000', body)).toBe(want);
});

test('tiers and person keys', () => {
  expect([appsumoPeople(1), appsumoPeople(2), appsumoPeople(3), appsumoPeople(9), appsumoPeople(0)]).toEqual([15, 40, 100, 100, 15]);
  // The same person on two sheets counts once; unnamed rows count each.
  expect(personKey('a', 'r1', { name: 'Ava', email: 'Ava@X.com ' })).toBe(personKey('b', 'r9', { name: 'Ava P', email: 'ava@x.com' }));
  expect(personKey('a', 'r1', { name: 'Noah' })).toBe(personKey('b', 'r2', { name: ' noah ' }));
  expect(personKey('a', 'r1', { name: 'New person' })).not.toBe(personKey('a', 'r2', { name: 'New person' }));
});
