import assert from 'node:assert/strict';
import test from 'node:test';
import { upsertDailyGemsIssue } from '../scripts/upsert-daily-gems-issue.mjs';

const input = {
  repository: 'sujithq/mycrypto',
  token: 'test-token',
  issueTitle: '[Daily Gems] 2026-08-24 - Proposed EUR 500 real profile',
  issueBody: '<!-- daily-gems:2026-08-24 -->\nIssue body',
  date: '2026-08-24',
};

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('updates the existing issue identified by its daily marker', async () => {
  const requests = [];
  const result = await upsertDailyGemsIssue(input, {
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      if (requests.length === 1) {
        return jsonResponse([{
          number: 42,
          title: 'An older generated title',
          body: '<!-- daily-gems:2026-08-24 -->\nOld body',
        }]);
      }
      return jsonResponse({
        number: 42,
        html_url: 'https://github.com/sujithq/mycrypto/issues/42',
      });
    },
  });

  assert.deepEqual(result, {
    action: 'updated',
    number: 42,
    url: 'https://github.com/sujithq/mycrypto/issues/42',
  });
  assert.equal(requests[1].url.pathname, '/repos/sujithq/mycrypto/issues/42');
  assert.equal(requests[1].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    title: input.issueTitle,
    body: input.issueBody,
  });
});

test('creates a labeled issue when the UTC date has no existing issue', async () => {
  const requests = [];
  const result = await upsertDailyGemsIssue(input, {
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      if (requests.length === 1) return jsonResponse([]);
      return jsonResponse({
        number: 43,
        html_url: 'https://github.com/sujithq/mycrypto/issues/43',
      }, 201);
    },
  });

  assert.equal(result.action, 'created');
  assert.equal(requests[1].url.pathname, '/repos/sujithq/mycrypto/issues');
  assert.equal(requests[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[1].options.body).labels, [
    'daily-gems',
    'generated',
    'decision-needed',
  ]);
});

test('requires a valid repository and matching daily marker', async () => {
  await assert.rejects(upsertDailyGemsIssue({
    ...input,
    repository: 'invalid',
  }), /owner\/repository/);
  await assert.rejects(upsertDailyGemsIssue({
    ...input,
    issueBody: 'No marker',
  }), /missing its daily marker/);
});

test('surfaces GitHub API failures', async () => {
  await assert.rejects(upsertDailyGemsIssue(input, {
    fetchImpl: async () => new Response('rate limited', { status: 403 }),
  }), /GitHub API request failed \(403\): rate limited/);
});