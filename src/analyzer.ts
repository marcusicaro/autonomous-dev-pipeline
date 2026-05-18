import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY, TECH_STACK } from './config.js';
import type { JiraIssue } from './jira.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AnalysisResult {
  verdict: 'SIMPLE' | 'COMPLEX';
  confidence: number;
  reasoning: string;
  suggestedArea: string[];
  suggestedComplexity: string;
  estimatedFiles: number;
  riskFactors: string[];
  engine: 'heuristic' | 'llm';
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine 1: Heuristic (no API cost, instant)
// ─────────────────────────────────────────────────────────────────────────────

const COMPLEX_SIGNALS = [
  'migration', 'schema change', 'new model', 'new table', 'alter table',
  'foreign key', 'authentication', 'authorization', 'permission', 'role-based',
  'access control', 'jwt', 'token', 'refactor', 'restructure', 'rewrite', 'architect',
  'websocket', 'real-time', 'socket', 'sse', 'push notification', 'file upload',
  'pdf', 'csv export', 'report generation', 'new page from scratch',
  'third-party', 'external api', 'oauth', 'webhook', 'performance', 'caching',
  'workflow', 'state machine', 'multi-step', 'wizard',
];

const SIMPLE_SIGNALS = [
  'add column', 'add field', 'remove field', 'rename', 'change label', 'change text',
  'update text', 'tooltip', 'placeholder', 'color', 'colour', 'indicator', 'icon',
  'badge', 'tag', 'sort', 'filter', 'search', 'pagination', 'styling', 'style',
  'tailwind', 'layout', 'spacing', 'responsive', 'alignment', 'validation', 'validate',
  'required field', 'error message', 'add button', 'toggle', 'checkbox', 'dropdown',
  'show', 'hide', 'display', 'visibility', 'bug fix', 'bugfix', 'fix', 'broken',
];

const AREA_PATTERNS: { pattern: RegExp; area: string }[] = [
  { pattern: /\b(ui|frontend|component|page|form|table|button|modal|react)\b/i, area: 'Frontend' },
  { pattern: /\b(api|endpoint|route|controller|service|backend|express|middleware)\b/i, area: 'Backend' },
  { pattern: /\b(dto|schema|shared|zod|type|interface)\b/i, area: 'Shared' },
  { pattern: /\b(database|migration|model|sql|postgres|prisma)\b/i, area: 'Database' },
];

function countMatches(text: string, signals: string[]): number {
  const lower = text.toLowerCase();
  return signals.filter(s => lower.includes(s.toLowerCase())).length;
}

function detectAreas(text: string): string[] {
  const areas = new Set<string>();
  for (const { pattern, area } of AREA_PATTERNS) {
    if (pattern.test(text)) areas.add(area);
  }
  return [...areas];
}

