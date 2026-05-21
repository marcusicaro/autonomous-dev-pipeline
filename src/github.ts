import { getGithubToken, getGithubRepo } from './config.js';
import type { JiraIssue } from './jira.js';
import type { AnalysisResult } from './analyzer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  html_url: string;
  labels: Array<{ name: string }>;
  state: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helper
// ─────────────────────────────────────────────────────────────────────────────

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${getGithubToken()}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function repoUrl(path: string): string {
  return `https://api.github.com/repos/${getGithubRepo()}${path}`;
}

async function ghFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: { ...headers(), ...((options.headers as Record<string, string>) ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status}: ${res.statusText}\n${body}`);
  }
  const text = await res.text();
  if (!text) return undefined as unknown as T;
  return JSON.parse(text) as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue creation (pipeline → create + label → trigger assign)
// ─────────────────────────────────────────────────────────────────────────────

function buildIssueBody(issue: JiraIssue, analysis: AnalysisResult): string {
  const lines: string[] = [
    `> 🤖 Auto-created from Jira task [${issue.key}](${issue.url})`,
    `> Complexity: **${analysis.verdict}** (${analysis.confidence}% confidence)`,
    '',
    '## Task Description',
    '',
    issue.description ?? issue.summary,
    '',
    '## Acceptance Criteria',
    '',
  ];

  if (issue.acceptanceCriteria) {
    for (const line of issue.acceptanceCriteria.split('\n').filter(Boolean)) {
      const t = line.trim();
      if (t.startsWith('- [')) lines.push(t);
      else if (t.startsWith('-') || t.startsWith('*')) lines.push(`- [ ] ${t.slice(1).trim()}`);
      else lines.push(`- [ ] ${t}`);
    }
  } else {
    lines.push('_See task description above._');
  }

  if (analysis.suggestedArea.length > 0) {
    lines.push('', '## Affected Area', '', analysis.suggestedArea.join(', '));
  }

  lines.push(
    '', '## AI Analysis', '',
    `**Verdict:** ${analysis.verdict} (${analysis.confidence}%)`,
    `**Estimated files:** ~${analysis.estimatedFiles}`,
    `**Complexity:** ${analysis.suggestedComplexity}`,
    `**Reasoning:** ${analysis.reasoning}`,
  );

  if (analysis.riskFactors.length > 0) {
    lines.push('', '**Risk factors:**');
    for (const r of analysis.riskFactors) lines.push(`- ⚠️ ${r}`);
  }

  lines.push(
    '', '## Additional Context', '',
    `- **Jira:** [${issue.key}](${issue.url})`,
    `- **Type:** ${issue.issueType}`,
    `- **Priority:** ${issue.priority}`,
    `- **Sprint:** ${issue.sprintName}`,
  );

  if (issue.labels.length > 0) lines.push(`- **Labels:** ${issue.labels.join(', ')}`);
  if (issue.subtasks.length > 0) {
    lines.push('', '### Subtasks');
    for (const st of issue.subtasks) {
      lines.push(`${st.status.toLowerCase() === 'done' ? '✅' : '⬜'} [${st.key}] ${st.summary} (${st.status})`);
    }
  }

  return lines.join('\n');
}

export async function findExistingIssue(jiraKey: string): Promise<GitHubIssue | null> {
  const q = encodeURIComponent(`repo:${getGithubRepo()} is:issue "${jiraKey}" in:title label:copilot-task`);
  const data = await ghFetch<{ items: GitHubIssue[] }>(
    `https://api.github.com/search/issues?q=${q}&per_page=5`,
  );
  return data.items.length > 0 ? data.items[0]! : null;
}

export async function createCopilotIssue(issue: JiraIssue, analysis: AnalysisResult): Promise<GitHubIssue> {
  const labels = ['copilot-task'];
  for (const area of analysis.suggestedArea) {
    const l = area.toLowerCase();
    if (l === 'frontend') labels.push('frontend');
    if (l === 'backend') labels.push('backend');
    if (l === 'shared') labels.push('shared');
    if (l === 'database') labels.push('database');
  }

  return ghFetch<GitHubIssue>(repoUrl('/issues'), {
    method: 'POST',
    body: JSON.stringify({ title: `[${issue.key}] ${issue.summary}`, body: buildIssueBody(issue, analysis), labels }),
  });
}

