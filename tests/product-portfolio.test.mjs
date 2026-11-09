import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const getPortfolio = () => JSON.parse(readFileSync(new URL('../docs/strategy/product-portfolio-v1.json', import.meta.url),'utf8'));
const getBacklog = () => JSON.parse(readFileSync(new URL('../docs/catalog/factory-backlog-v1.json', import.meta.url),'utf8'));
const families = new Set(['seasonal-microapp','web-saas','ai-multimodal-saas','mobile-pwa','casual-games','native-mobile','marketplaces-creator-commerce']);
const maturity = new Set(['prototype','scaffold','planned','not-implemented']);
const waves = new Set(['now-november-2026','2026-q4','2026-q4-2027','after-seasonal-web','2026-november-december-prototype','after-market-validation','after-core-saas']);
const platforms = new Set(['web-mobile-first','web-responsive','pwa-android','pwa-ios-browser','pwa-optional','android-native-or-hybrid','ios-native-or-hybrid','mobile-pwa-optional']);

test('portfolio enumerates the seven strategic families without inventing production readiness',()=>{
 const plan=getPortfolio();
 assert.equal(plan.schemaVersion,1);
 assert.equal(plan.ownerIssue,113);
 assert.deepEqual(plan.lifecycle,['research','intake','build','quality','authorized-release','feedback','iterate-or-sunset']);
 assert.equal(plan.families.length,7);
 assert.deepEqual(new Set(plan.families.map(x=>x.id)),families);
 for(const family of plan.families){
  assert.ok(['p0','p1','p2'].includes(family.priority));
  assert.ok(maturity.has(family.maturity));
  assert.ok(waves.has(family.wave));
  assert.match(family.id,/^[a-z][a-z0-9-]+$/);
  assert.ok(family.name.length>8);
  assert.ok(family.platforms.length>0 && family.platforms.every(p=>platforms.has(p)));
  assert.ok(family.examples.length>=2 && family.monetization.length>=1);
  assert.ok(family.gates.length>=4 && new Set(family.gates).size===family.gates.length);
  assert.ok(family.nextIncrement.length>=40);
  assert.ok(family.issueRefs.length>=1 && new Set(family.issueRefs).size===family.issueRefs.length);
 }
});

test('issue references reuse known work and do not pretend future native or games exist',()=>{
 const plan=getPortfolio(), known=new Set(getBacklog().tasks.map(x=>x.issue));
 known.add(111);
 for(const family of plan.families) for(const n of family.issueRefs) assert.ok(known.has(n),'Unknown issue #'+n);
 const byId=Object.fromEntries(plan.families.map(x=>[x.id,x]));
 assert.equal(byId['seasonal-microapp'].maturity,'prototype');
 assert.equal(byId['seasonal-microapp'].priority,'p0');
 assert.deepEqual(byId['seasonal-microapp'].issueRefs.filter(n=>n===111),[111]);
 assert.equal(byId['casual-games'].maturity,'not-implemented');
 assert.equal(byId['native-mobile'].maturity,'not-implemented');
 assert.ok(byId['ai-multimodal-saas'].issueRefs.includes(42));
 assert.ok(byId['ai-multimodal-saas'].issueRefs.includes(46));
});

test('governance remains fail-closed, provider-off and market scores are weights only',()=>{
 const plan=getPortfolio();
 for(const flag of ['generatedProductsInSeparateRepositories','stageNeverImpliesProductionReady']) assert.equal(plan.guardrails[flag],true);
 for(const flag of ['aiProviderEnabledByDefault','paymentEnabledByDefault','socialPublishingEnabledByDefault','nativeStorePublishingEnabledByDefault','externalNetworkRequiredForPlanning']) assert.equal(plan.guardrails[flag],false);
 assert.match(plan.guardrails.authorization,/coordinator|GitHub/i);
 assert.ok(plan.prioritization.constraints.every(x=>typeof x==='string'&&x.length>10));
 const w=plan.prioritization.weights;
 assert.deepEqual(Object.keys(w).sort(),['customerPain','distributionFit','operationalRisk','reuseOfFactory','revenueEvidence','timeToMvp']);
 assert.equal(Object.values(w).reduce((sum,n)=>sum+n,0),100);
 assert.ok(Object.values(w).every(n=>Number.isInteger(n)&&n>=0));
});
