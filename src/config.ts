import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '.env') });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`❌  Missing required env var: ${name}`);
    console.error(`   → Copy .env.example to .env and fill in the values.`);
    process.exit(1);
  }
  return value;
}

function lazy(name: string): () => string {
  let cached: string | undefined;
  return () => cached ??= required(name);
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

// ── Jira (lazy — only required when Jira API is actually called) ──────────────
export const getJiraBaseUrl = lazy('JIRA_BASE_URL');
export const getJiraEmail = lazy('JIRA_EMAIL');
export const getJiraApiToken = lazy('JIRA_API_TOKEN');
export const getJiraProjectKey = lazy('JIRA_PROJECT_KEY');
export const JIRA_SPRINT_PREFIX = optional('JIRA_SPRINT_PREFIX', 'Sprint');
export const JIRA_PICK_STATUSES = optional('JIRA_PICK_STATUSES', 'To Do')
  .split(',').map(s => s.trim()).filter(Boolean);
export const JIRA_ASSIGNEE_FILTER = optional('JIRA_ASSIGNEE_FILTER');
export const JIRA_TRANSITION_TO = optional('JIRA_TRANSITION_TO', 'In Progress');

// ── GitHub ────────────────────────────────────────────────────────────────────
export const getGithubToken = lazy('GITHUB_TOKEN');
export const getGithubRepo = lazy('GITHUB_REPO');

// ── Anthropic ─────────────────────────────────────────────────────────────────
export const getAnthropicApiKey = lazy('ANTHROPIC_API_KEY');

// ── Automation limits ─────────────────────────────────────────────────────────
export const MAX_AUTO_TASKS = parseInt(optional('MAX_AUTO_TASKS', '3'), 10);
export const CONFIDENCE_THRESHOLD = parseInt(optional('CONFIDENCE_THRESHOLD', '75'), 10);

// ── Project context for enricher ──────────────────────────────────────────────
export const TECH_STACK = optional('TECH_STACK', 'TypeScript web application');
export const ARCH_NOTES = optional('ARCH_NOTES');