export async function addAssignee(issueNumber: number, assignee: string): Promise<void> {
  await ghFetch(repoUrl(`/issues/${issueNumber}/assignees`), {
    method: 'POST',
    body: JSON.stringify({ assignees: [assignee] }),
  });
}

// GitHub Copilot's coding agent is a Bot, not a User. The REST `assignees`
// endpoint silently ignores Bots — they must be assigned via GraphQL.
async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL ${res.status}: ${await res.text()}`);
  const json = await res.json() as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(`GraphQL errors: ${json.errors.map(e => e.message).join('; ')}`);
  return json.data as T;
}

let cachedCopilotBotId: string | null = null;

async function getCopilotBotId(): Promise<string> {
  if (cachedCopilotBotId) return cachedCopilotBotId;
  const [owner, name] = getGithubRepo().split('/');
  const data = await graphql<{ repository: { suggestedActors: { nodes: Array<{ login: string; id: string; __typename: string }> } } }>(
    `query($owner:String!,$name:String!){
      repository(owner:$owner,name:$name){
        suggestedActors(capabilities:[CAN_BE_ASSIGNED],first:50){
          nodes{__typename ... on Bot{id login} ... on User{id login}}
        }
      }
    }`,
    { owner, name },
  );
  const bot = data.repository.suggestedActors.nodes.find(
    n => n.__typename === 'Bot' && /copilot/i.test(n.login),
  );
  if (!bot) {
    throw new Error(
      `Copilot bot is not assignable on ${getGithubRepo()}. Enable GitHub Copilot coding agent for this repo (Settings → Copilot → Coding agent) and ensure a paid Copilot subscription with coding-agent access.`,
    );
  }
  cachedCopilotBotId = bot.id;
  return bot.id;
}

export async function assignCopilot(issueNumber: number): Promise<void> {
  const [owner, name] = getGithubRepo().split('/');
  const { repository } = await graphql<{ repository: { issue: { id: string } } }>(
    `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){id}}}`,
    { owner, name, n: issueNumber },
  );
  const botId = await getCopilotBotId();
  await graphql(
    `mutation($i:ID!,$a:[ID!]!){replaceActorsForAssignable(input:{assignableId:$i,actorIds:$a}){clientMutationId}}`,
    { i: repository.issue.id, a: [botId] },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue enrichment (enrich / poll-enrich commands)
// ─────────────────────────────────────────────────────────────────────────────

export async function getIssue(issueNumber: number): Promise<GitHubIssue> {
  return ghFetch<GitHubIssue>(repoUrl(`/issues/${issueNumber}`));
}

export async function updateIssueBody(issueNumber: number, body: string): Promise<void> {
  await ghFetch(repoUrl(`/issues/${issueNumber}`), {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  });
}

export async function addIssueLabel(issueNumber: number, label: string): Promise<void> {
  await ghFetch(repoUrl(`/issues/${issueNumber}/labels`), {
    method: 'POST',
    body: JSON.stringify({ labels: [label] }),
  });
}

export async function getIssueLabels(issueNumber: number): Promise<string[]> {
  const labels = await ghFetch<Array<{ name: string }>>(repoUrl(`/issues/${issueNumber}/labels`));
  return labels.map(l => l.name);
}

export async function createIssueComment(issueNumber: number, body: string): Promise<void> {
  await ghFetch(repoUrl(`/issues/${issueNumber}/comments`), {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

/** Search for open issues that have `withLabel` but not `withoutLabel`. */
export async function searchIssuesByLabel(withLabel: string, withoutLabel: string): Promise<GitHubIssue[]> {
  const q = encodeURIComponent(
    `repo:${getGithubRepo()} is:issue is:open label:${withLabel} -label:${withoutLabel}`,
  );
  const data = await ghFetch<{ items: GitHubIssue[] }>(
    `https://api.github.com/search/issues?q=${q}&per_page=20`,
  );
  return data.items;
}

// ─────────────────────────────────────────────────────────────────────────────
// Labels
// ─────────────────────────────────────────────────────────────────────────────

export async function ensureLabel(name: string, color: string, description: string): Promise<void> {
  try {
    await ghFetch(repoUrl(`/labels/${encodeURIComponent(name)}`));
  } catch {
    try {
      await ghFetch(repoUrl('/labels'), {
        method: 'POST',
        body: JSON.stringify({ name, color, description }),
      });
    } catch (err) {
      if (!(err as Error).message.includes('422')) throw err;
    }
  }
}
