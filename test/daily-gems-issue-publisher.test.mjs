import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractDailyGemsSelections,
  upsertDailyGemsIssue,
} from '../scripts/upsert-daily-gems-issue.mjs';

const input = {
  repository: 'sujithq/mycrypto',
  token: 'test-token',
  issueTitle: '[Daily Gems] 2026-08-24 - Proposed EUR 500 real profile',
  issueBody: '<!-- daily-gems:2026-08-24 -->\nIssue body',
  date: '2026-08-24',
};

function generatedBody(date, selections) {
  const profiles = Object.entries(selections).map(([mode, portfolio]) => `\`\`\`json
${JSON.stringify({
    id: `gems-${mode.toLowerCase()}-${date}`,
    portfolio,
  })}
\`\`\``);
  return `<!-- daily-gems:${date} -->\nIssue body\n\n${profiles.join('\n\n')}`;
}

const asset = (id, symbol, name) => ({ id, symbol, name });

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('updates the existing issue identified by its daily marker', async () => {
  const requests = [];
  const progress = [];
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
    onProgress: (message) => progress.push(message),
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
  assert.deepEqual(progress, [
    'Checking sujithq/mycrypto for the 2026-08-24 daily issue.',
    'Updating existing issue #42.',
  ]);
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

test('appends asset replacements from the most recent previous generated issue', async () => {
  const requests = [];
  const progress = [];
  const previousSelections = {
    EUR: [asset('shared', 'SAME', 'Shared'), asset('old-eur', 'OLD', 'Old EUR')],
    USD: [asset('same-usd', 'USD', 'Same USD')],
    MIXED: [asset('old-mixed', 'MIXOLD', 'Old Mixed')],
  };
  const currentSelections = {
    EUR: [asset('shared', 'SAME', 'Shared'), asset('new-eur', 'NEW', 'New EUR')],
    USD: [asset('same-usd', 'USD', 'Same USD')],
    MIXED: [asset('new-mixed', 'MIXNEW', 'New Mixed')],
  };
  const currentInput = {
    ...input,
    issueBody: generatedBody(input.date, currentSelections),
  };

  await upsertDailyGemsIssue(currentInput, {
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      if (requests.length === 1) {
        return jsonResponse([{
          number: 41,
          title: '[Daily Gems] 2026-08-23',
          body: generatedBody('2026-08-23', previousSelections),
          html_url: 'https://github.com/sujithq/mycrypto/issues/41',
        }]);
      }
      return jsonResponse({
        number: 42,
        html_url: 'https://github.com/sujithq/mycrypto/issues/42',
      }, 201);
    },
    onProgress: (message) => progress.push(message),
  });

  const publishedBody = JSON.parse(requests[1].options.body).body;
  assert.match(publishedBody, /## Changes from the previous daily issue/);
  assert.match(publishedBody, /Compared with \[#41\].* from 2026-08-23\./);
  assert.match(publishedBody, /`OLD` \(Old EUR\) was replaced by `NEW` \(New EUR\)\./);
  assert.match(publishedBody, /### USD-only\n\n- No asset replacements\./);
  assert.match(publishedBody, /`MIXOLD` \(Old Mixed\) was replaced by `MIXNEW` \(New Mixed\)\./);
  assert.equal(publishedBody.trimEnd().endsWith('`MIXNEW` (New Mixed).'), true);
  assert.deepEqual(progress, [
    'Checking sujithq/mycrypto for the 2026-08-24 daily issue.',
    'Compared selections with previous daily issue #41.',
    'Creating a new issue with labels: daily-gems, generated, decision-needed.',
  ]);
});

test('falls back to the latest parseable earlier issue and ignores pull requests', async () => {
  const requests = [];
  const priorBody = generatedBody('2026-08-21', {
    EUR: [asset('old-eur', 'OLD', 'Old EUR')],
  });
  const currentInput = {
    ...input,
    issueBody: generatedBody(input.date, {
      EUR: [asset('new-eur', 'NEW', 'New EUR')],
    }),
  };

  await upsertDailyGemsIssue(currentInput, {
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      if (requests.length === 1) {
        return jsonResponse([
          {
            number: 44,
            body: generatedBody('2026-08-23', {
              EUR: [asset('pr-asset', 'PR', 'Pull Request Asset')],
            }),
            pull_request: { url: 'https://api.github.com/pulls/44' },
          },
          {
            number: 43,
            body: '<!-- daily-gems:2026-08-22 -->\nNo profile JSON',
          },
          {
            number: 41,
            body: priorBody,
            html_url: 'https://github.com/sujithq/mycrypto/issues/41',
          },
        ]);
      }
      return jsonResponse({ number: 45, html_url: 'https://github.com/sujithq/mycrypto/issues/45' }, 201);
    },
  });

  const publishedBody = JSON.parse(requests[1].options.body).body;
  assert.match(publishedBody, /Compared with \[#41\].* from 2026-08-21\./);
  assert.doesNotMatch(publishedBody, /#43|#44|Pull Request Asset/);
});

test('infers the quote mode from legacy profile trading currencies', () => {
  const legacyProfile = {
    id: 'legacy-profile',
    portfolio: [
      {
        ...asset('usd-asset', 'USD', 'USD Asset'),
        tradingQuoteCurrency: 'USD',
      },
    ],
  };
  const selections = extractDailyGemsSelections(`\`\`\`json\n${JSON.stringify(legacyProfile)}\n\`\`\``);

  assert.deepEqual(selections, {
    USD: [asset('usd-asset', 'USD', 'USD Asset')],
  });
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