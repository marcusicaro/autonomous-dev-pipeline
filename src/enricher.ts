import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY, TECH_STACK, ARCH_NOTES } from './config.js';
import {
  getIssue,
  updateIssueBody,
  addIssueLabel,
  addAssignee,
  createIssueComment,
  ensureLabel,
  getIssueLabels,
  searchIssuesByLabel,
} from './github.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SPEC_DIVIDER = '\n\n---\n\n## Implementation Spec\n\n';
const REQUIRED_SECTIONS = ['### Files to change', '### Test plan', '### Browser verification steps'];

// ─────────────────────────────────────────────────────────────────────────────
// System prompt (generic — parameterized by env)
// ─────────────────────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  const archSection = ARCH_NOTES
    ? `## Project-specific conventions\n\n${ARCH_NOTES}\n\n---\n\n`
    : '';

  return `You are a senior software engineer on a ${TECH_STACK} project.
Your job is to read a GitHub Issue and produce a precise implementation spec so the
GitHub Copilot coding agent can implement the task without making architectural mistakes.

${archSection}## Output format

You MUST produce a spec with EXACTLY these sections (markdown, no preamble):

### Files to change
List every file that must be created or modified.
Format: \`path/to/file.ts\` — one-line description of the change.

### Implementation notes
Call out any conventions, patterns, or traps specific to this task:
- Custom error classes to use (if any)
- Whether new environment variables are needed
- Data validation requirements
- Any other non-obvious constraint a developer would need to know

### Test plan
List specific test cases with enough detail to know exactly what to assert.
Group by file. Cover both success and failure paths.

### Browser verification steps
Number each step. Use only these verbs:
- Navigate to /path
- Click "button text"
- Fill "label text" with "value"
- Assert "text" is visible

### Unhappy paths
Number each step using the same verb syntax above.

---

Write the spec directly — no preamble, no introduction.
Be specific. Include exact file paths where known.
The spec will be appended directly to the GitHub Issue body.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core enrichment
// ─────────────────────────────────────────────────────────────────────────────

export async function enrichIssue(issueNumber: number): Promise<void> {
  const labels = await getIssueLabels(issueNumber);
  if (labels.includes('spec-ready')) {
    console.log(`Issue #${issueNumber} already has spec-ready — skipping`);
    return;
  }

  const issue = await getIssue(issueNumber);
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  let specText: string;
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: [{ type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `## Issue #${issueNumber}: ${issue.title}\n\n${issue.body ?? ''}` }],
    });
    const content = response.content[0];
    if (!content || content.type !== 'text') throw new Error('Unexpected response type from Anthropic');
    specText = content.text;
  } catch (err) {
    await createIssueComment(
      issueNumber,
      `⚠️ **Spec generation failed — Copilot assignment paused.**\n\n\`\`\`\n${(err as Error).message}\n\`\`\`\n\nRe-add the \`copilot-task\` label to retry.`,
    );
    throw err;
  }

  const missing = REQUIRED_SECTIONS.filter(s => !specText.includes(s));
  if (missing.length > 0) {
    await createIssueComment(
      issueNumber,
      `⚠️ **Spec generation produced incomplete output — missing: ${missing.join(', ')}.**\n\nRe-add the \`copilot-task\` label to retry.`,
    );
    throw new Error(`Spec missing sections: ${missing.join(', ')}`);
  }

  await updateIssueBody(issueNumber, `${issue.body ?? ''}${SPEC_DIVIDER}${specText}`);

  await ensureLabel('spec-ready', '0075ca', 'Issue enriched with implementation spec');
  await addIssueLabel(issueNumber, 'spec-ready');

  try {
    await addAssignee(issueNumber, 'copilot');
    console.log(`  ✅ Issue #${issueNumber} enriched, spec-ready label added, Copilot assigned`);
  } catch (err) {
    console.warn(`  ⚠️  Copilot assignment failed: ${(err as Error).message}`);
    await createIssueComment(
      issueNumber,
      [
        '⚠️ **Spec generated but Copilot could not be auto-assigned.**',
        '',
        'Please assign manually:',
        '1. Click "Assignees" on the right sidebar',
        '2. Search for and select `copilot`',
        '',
        `Error: \`${(err as Error).message}\``,
      ].join('\n'),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Poll mode — enrich all pending issues (for scheduled runs)
// ─────────────────────────────────────────────────────────────────────────────

export async function pollAndEnrich(): Promise<void> {
  console.log('\n  🔍 Searching for unenriched copilot-task issues…');
  const issues = await searchIssuesByLabel('copilot-task', 'spec-ready');

  if (issues.length === 0) {
    console.log('  ✅ No pending issues — nothing to enrich.');
    return;
  }

  console.log(`  Found ${issues.length} pending issue(s):\n`);
  for (const issue of issues) {
    console.log(`  ── #${issue.number}: ${issue.title}`);
    try {
      await enrichIssue(issue.number);
    } catch (err) {
      console.error(`  ❌ Failed to enrich #${issue.number}: ${(err as Error).message}`);
    }
  }
}
