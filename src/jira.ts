import {
  getJiraBaseUrl,
  getJiraEmail,
  getJiraApiToken,
  getJiraProjectKey,
  JIRA_SPRINT_PREFIX,
  JIRA_PICK_STATUSES,
  JIRA_ASSIGNEE_FILTER,
  JIRA_TRANSITION_TO,
} from './config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface JiraSprint {
  id: number;
  name: string;
  state: 'active' | 'future' | 'closed';
  startDate?: string;
  endDate?: string;
  goal?: string;
}

/**
 * Scope of issues to pull. Sprint-based for Scrum boards; project-level for Kanban boards.
 * Kanban boards have no sprints — we just filter by status.
 */
export interface JiraScope {
  kind: 'sprint' | 'kanban';
  sprintId: number | null;
  name: string;
}

export interface JiraIssue {
  key: string;
  id: string;
  summary: string;
  description: string | null;
  issueType: string;
  status: string;
  priority: string;
  assignee: string | null;
  labels: string[];
  storyPoints: number | null;
  acceptanceCriteria: string | null;
  subtasks: { key: string; summary: string; status: string }[];
  sprintName: string;
  url: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helper
// ─────────────────────────────────────────────────────────────────────────────

function authHeader(): string {
  return 'Basic ' + Buffer.from(`${getJiraEmail()}:${getJiraApiToken()}`).toString('base64');
}

async function jiraFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = path.startsWith('http') ? path : `${getJiraBaseUrl()}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...((options.headers as Record<string, string>) ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira API ${res.status}: ${res.statusText}\n${body}`);
  }

  const text = await res.text();
  if (!text) return undefined as unknown as T;
  return JSON.parse(text) as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Board discovery
// ─────────────────────────────────────────────────────────────────────────────

interface JiraBoard { id: number; name: string; type: string }
interface BoardsResponse { values: JiraBoard[]; isLast: boolean; startAt: number }

