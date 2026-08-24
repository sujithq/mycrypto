import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ISSUE_LABELS = ['daily-gems', 'generated', 'decision-needed'];

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

export async function upsertDailyGemsIssue({
  repository: repositoryInput,
  token,
  issueTitle,
  issueBody,
  date,
}, {
  apiUrl = 'https://api.github.com',
  fetchImpl = globalThis.fetch,
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
  const issues = await githubRequest(
    `/repos/${owner}/${repository}/issues?state=all&sort=created&direction=desc&per_page=100`,
    { token, apiUrl, fetchImpl },
  );
  if (!Array.isArray(issues)) throw new Error('GitHub returned an invalid issue list.');

  const existing = issues.find((issue) => !issue.pull_request
    && (issue.body?.includes(marker) || issue.title === issueTitle));
  if (existing) {
    const issue = await githubRequest(
      `/repos/${owner}/${repository}/issues/${existing.number}`,
      {
        token,
        apiUrl,
        fetchImpl,
        method: 'PATCH',
        body: { title: issueTitle, body: issueBody },
      },
    );
    return {
      action: 'updated',
      number: issue.number,
      url: issue.html_url,
    };
  }

  const issue = await githubRequest(`/repos/${owner}/${repository}/issues`, {
    token,
    apiUrl,
    fetchImpl,
    method: 'POST',
    body: {
      title: issueTitle,
      body: issueBody,
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
  });
  console.log(JSON.stringify(result));
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