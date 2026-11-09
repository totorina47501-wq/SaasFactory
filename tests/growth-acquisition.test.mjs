import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createAcquisitionMvp,exportAcquisitionMvp} from '../growth/acquisition/mvp.mjs';
import {createGrowthPlan} from '../growth/core/market.mjs';
const raw=readFileSync(new URL('../examples/intake-sample.json',import.meta.url),'utf8');
const options={startDate:'2026-11-09',locale:'fr-FR'};

test('reuse strict Growth Core, deterministic outputs and documented funnel',()=>{
  const p=createAcquisitionMvp(raw,options),core=createGrowthPlan(raw);
  assert.deepEqual(p,createAcquisitionMvp(raw,options));
  assert.equal(p.projectSlug,core.projectSlug);
  assert.equal(p.icp.audience,core.audience);
  assert.equal(p.sourceKind,core.kind);
  assert.equal(p.status,'draft-only');
  assert.deepEqual(p.funnel.map(x=>x.id),['seo','lead-magnet','activation','demo','conversion']);
});
test('no spend, publication, collection or unfounded claims',()=>{
  const p=createAcquisitionMvp(raw,options);
  assert.ok(Object.values(p.safeguards).every(x=>x===false||x===0));
  assert.ok(p.seoPages.every(x=>x.status==='draft'&&!x.publishEnabled&&!x.claimsVerified));
  assert.ok(p.editorialCalendar.every(x=>!x.publishEnabled&&x.spendCents===0));
  assert.ok(p.leadMagnets.every(x=>!x.collectionEnabled&&!x.deliveryEnabled&&!x.formEnabled));
  assert.ok(p.experiments.every(x=>!x.executionEnabled&&!x.measurementReady));
  assert.equal(p.handoff.automaticIntegration,false);
  assert.equal(p.icp.evidence,'unverified');
});
test('French/English calendar and pages are stable and unique',()=>{
  const fr=createAcquisitionMvp(raw,options),en=createAcquisitionMvp(raw,{...options,locale:'en'});
  assert.equal(fr.seoPages.length,3);
  assert.equal(en.seoPages.length,3);
  assert.notEqual(fr.seoPages[0].title,en.seoPages[0].title);
  assert.deepEqual(fr.editorialCalendar.map(x=>x.date),
    ['2026-11-09','2026-11-13','2026-11-17','2026-11-21','2026-11-25','2026-11-29']);
  assert.equal(new Set(fr.seoPages.map(x=>x.path)).size,3);
  assert.equal(new Set(fr.editorialCalendar.map(x=>x.id)).size,6);
});
test('fail closed for invalid Intake, dates, locale and extra options',()=>{
  assert.throws(()=>createAcquisitionMvp(raw),/startDate/);
  assert.throws(()=>createAcquisitionMvp(raw,{...options,startDate:'2026-02-30'}),/Invalid startDate/);
  assert.throws(()=>createAcquisitionMvp(raw,{...options,locale:'fr-CA'}),/locale/);
  assert.throws(()=>createAcquisitionMvp(raw,{...options,send:true}),/options/);
  assert.throws(()=>createAcquisitionMvp('{}',options));
});
test('JSON and Markdown exports are deterministic, offline and draft-only',()=>{
  const p=createAcquisitionMvp(raw,options);
  assert.deepEqual(JSON.parse(exportAcquisitionMvp(p)),p);
  const markdown=exportAcquisitionMvp(p,'markdown');
  assert.equal(markdown,exportAcquisitionMvp(createAcquisitionMvp(raw,options),'markdown'));
  assert.match(markdown,/Aucun envoi, publication/);
  assert.throws(()=>exportAcquisitionMvp(p,'html'),/format/);
  assert.throws(()=>exportAcquisitionMvp({kind:'other'}),/draft/);
});
