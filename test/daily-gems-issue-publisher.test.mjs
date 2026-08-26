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
const compactAsset = (id, symbol) => ({ id, symbol });

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
    EUR: [compactAsset('shared', 'SAME'), compactAsset('old-eur', 'OLD')],
    USD: [compactAsset('same-usd', 'USD')],
    MIXED: [compactAsset('old-mixed', 'MIXOLD')],
  };
  const currentSelections = {
    EUR: [compactAsset('shared', 'SAME'), compactAsset('new-eur', 'NEW')],
    USD: [compactAsset('same-usd', 'USD')],
    MIXED: [compactAsset('new-mixed', 'MIXNEW')],
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
  assert.match(publishedBody, /`OLD` was replaced by `NEW`\./);
  assert.match(publishedBody, /### USD-only\n\n- No asset replacements\./);
  assert.match(publishedBody, /`MIXOLD` was replaced by `MIXNEW`\./);
  assert.equal(publishedBody.trimEnd().endsWith('`MIXNEW`.'), true);
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

test('infers a compact legacy profile mode from its adoption manifest', () => {
  const legacyPackage = {
    ranking: {
      tradingVenue: { quoteCurrencyMode: 'EUR' },
    },
    profile: {
      id: 'gems-2026-08-23',
      portfolio: [compactAsset('legacy-eur', 'OLD')],
    },
  };
  const selections = extractDailyGemsSelections(
    `\`\`\`json\n${JSON.stringify(legacyPackage)}\n\`\`\``,
  );

  assert.deepEqual(selections, {
    EUR: [{ id: 'legacy-eur', symbol: 'OLD', name: '' }],
  });
});

test('prefers explicit legacy mode evidence over the unqualified EUR fallback', () => {
  const usdPackage = {
    ranking: { tradingVenue: { quoteCurrencyMode: 'EUR' } },
    profile: {
      id: 'gems-2026-08-23',
      portfolio: [{
        ...compactAsset('legacy-usd', 'USD'),
        tradingQuoteCurrency: 'USD',
      }],
    },
  };
  const mixedPackage = {
    ranking: { tradingVenue: { quoteCurrencyMode: 'MIXED' } },
    profile: {
      id: 'gems-2026-08-22',
      portfolio: [compactAsset('legacy-mixed', 'MIX')],
    },
  };

  assert.deepEqual(extractDailyGemsSelections([
    `\`\`\`json\n${JSON.stringify(usdPackage)}\n\`\`\``,
    `\`\`\`json\n${JSON.stringify(mixedPackage)}\n\`\`\``,
  ].join('\n')), {
    USD: [{ id: 'legacy-usd', symbol: 'USD', name: '' }],
    MIXED: [{ id: 'legacy-mixed', symbol: 'MIX', name: '' }],
  });
});

test('resolves a standalone legacy profile using its later full-manifest mode', () => {
  const legacyProfile = {
    id: 'gems-2026-08-21',
    portfolio: [compactAsset('legacy-usd', 'USD')],
  };
  const historicalBody = [
    `\`\`\`json\n${JSON.stringify(legacyProfile)}\n\`\`\``,
    `\`\`\`json\n${JSON.stringify({
      ranking: { tradingVenue: { quoteCurrencyMode: 'USD' } },
      profile: legacyProfile,
    })}\n\`\`\``,
  ].join('\n');

  assert.deepEqual(extractDailyGemsSelections(historicalBody), {
    USD: [{ id: 'legacy-usd', symbol: 'USD', name: '' }],
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

test('rejects an oversized body before querying GitHub', async () => {
  let requestCount = 0;
  await assert.rejects(upsertDailyGemsIssue({
    ...input,
    issueBody: `<!-- daily-gems:2026-08-24 -->\n${'x'.repeat(65_536)}`,
  }, {
    fetchImpl: async () => {
      requestCount += 1;
      return jsonResponse([]);
    },
  }), /Issue body has \d+ characters and exceeds the 65536-character limit/);
  assert.equal(requestCount, 0);
});

test('surfaces GitHub API failures', async () => {
  await assert.rejects(upsertDailyGemsIssue(input, {
    fetchImpl: async () => new Response('rate limited', { status: 403 }),
  }), /GitHub API request failed \(403\): rate limited/);
});

test('treats an unqualified legacy daily profile as EUR', () => {
  const legacyProfile = {
    id: 'gems-2026-08-22',
    portfolio: [compactAsset('legacy-eur', 'OLD')],
  };

  assert.deepEqual(
    extractDailyGemsSelections(`\`\`\`json\n${JSON.stringify(legacyProfile)}\n\`\`\``),
    { EUR: [{ id: 'legacy-eur', symbol: 'OLD', name: '' }] },
  );
});