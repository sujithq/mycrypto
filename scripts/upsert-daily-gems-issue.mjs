import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ISSUE_LABELS = ['daily-gems', 'generated', 'decision-needed'];
const QUOTE_MODES = ['EUR', 'USD', 'MIXED'];
const MAX_GITHUB_ISSUE_BODY_CHARACTERS = 65_536;

function repositoryParts(repositoryInput) {
  const repository = String(repositoryInput ?? '').trim();
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository);
  if (!match) throw new Error('GITHUB_REPOSITORY must use the owner/repository format.');
  return { owner: match[1], repository: match[2] };
}

async function githubRequest(endpoint, {
  token,
  apiUrl,
  fetchImpl,
  method = 'GET',
  body,
} = {}) {
  const response = await fetchImpl(`${apiUrl}${endpoint}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'mycrypto-daily-gems-workflow/1.0',
      'x-github-api-version': '2022-11-28',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const detail = typeof response.text === 'function' ? (await response.text()).slice(0, 500) : '';
    throw new Error(`GitHub API request failed (${response.status}): ${detail}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function dailyIssueDate(issue) {
  return /<!-- daily-gems:(\d{4}-\d{2}-\d{2}) -->/.exec(String(issue?.body ?? ''))?.[1] ?? null;
}

function profileQuoteMode(profile) {
  const profileId = String(profile?.id ?? '').toLowerCase();
  const idMatch = /^gems-(eur|usd|mixed)-/.exec(profileId);
  if (idMatch) return idMatch[1].toUpperCase();
  const quoteCurrencies = new Set((profile?.portfolio ?? [])
    .map(({ tradingQuoteCurrency }) => String(tradingQuoteCurrency ?? '').toUpperCase())
    .filter(Boolean));
  if (quoteCurrencies.size > 1) return 'MIXED';
  const [quoteCurrency] = quoteCurrencies;
  return quoteCurrency === 'EUR' || quoteCurrency === 'USD' ? quoteCurrency : null;
}

function profileSelection(profile) {
  if (!Array.isArray(profile?.portfolio)) return null;
  const assets = profile.portfolio.map((asset) => ({
    id: String(asset?.id ?? '').trim(),
    symbol: String(asset?.symbol ?? '').trim().toUpperCase(),
    name: String(asset?.name ?? '').trim(),
  }));
  return assets.length > 0 && assets.every(({ id, symbol, name }) => id && symbol && name)
    ? assets
    : null;
}

export function extractDailyGemsSelections(issueBody) {
  const selections = {};
  for (const match of String(issueBody ?? '').matchAll(/```json\s*([\s\S]*?)\s*```/g)) {
    let value;
    try {
      value = JSON.parse(match[1]);
    } catch {
      continue;
    }
    const profiles = [
      value,
      value?.profile,
      ...(Array.isArray(value?.modePackages)
        ? value.modePackages.map(({ profile }) => profile)
        : []),
    ];
    for (const profile of profiles) {
      const mode = profileQuoteMode(profile);
      const assets = profileSelection(profile);
      if (mode && assets && !selections[mode]) selections[mode] = assets;
    }
  }
  return selections;
}

function markdownText(value) {
  return String(value ?? '').replace(/[`\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function assetLabel(asset) {
  return `\`${markdownText(asset.symbol)}\` (${markdownText(asset.name)})`;
}

function replacementLines(previousAssets, currentAssets) {
  if (!previousAssets || !currentAssets) return ['- No comparable selection in both issues.'];
  const previousIds = new Set(previousAssets.map(({ id }) => id));
  const currentIds = new Set(currentAssets.map(({ id }) => id));
  const removed = previousAssets.filter(({ id }) => !currentIds.has(id));
  const added = currentAssets.filter(({ id }) => !previousIds.has(id));
  if (removed.length === 0 && added.length === 0) return ['- No asset replacements.'];

  const lines = [];
  const pairedCount = Math.min(removed.length, added.length);
  for (let index = 0; index < pairedCount; index += 1) {
    lines.push(`- ${assetLabel(removed[index])} was replaced by ${assetLabel(added[index])}.`);
  }
  for (const asset of removed.slice(pairedCount)) {
    lines.push(`- ${assetLabel(asset)} was removed without a replacement.`);
  }
  for (const asset of added.slice(pairedCount)) {
    lines.push(`- ${assetLabel(asset)} was added without replacing another asset.`);
  }
  return lines;
}

export function appendReplacementSummary(issueBody, previousIssue) {
  const previousDate = dailyIssueDate(previousIssue);
  const previousSelections = extractDailyGemsSelections(previousIssue?.body);
  const currentSelections = extractDailyGemsSelections(issueBody);
  const comparableModes = QUOTE_MODES.filter((mode) =>
    previousSelections[mode] && currentSelections[mode]);
  if (!previousDate || comparableModes.length === 0) return issueBody;

  const issueReference = previousIssue.html_url
    ? `[#${previousIssue.number}](${previousIssue.html_url})`
    : `#${previousIssue.number}`;
  const modeLabels = {
    EUR: 'EUR-only',
    USD: 'USD-only',
    MIXED: 'MIXED (EUR preferred)',
  };
  const sections = comparableModes.map((mode) => [
    `### ${modeLabels[mode]}`,
    '',
    ...replacementLines(previousSelections[mode], currentSelections[mode]),
  ].join('\n'));
  const summary = [
    '## Changes from the previous daily issue',
    `Compared with ${issueReference} from ${previousDate}.`,
    ...sections,
  ].join('\n\n');
  const body = `${issueBody.trimEnd()}\n\n${summary}\n`;
  if (body.length > MAX_GITHUB_ISSUE_BODY_CHARACTERS) {
    throw new Error(`Issue body with replacement summary has ${body.length} characters and exceeds the ${MAX_GITHUB_ISSUE_BODY_CHARACTERS}-character limit.`);
  }
  return body;
}

export async function upsertDailyGemsIssue({
  repository: repositoryInput,
  token,
  issueTitle,
  issueBody,
  date,
}, {
  apiUrl = 'https://api.github.com',
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
} = {}) {
  const { owner, repository } = repositoryParts(repositoryInput);
  if (!token) throw new Error('GITHUB_TOKEN is required.');
  if (!issueTitle || !issueBody || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    throw new Error('Issue title, body, and UTC date are required.');
  }

  const marker = `<!-- daily-gems:${date} -->`;
  if (!issueBody.includes(marker)) {
    throw new Error(`Issue body is missing its daily marker: ${marker}`);
  }
  onProgress(`Checking ${owner}/${repository} for the ${date} daily issue.`);
  const issues = await githubRequest(
    `/repos/${owner}/${repository}/issues?state=all&sort=created&direction=desc&per_page=100`,
    { token, apiUrl, fetchImpl },
  );
  if (!Array.isArray(issues)) throw new Error('GitHub returned an invalid issue list.');

  const existing = issues.find((issue) => !issue.pull_request
    && (issue.body?.includes(marker) || issue.title === issueTitle));
  const previous = issues
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      issue,
      date: dailyIssueDate(issue),
      selections: extractDailyGemsSelections(issue.body),
    }))
    .filter(({ date: issueDate, selections }) => issueDate
      && issueDate < date
      && Object.keys(selections).length > 0)
    .sort((left, right) => right.date.localeCompare(left.date))[0]?.issue;
  const publishedIssueBody = previous
    ? appendReplacementSummary(issueBody, previous)
    : issueBody;
  if (previous) {
    onProgress(`Compared selections with previous daily issue #${previous.number}.`);
  }
  if (existing) {
    onProgress(`Updating existing issue #${existing.number}.`);
    const issue = await githubRequest(
      `/repos/${owner}/${repository}/issues/${existing.number}`,
      {
        token,
        apiUrl,
        fetchImpl,
        method: 'PATCH',
        body: { title: issueTitle, body: publishedIssueBody },
      },
    );
    return {
      action: 'updated',
      number: issue.number,
      url: issue.html_url,
    };
  }

  onProgress(`Creating a new issue with labels: ${ISSUE_LABELS.join(', ')}.`);
  const issue = await githubRequest(`/repos/${owner}/${repository}/issues`, {
    token,
    apiUrl,
    fetchImpl,
    method: 'POST',
    body: {
      title: issueTitle,
      body: publishedIssueBody,
      labels: ISSUE_LABELS,
    },
  });
  return {
    action: 'created',
    number: issue.number,
    url: issue.html_url,
  };
}

function parseArguments(args) {
  const options = {};
  const values = [...args];
  while (values.length > 0) {
    const argument = values.shift();
    const value = values.shift();
    if (!value) throw new Error(`${argument} requires a value.`);
    if (argument === '--body') options.bodyPath = value;
    else if (argument === '--summary') options.summaryPath = value;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.bodyPath || !options.summaryPath) {
    throw new Error('Provide --body and --summary files.');
  }
  return options;
}

async function main(args) {
  const { bodyPath, summaryPath } = parseArguments(args);
  const progress = (message) => console.error(`[daily-gems] ${message}`);
  progress('Loading generated issue body and publication summary.');
  const [issueBody, summaryText] = await Promise.all([
    readFile(path.resolve(bodyPath), 'utf8'),
    readFile(path.resolve(summaryPath), 'utf8'),
  ]);
  const summary = JSON.parse(summaryText);
  const result = await upsertDailyGemsIssue({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN,
    issueTitle: summary.issueTitle,
    issueBody,
    date: summary.date,
  }, {
    apiUrl: process.env.GITHUB_API_URL || undefined,
    onProgress: progress,
  });
  console.log(JSON.stringify(result));
  progress(`Issue ${result.action}: #${result.number} ${result.url}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `Daily gems issue ${result.action}: [#${result.number}](${result.url})\n`,
    );
  }
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}