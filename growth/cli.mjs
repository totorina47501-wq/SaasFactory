#!/usr/bin/env node
// Read-only GTM preview. No GitHub, mail, analytics SDK or network calls.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseConfigText} from '../generate.mjs';
import {createGrowthPlan} from './core/market.mjs';
import {aggregateGrowth} from './core/metrics.mjs';

function loadBounded(file) {
  const s=fs.statSync(file);
  if(!s.isFile()||s.size>65536) throw Error('Input must be a regular JSON file <= 64 KiB');
  return fs.readFileSync(file,'utf8');
}
function run(args) {
  if(!Array.isArray(args)||args.length!==2&&args.length!==6 ||
    args[0]!=='--input'||!args[1]||
    (args.length===6 && (args[2]!=='--events'||args[4]!=='--as-of')))
    throw Error('Usage: node growth/cli.mjs --input <intake.json> [--events <events.json> --as-of <ISO date>]');
  const plan=createGrowthPlan(loadBounded(args[1]));
  const result={plan};
  if(args.length===6) {
    const events=parseConfigText(loadBounded(args[3]));
    result.metrics=aggregateGrowth({tenantId:plan.projectSlug,events,asOf:args[5]});
  }
  return result;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  try { process.stdout.write(JSON.stringify(run(process.argv.slice(2)),null,2)+'\n'); }
  catch { process.stderr.write('growth: invalid input or unavailable evidence\n');process.exitCode=1; }
}
export {run};
