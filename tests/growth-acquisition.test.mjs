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

import {createGrowthSeoPreview,exportGrowthSeoPreview} from '../growth/acquisition/seo-preview.mjs';

test('neutral SEO adapter reuses independent Growth MVP and FR/EN SEO #44',()=>{
 const fr=createGrowthSeoPreview(raw,{startDate:'2026-11-09',locale:'fr-FR',origin:'https://factory.example'});
 const en=createGrowthSeoPreview(raw,{startDate:'2026-11-09',locale:'en',origin:'https://factory.example'});
 assert.equal(fr.kind,'saas-factory-growth-seo-preview');
 assert.equal(fr.seoPages.length,3);
 assert.ok(fr.seoPages.every(p=>p.status==='draft'&&!p.publicationAllowed&&
  !p.claimsVerified&&!p.contentApproved));
 assert.deepEqual(fr.seoPages.map(p=>p.publicRoute),['/','/features','/about']);
 assert.equal(fr.seoPages[0].metadata.canonical,'https://factory.example/fr-FR');
 assert.equal(en.seoPages[0].metadata.canonical,'https://factory.example/en');
 assert.equal(fr.seoPages[0].metadata.alternates.languages.en,'https://factory.example/en');
 assert.equal(fr.sitemap.length,8);
 assert.ok(fr.robots.rules[0].disallow.includes('/dashboard'));
 assert.equal(fr.collectionEnabled,false);
 assert.equal(fr.publicationEnabled,false);
 assert.equal(fr.analyticsStatus,'not-integrated');
 assert.equal(fr.integration.automaticTracking,false);
 assert.equal(fr.integration.automaticPublishing,false);
});
test('SEO bridge does not promote unchecked product claims, and exports only drafts',()=>{
 const plan=createGrowthSeoPreview(raw,{startDate:'2026-11-09',locale:'fr-FR',origin:'https://factory.example'});
 const meta=plan.seoPages[0].metadata;
 assert.notEqual(meta.title,plan.seoPages[0].sourceDraftTitle);
 assert.equal(meta.robots.index,true);
 assert.deepEqual(JSON.parse(exportGrowthSeoPreview(plan)),plan);
 assert.match(exportGrowthSeoPreview(plan,'markdown'),/No publishing/);
 assert.throws(()=>exportGrowthSeoPreview(plan,'html'),/format/);
 assert.throws(()=>exportGrowthSeoPreview({kind:'other'}),/draft/);
});
test('SEO bridge rejects malformed Intake, insecure origins and unsupported locales',()=>{
 assert.throws(()=>createGrowthSeoPreview(raw,{startDate:'2026-11-09',origin:'http://factory.example'}),/HTTPS/);
 assert.throws(()=>createGrowthSeoPreview(raw,{startDate:'2026-11-09',origin:'https://x:p@factory.example'}),/HTTPS/);
 assert.throws(()=>createGrowthSeoPreview(raw,{startDate:'2026-11-09',locale:'es',origin:'https://factory.example'}),/locale/);
 assert.throws(()=>createGrowthSeoPreview('{}',{startDate:'2026-11-09',origin:'https://factory.example'}));
});
