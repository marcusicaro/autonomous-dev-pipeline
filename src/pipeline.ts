import { findActiveScope, getScopeIssues, transitionIssue, type JiraIssue } from './jira.js';
import { analyzeTask, type AnalysisResult } from './analyzer.js';
import { findExistingIssue, createCopilotIssue, ensureLabel, assignCopilot } from './github.js';
import { MAX_AUTO_TASKS, CONFIDENCE_THRESHOLD } from './config.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROCESSED_FILE = resolve(__dirname, '..', '.processed-issues.json');

// ─────────────────────────────────────────────────────────────────────────────
// Processed-issues tracker (prevents duplicate GitHub issues)
// ─────────────────────────────────────────────────────────────────────────────

interface ProcessedRecord {
  jiraKey: string;
  githubIssueNumber: number;
  githubIssueUrl: string;
  processedAt: string;
  verdict: 'SIMPLE' | 'COMPLEX';
}

function loadProcessed(): ProcessedRecord[] {
  if (!existsSync(PROCESSED_FILE)) return [];
  try { return JSON.parse(readFileSync(PROCESSED_FILE, 'utf-8')) as ProcessedRecord[]; }
  catch { return []; }
}

function saveProcessed(records: ProcessedRecord[]): void {
  writeFileSync(PROCESSED_FILE, JSON.stringify(records, null, 2));
}

function isAlreadyProcessed(jiraKey: string, records: ProcessedRecord[]): boolean {
  return records.some(r => r.jiraKey === jiraKey);
}

// ─────────────────────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────────────────────

function header(text: string): void {
  console.log('');
  console.log('═'.repeat(64));
  console.log(`  ${text}`);
  console.log('═'.repeat(64));
}

function logIssue(issue: JiraIssue, i: number): void {
  const pts = issue.storyPoints !== null ? ` (${issue.storyPoints}sp)` : '';
  console.log(`  ${i + 1}. [${issue.key}] ${issue.summary}${pts}`);
}