function analyzeHeuristic(issue: JiraIssue): AnalysisResult {
  const text = [issue.summary, issue.description ?? '', issue.acceptanceCriteria ?? ''].join(' ');
  const complexHits = countMatches(text, COMPLEX_SIGNALS);
  const simpleHits = countMatches(text, SIMPLE_SIGNALS);
  const areas = detectAreas(text);

  let score = 50;
  score += complexHits * 15;
  score -= simpleHits * 10;
  if (areas.length > 2) score += 20;
  if (areas.includes('Database')) score += 15;
  if (issue.subtasks.length > 0) score += 10 * issue.subtasks.length;
  const descLen = (issue.description ?? '').length;
  if (descLen > 1000) score += 10;
  if (descLen > 2000) score += 10;
  if (descLen < 50 && !issue.acceptanceCriteria) score += 15;
  score = Math.max(0, Math.min(100, score));

  const isComplex = score > 50;
  const confidence = Math.abs(score - 50) + 50;

  const reasons: string[] = [];
  if (complexHits > 0) reasons.push(`Complexity signals: ${COMPLEX_SIGNALS.filter(s => text.toLowerCase().includes(s)).slice(0, 3).join(', ')}`);
  if (simpleHits > 0) reasons.push(`Simplicity signals: ${SIMPLE_SIGNALS.filter(s => text.toLowerCase().includes(s)).slice(0, 3).join(', ')}`);
  if (areas.includes('Database')) reasons.push('Involves database changes');
  if (issue.subtasks.length > 0) reasons.push(`Has ${issue.subtasks.length} subtask(s)`);
  if (reasons.length === 0) reasons.push(isComplex ? 'General scope appears broad' : 'Task appears focused');

  const riskFactors: string[] = [];
  if (areas.includes('Database')) riskFactors.push('May require database migration');
  if (areas.length > 2) riskFactors.push(`Spans ${areas.length} areas (${areas.join(', ')})`);
  if (descLen < 100) riskFactors.push('Description is very short — may be underspecified');
  if (issue.subtasks.length > 0) riskFactors.push(`${issue.subtasks.length} subtask(s) increase scope`);

  const estimatedFiles = complexHits > 2 ? Math.max(5, areas.length * 2) : areas.length;
  const suggestedComplexity =
    estimatedFiles <= 1 ? 'Trivial — single file change, < 20 lines' :
    estimatedFiles <= 3 ? 'Minor — a few files, < 100 lines' :
    'Moderate — multiple layers, < 300 lines';

  return {
    verdict: isComplex ? 'COMPLEX' : 'SIMPLE',
    confidence: Math.round(confidence),
    reasoning: reasons.join('. ') + '.',
    suggestedArea: areas.length > 0 ? areas : ['Frontend'],
    suggestedComplexity,
    estimatedFiles,
    riskFactors,
    engine: 'heuristic',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine 2: LLM via Anthropic haiku (accurate, low cost)
// ─────────────────────────────────────────────────────────────────────────────

function buildLlmSystemPrompt(): string {
  return `You are a senior software engineer analyzing Jira tasks for a ${TECH_STACK} project.

Determine if the task is **SIMPLE** enough for an AI coding agent (GitHub Copilot) to implement autonomously, or **COMPLEX** requiring human developer attention.

## SIMPLE tasks (AI agent CAN handle):
- Adding/removing a UI column, field, label, text, or tooltip
- Adding a filter, sort, or search option to an existing list
- Simple CRUD endpoint additions following existing patterns
- Small, isolated bug fixes with clear reproduction steps
- Adding validation rules to existing forms
- Styling/layout adjustments
- Adding a DTO field or re-exporting a type

## COMPLEX tasks (AI agent should NOT handle):
- Creating entirely new pages or major features from scratch
- Database schema migrations or model changes
- Authentication or authorization changes
- Multi-step workflows, state machines, or wizards
- Architectural refactoring or performance optimization
- New external service integrations
- Vague or ambiguous task descriptions
- Tasks spanning more than 3 files in more than 2 layers
- Real-time features, file upload/download, or report generation

Be conservative — when in doubt, classify as COMPLEX.

Respond with ONLY valid JSON (no markdown, no code fences):
{
  "verdict": "SIMPLE" | "COMPLEX",
  "confidence": <0-100>,
  "reasoning": "<2-3 sentence explanation>",
  "suggestedArea": ["Frontend" | "Backend" | "Shared" | "Database"],
  "suggestedComplexity": "Trivial — single file change, < 20 lines" | "Minor — a few files, < 100 lines" | "Moderate — multiple layers, < 300 lines",
  "estimatedFiles": <number>,
  "riskFactors": ["<factor>"]
}`;
}

function buildLlmUserPrompt(issue: JiraIssue): string {
  const parts = [
    `## Jira Task: ${issue.key}`,
    '',
    `**Summary:** ${issue.summary}`,
    `**Type:** ${issue.issueType}`,
    `**Priority:** ${issue.priority}`,
  ];
  if (issue.description) parts.push('', '**Description:**', issue.description);
  if (issue.acceptanceCriteria) parts.push('', '**Acceptance Criteria:**', issue.acceptanceCriteria);
  if (issue.labels.length > 0) parts.push('', `**Labels:** ${issue.labels.join(', ')}`);
  if (issue.subtasks.length > 0) {
    parts.push('', '**Subtasks:**');
    for (const st of issue.subtasks) parts.push(`- [${st.key}] ${st.summary} (${st.status})`);
  }
  return parts.join('\n');
}

function parseAnalysis(raw: string): AnalysisResult {
  const match = raw.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
  if (!match) throw new Error(`No valid JSON in response:\n${raw}`);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    throw new Error(`Failed to parse JSON:\n${raw}`);
  }

  const verdict = parsed['verdict'] as string;
  if (verdict !== 'SIMPLE' && verdict !== 'COMPLEX') {
    throw new Error(`Invalid verdict "${verdict}"`);
  }

  return {
    verdict: verdict as 'SIMPLE' | 'COMPLEX',
    confidence: typeof parsed['confidence'] === 'number' ? parsed['confidence'] : 50,
    reasoning: (parsed['reasoning'] as string) ?? 'No reasoning provided',
    suggestedArea: Array.isArray(parsed['suggestedArea']) ? parsed['suggestedArea'] as string[] : [],
    suggestedComplexity: (parsed['suggestedComplexity'] as string) ?? 'Minor — a few files, < 100 lines',
    estimatedFiles: typeof parsed['estimatedFiles'] === 'number' ? parsed['estimatedFiles'] : 0,
    riskFactors: Array.isArray(parsed['riskFactors']) ? parsed['riskFactors'] as string[] : [],
    engine: 'llm',
  };
}

async function analyzeLlm(issue: JiraIssue): Promise<AnalysisResult> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: buildLlmSystemPrompt(),
    messages: [{ role: 'user', content: buildLlmUserPrompt(issue) }],
  });

  const content = response.content[0];
  if (!content || content.type !== 'text') throw new Error('Unexpected response type from Anthropic');
  return parseAnalysis(content.text);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export async function analyzeTask(issue: JiraIssue, useLlm = false): Promise<AnalysisResult> {
  if (!useLlm) return analyzeHeuristic(issue);
  return analyzeLlm(issue);
}
