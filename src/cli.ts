#!/usr/bin/env node
/**
 * copilot-dispatch CLI
 *
 * Usage:
 *   npx tsx src/cli.ts pipeline [--dry-run] [--analyze-only] [--llm]
 *   npx tsx src/cli.ts enrich --issue <number>
 *   npx tsx src/cli.ts poll-enrich
 */

import { runPipeline } from './pipeline.js';
import { enrichIssue, pollAndEnrich } from './enricher.js';

const [, , command, ...rest] = process.argv;

function flag(name: string): boolean {
  return rest.includes(name);
}

function option(name: string): string | undefined {
  const i = rest.indexOf(name);
  return i !== -1 ? rest[i + 1] : undefined;
}

async function main(): Promise<void> {
  switch (command) {
    case 'pipeline':
      await runPipeline({
        dryRun: flag('--dry-run'),
        analyzeOnly: flag('--analyze-only'),
        useLlm: flag('--llm'),
      });
      break;

    case 'enrich': {
      const issueStr = option('--issue');
      if (!issueStr) {
        console.error('Usage: cli.ts enrich --issue <number>');
        process.exit(1);
      }
      const issueNumber = parseInt(issueStr, 10);
      if (isNaN(issueNumber)) {
        console.error(`Invalid issue number: ${issueStr}`);
        process.exit(1);
      }
      console.log(`\n  🔬 Enriching issue #${issueNumber}…`);
      await enrichIssue(issueNumber);
      break;
    }

    case 'poll-enrich':
      await pollAndEnrich();
      break;

    default:
      console.error(`Unknown command: ${command ?? '(none)'}`);
      console.error('');
      console.error('Commands:');
      console.error('  pipeline [--dry-run] [--analyze-only] [--llm]');
      console.error('  enrich --issue <number>');
      console.error('  poll-enrich');
      process.exit(1);
  }
}

main().catch(err => {
  console.error('\n💥  Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