async function findBoard(): Promise<JiraBoard> {
  const scrum = await jiraFetch<BoardsResponse>(
    `/rest/agile/1.0/board?projectKeyOrId=${getJiraProjectKey()}&type=scrum`,
  );
  if (scrum.values.length > 0) return scrum.values[0]!;

  const any = await jiraFetch<BoardsResponse>(`/rest/agile/1.0/board?projectKeyOrId=${getJiraProjectKey()}`);
  if (any.values.length === 0) {
    throw new Error(`No Jira board found for project "${getJiraProjectKey()}".`);
  }
  return any.values[0]!;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sprint discovery
// ─────────────────────────────────────────────────────────────────────────────

interface SprintResponse { values: JiraSprint[]; isLast: boolean }

export async function findActiveScope(): Promise<JiraScope> {
  const board = await findBoard();

  // Kanban boards have no sprints — scope is the whole project, status-filtered.
  if (board.type !== 'scrum') {
    return { kind: 'kanban', sprintId: null, name: board.name };
  }

  const active = await jiraFetch<SprintResponse>(
    `/rest/agile/1.0/board/${board.id}/sprint?state=active`,
  );

  if (active.values.length > 0) {
    const pick = active.values.find(s => s.name.startsWith(JIRA_SPRINT_PREFIX)) ?? active.values[0]!;
    return { kind: 'sprint', sprintId: pick.id, name: pick.name };
  }

  const future = await jiraFetch<SprintResponse>(
    `/rest/agile/1.0/board/${board.id}/sprint?state=future`,
  );
  if (future.values.length === 0) {
    throw new Error('No active or future sprint found.');
  }
  const pick = future.values.find(s => s.name.startsWith(JIRA_SPRINT_PREFIX)) ?? future.values[0]!;
  return { kind: 'sprint', sprintId: pick.id, name: pick.name };
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue fetching
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function adfToText(node: any): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text ?? '';
  if (Array.isArray(node.content)) {
    return node.content.map(adfToText).join(
      node.type === 'paragraph' || node.type === 'heading' ? '\n' :
      node.type === 'listItem' ? '\n- ' : '',
    );
  }
  return '';
}

export async function getScopeIssues(scope: JiraScope): Promise<JiraIssue[]> {
  interface IssueSearchResponse {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    issues: { key: string; id: string; fields: Record<string, any> }[];
    nextPageToken?: string | null;
    isLast?: boolean;
  }

  const statusFilter = JIRA_PICK_STATUSES.map(s => `"${s}"`).join(', ');
  let jql = scope.kind === 'sprint'
    ? `sprint = ${scope.sprintId} AND status IN (${statusFilter})`
    : `project = ${getJiraProjectKey()} AND status IN (${statusFilter})`;
  if (JIRA_ASSIGNEE_FILTER) jql += ` AND assignee = "${JIRA_ASSIGNEE_FILTER}"`;
  jql += ' ORDER BY priority DESC, created ASC';

  const allIssues: JiraIssue[] = [];
  let nextPageToken: string | undefined;

  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: Record<string, any> = {
      jql,
      maxResults: 50,
      fields: [
        'summary', 'description', 'issuetype', 'status', 'priority',
        'assignee', 'labels', 'subtasks',
        'customfield_10016', 'customfield_10028', 'customfield_10037', 'customfield_10024',
      ],
    };
    if (nextPageToken) body['nextPageToken'] = nextPageToken;

    const data = await jiraFetch<IssueSearchResponse>('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    for (const issue of data.issues) {
      const f = issue.fields;
      const storyPoints = f['customfield_10016'] ?? f['customfield_10028'] ?? null;
      const acceptanceCriteria = f['customfield_10037'] ?? f['customfield_10024'] ?? null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const subtasks = (f['subtasks'] ?? []).map((st: any) => ({
        key: st.key as string,
        summary: st.fields?.summary as string,
        status: st.fields?.status?.name as string,
      }));

      allIssues.push({
        key: issue.key,
        id: issue.id,
        summary: f['summary'],
        description: typeof f['description'] === 'string' ? f['description'] : adfToText(f['description']),
        issueType: f['issuetype'].name,
        status: f['status'].name,
        priority: f['priority'].name,
        assignee: f['assignee']?.displayName ?? null,
        labels: f['labels'] ?? [],
        storyPoints: typeof storyPoints === 'number' ? storyPoints : null,
        acceptanceCriteria: typeof acceptanceCriteria === 'string' ? acceptanceCriteria : adfToText(acceptanceCriteria),
        subtasks,
        sprintName: scope.name,
        url: `${getJiraBaseUrl()}/browse/${issue.key}`,
      });
    }

    if (data.isLast !== false || !data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }

  return allIssues;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status transitions
// ─────────────────────────────────────────────────────────────────────────────

export async function transitionIssue(issueKey: string): Promise<boolean> {
  if (!JIRA_TRANSITION_TO) return false;

  interface TransitionsResponse {
    transitions: { id: string; name: string; to: { name: string } }[];
  }

  const data = await jiraFetch<TransitionsResponse>(`/rest/api/3/issue/${issueKey}/transitions`);
  const match = data.transitions.find(
    t => t.name.toLowerCase() === JIRA_TRANSITION_TO.toLowerCase() ||
         t.to.name.toLowerCase() === JIRA_TRANSITION_TO.toLowerCase(),
  );

  if (!match) {
    console.warn(`   ⚠  No transition to "${JIRA_TRANSITION_TO}" for ${issueKey} — skipping.`);
    return false;
  }

  await jiraFetch(`/rest/api/3/issue/${issueKey}/transitions`, {
    method: 'POST',
    body: JSON.stringify({ transition: { id: match.id } }),
  });
  return true;
}

export async function addComment(issueKey: string, text: string): Promise<void> {
  await jiraFetch(`/rest/api/3/issue/${issueKey}/comment`, {
    method: 'POST',
    body: JSON.stringify({
      body: {
        version: 1, type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      },
    }),
  });
}