function logAnalysis(issue: JiraIssue, analysis: AnalysisResult): void {
  const icon = analysis.verdict === 'SIMPLE' ? '✅' : '🔴';
  const engine = analysis.engine === 'llm' ? '🧠 LLM' : '📏 Heuristic';
  console.log(`  ${icon} [${issue.key}] ${analysis.verdict} (${analysis.confidence}%) [${engine}]`);
  console.log(`     ${analysis.reasoning}`);
  if (analysis.riskFactors.length > 0) {
    console.log(`     Risks: ${analysis.riskFactors.join(', ')}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline options
// ─────────────────────────────────────────────────────────────────────────────

export interface PipelineOptions {
  dryRun?: boolean;
  analyzeOnly?: boolean;
  useLlm?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main pipeline
// ─────────────────────────────────────────────────────────────────────────────

export async function runPipeline(opts: PipelineOptions = {}): Promise<void> {
  const { dryRun = false, analyzeOnly = false, useLlm = false } = opts;
  const mode = dryRun ? '🏜️  DRY RUN' : analyzeOnly ? '🔍  ANALYZE ONLY' : '🚀  FULL';
  header(`Jira → Copilot Pipeline (${mode})`);

  // Step 1: Find scope (sprint for Scrum boards, project-level for Kanban)
  console.log('\n  🔍 Finding active scope…');
  const scope = await findActiveScope();
  const scopeLabel = scope.kind === 'sprint' ? `Sprint "${scope.name}"` : `Kanban "${scope.name}"`;
  console.log(`  ✅ ${scopeLabel}`);

  // Step 2: Backlog
  console.log('\n  📋 Fetching backlog…');
  const issues = await getScopeIssues(scope);
  if (issues.length === 0) { console.log('  🎉 Backlog is clear!'); return; }
  console.log(`  Found ${issues.length} issue(s):\n`);
  issues.forEach(logIssue);

  // Step 3: Labels
  if (!dryRun && !analyzeOnly) {
    console.log('\n  🏷️  Ensuring GitHub labels exist…');
    await Promise.allSettled([
      ensureLabel('copilot-task', '7057ff', 'Task for Copilot coding agent'),
      ensureLabel('frontend', '61dafb', 'Frontend changes'),
      ensureLabel('backend', '68a063', 'Backend changes'),
      ensureLabel('shared', 'f9c513', 'Shared package changes'),
      ensureLabel('database', 'e76f51', 'Database changes'),
      ensureLabel('spec-ready', '0075ca', 'Issue enriched with implementation spec'),
    ]);
    console.log('  ✅ Labels ready');
  }

  // Step 4: Process each issue
  header('Analyzing tasks…');
  const processed = loadProcessed();
  let created = 0;

  const stats = { total: issues.length, simple: 0, complex: 0, created: 0, skipped: 0, errors: 0 };

  for (const issue of issues) {
    console.log(`\n  ── [${issue.key}] ${issue.summary} ──`);

    if (isAlreadyProcessed(issue.key, processed)) {
      console.log(`  ⏭️  Already processed`);
      stats.skipped++;
      continue;
    }
    if (created >= MAX_AUTO_TASKS) {
      console.log(`  ⏸️  Reached MAX_AUTO_TASKS (${MAX_AUTO_TASKS}) — stopping`);
      break;
    }

    // Skip dedup'd issues BEFORE any LLM call to avoid burning tokens
    // on tickets that already have a GitHub issue.
    try {
      const existing = await findExistingIssue(issue.key);
      if (existing) {
        console.log(`  ⏭️  GitHub issue already exists: ${existing.html_url}`);
        processed.push({ jiraKey: issue.key, githubIssueNumber: existing.number, githubIssueUrl: existing.html_url, processedAt: new Date().toISOString(), verdict: 'SIMPLE' });
        stats.skipped++;
        continue;
      }
    } catch { /* non-fatal */ }

    let analysis: AnalysisResult;
    try {
      console.log(`  🤖 Analyzing…`);
      analysis = await analyzeTask(issue, useLlm);
    } catch (err) {
      console.error(`  ❌ Analysis failed: ${(err as Error).message}`);
      stats.errors++;
      continue;
    }

    logAnalysis(issue, analysis);

    if (analysis.verdict === 'COMPLEX') { stats.complex++; continue; }
    stats.simple++;

    if (analysis.confidence < CONFIDENCE_THRESHOLD) {
      console.log(`  ⏭️  Confidence ${analysis.confidence}% < threshold ${CONFIDENCE_THRESHOLD}% — skipping`);
      stats.skipped++;
      continue;
    }
    if (analyzeOnly) continue;

    if (dryRun) {
      console.log(`  📝 Would create: "[${issue.key}] ${issue.summary}"`);
      created++;
      continue;
    }

    // Create GitHub issue
    try {
      const gh = await createCopilotIssue(issue, analysis);
      console.log(`  ✅ Created: ${gh.html_url}`);
      stats.created++;
      created++;
      processed.push({ jiraKey: issue.key, githubIssueNumber: gh.number, githubIssueUrl: gh.html_url, processedAt: new Date().toISOString(), verdict: 'SIMPLE' });

      try {
        await assignCopilot(gh.number);
        console.log(`  🤖 Copilot assigned to #${gh.number}`);
      } catch (err) {
        console.warn(`  ⚠️  Could not assign Copilot: ${(err as Error).message}`);
      }

      // Transition Jira
      try {
        if (await transitionIssue(issue.key)) console.log(`  ✅ Jira ${issue.key} → "In Progress"`);
      } catch { /* non-fatal */ }

    } catch (err) {
      console.error(`  ❌ Failed to create issue: ${(err as Error).message}`);
      stats.errors++;
    }
  }

  saveProcessed(processed);

  // Summary
  header('Summary');
  console.log(`  Scope:            ${scopeLabel}`);
  console.log(`  Total backlog:    ${stats.total}`);
  console.log(`  ✅ Simple:        ${stats.simple}`);
  console.log(`  🔴 Complex:       ${stats.complex}`);
  console.log(`  📝 Created:       ${stats.created}`);
  console.log(`  ⏭️  Skipped:       ${stats.skipped}`);
  console.log(`  ❌ Errors:        ${stats.errors}`);

  if (stats.created > 0 && !dryRun) {
    console.log('\n  Issues created. The copilot-enrich workflow will add specs and assign Copilot.');
  }
  console.log('');
}
