import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const example = path.join(root, 'examples', 'saas-starter.json');
const generator = path.join(root, 'generate.mjs');

test('a new full-featured SaaS starter can be previewed and generated safely', () => {
  const tmp=mkdtempSync(path.join(tmpdir(),'factory-readiness-'));
  try {
    const cfg=JSON.parse(readFileSync(example,'utf8'));
    assert.deepEqual(cfg.modules,['ai-disabled','api','auth','billing-test','media']);
    const out=path.join(tmp,'out');
    const invoke=(write)=>JSON.parse(execFileSync(process.execPath,
      [generator,'--config',example,'--output-root',out,...(write?['--write']:[])],
      {encoding:'utf8'}));
    const preview=invoke(false);
    assert.equal(preview.mode,'dry-run');
    assert.equal(existsSync(out),false,'dry-run must not create output directory');
    const result=invoke(true);
    assert.equal(result.mode,'write');
    assert.deepEqual(result.files,preview.files,'preview must match actual output');
    const dest=path.join(out,cfg.projectSlug);
    assert.ok(existsSync(path.join(dest,'.github','workflows','ci.yml')));
    assert.ok(existsSync(path.join(dest,'open-next.config.ts')));
    assert.ok(existsSync(path.join(dest,'i18n','messages','en.json')));
    assert.ok(existsSync(path.join(dest,'lib','billing-test.mjs')));
    assert.ok(existsSync(path.join(dest,'lib','auth.mjs')));
    assert.ok(existsSync(path.join(dest,'app','api','example','route.js')));
    assert.ok(existsSync(path.join(dest,'public','media-fixture.svg')));
    assert.ok(!readdirSync(dest).includes('.git'),'never copy a git history');
    assert.match(execFileSync(process.execPath,['--test','tests/smoke.test.mjs'],{
      cwd:dest,encoding:'utf8',env:{...process.env,NODE_TEST_CONTEXT:undefined}
    }),/pass/);
    assert.throws(()=>invoke(true),'existing destination must never be overwritten');
  } finally {
    rmSync(tmp,{recursive:true,force:true});
  }
});
