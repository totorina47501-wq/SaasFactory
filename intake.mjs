#!/usr/bin/env node
// SaaS Intake v1: pure, deterministic hand-off from ChatGPT product brief to generator config.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseConfigText, validateConfig} from './generate.mjs';
import {compileIntakeV2} from './factory/intake-v2.mjs';
import capabilityCatalog from './docs/catalog/saas-capabilities-v1.json' with {type:'json'};

const allowedKeys=['intakeVersion','product','market','mvp','scaffold','capabilities','assumptions'];
const productKeys=['name','slug','domain','summary'];
const marketKeys=['audience','problem','monetization'];
const featureKeys=['id','title','description','priority','owner'];
const scaffoldKeys=['modules','languages','defaultLanguage','deploymentTarget'];
const specialistRoles=new Set(['product-architect','generator-engineer','qa-engineer','security-engineer','platform-engineer','ux-accessibility','documentation-release']);
const priorities=new Set(['p0','p1','p2']);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function keys(obj,expected,context){
 if(!plain(obj))throw Error(context+' must be an object');
 const actual=Object.keys(obj);
 const extra=actual.filter(k=>!expected.includes(k)),missing=expected.filter(k=>!Object.hasOwn(obj,k));
 if(extra.length||missing.length)throw Error(context+' keys invalid');
}
function string(v,name,max=500){
 if(typeof v!=='string'||!v.trim()||v.length>max||/[\x00-\x1f\x7f]/u.test(v))throw Error(name+' must be a nonempty printable string of at most '+max+' characters');
 // Fail closed for common credential formats; do not echo suspect input in errors.
 const credentialMarkers=[
  /gh[pousr]_[A-Za-z0-9_]{16,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /(?<![A-Za-z0-9_])sk-(?:proj-|test-|live-)?[A-Za-z0-9_-]{16,}/,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:bearer\s+)[A-Za-z0-9._~+/-]{20,}/i,
  /(?:password|api[_ -]?key|access[_ -]?token|secret[_ -]?key)\s*[:=]\s*['"]?[A-Za-z0-9_+/=-]{16,}/i
 ];
 if(credentialMarkers.some(pattern=>pattern.test(v)))throw Error(name+' contains credential-like content');
 return v.trim();
}
function verifyIntake(raw){
 keys(raw,allowedKeys,'intake');
 if(raw.intakeVersion!==1)throw Error('intakeVersion must be 1');
 keys(raw.product,productKeys,'product');keys(raw.market,marketKeys,'market');
 keys(raw.scaffold,scaffoldKeys,'scaffold');
 const product={name:string(raw.product.name,'product.name',80),slug:string(raw.product.slug,'product.slug',48),domain:string(raw.product.domain,'product.domain',253),summary:string(raw.product.summary,'product.summary',2000)};
 const market={audience:string(raw.market.audience,'market.audience'),problem:string(raw.market.problem,'market.problem'),monetization:string(raw.market.monetization,'market.monetization')};
 if(!Array.isArray(raw.mvp)||raw.mvp.length<1||raw.mvp.length>40)throw Error('mvp requires 1-40 features');
 const ids=new Set();
 const mvp=raw.mvp.map((f,i)=>{
  keys(f,featureKeys,'mvp['+i+']');
  const id=string(f.id,'feature.id',48);
  if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)||ids.has(id))throw Error('feature ids must be unique safe slugs');
  ids.add(id);
  if(!priorities.has(f.priority))throw Error('invalid priority');
  if(!specialistRoles.has(f.owner))throw Error('invalid agent owner');
  return {id,title:string(f.title,'feature.title',120),description:string(f.description,'feature.description',1500),priority:f.priority,owner:f.owner};
 });
 // Product capabilities are implementation requests, NOT new generator module identifiers.
 const knownCapabilities=new Map(capabilityCatalog.capabilities.map(c=>[c.id,c]));
 if(!Array.isArray(raw.capabilities)||raw.capabilities.length>30)throw Error('capabilities must be an array of at most 30 ids');
 const selected=new Set();
 const capabilities=raw.capabilities.map((id,i)=>{
  if(typeof id!=='string'||!knownCapabilities.has(id)||selected.has(id))
   throw Error('unknown or duplicate capability at index '+i);
  selected.add(id);
  const c=knownCapabilities.get(id);
  return {id:c.id,title:c.title,status:c.status,category:c.category,scaffold:c.scaffold,owner:c.owner,
   implementation:'draft-only',readyForUse:false};
 });
 if(!Array.isArray(raw.assumptions)||raw.assumptions.length>20)throw Error('assumptions must be array <=20');
 const assumptions=raw.assumptions.map((a,i)=>string(a,'assumptions['+i+']',300));
 // The generator remains the authority for the scaffold schema and policy.
 let generatorConfig;
 try{
  generatorConfig=validateConfig({
   schemaVersion:1,productName:product.name,projectSlug:product.slug,domain:product.domain,
   modules:raw.scaffold.modules,languages:raw.scaffold.languages,
   defaultLanguage:raw.scaffold.defaultLanguage,deploymentTarget:raw.scaffold.deploymentTarget
  });
 }catch{throw Error('generator configuration is invalid')}
 // Do not carry customer details or AI prose into the generated starter.
 return {intakeVersion:1,product,market,mvp,capabilities,assumptions,generatorConfig};
}
function parseIntakeText(text){
 try{return parseConfigText(text)}
 catch(error){
  if(error.message.startsWith('Duplicate JSON key:'))throw Error('Duplicate JSON key');
  throw Error('Invalid intake JSON')
 }
}
function compileIntakeV1(raw){
 const verified=verifyIntake(raw);
 return {schemaVersion:1,kind:'saas-factory-intake-plan',projectSlug:verified.generatorConfig.projectSlug,
  generatorConfig:verified.generatorConfig,
  capabilityRequests:verified.capabilities,
  missionDrafts:verified.mvp.map(f=>({
   id:f.id,title:f.title,description:f.description,priority:f.priority,
   specialist:f.owner,status:'draft',approved:false,files:null,
   acceptanceEvidence:'not-yet-provided'
  })),
  safeguards:{execution:'read-only',githubIssuesCreated:false,repoCreated:false,providerActivated:false,
   readyForDispatch:false,reason:'Requires per-mission Files scope, implementation contracts and explicit approval'},
  assumptions:verified.assumptions
 };
}
function compileIntake(text){
 const raw=parseIntakeText(text);
 if(raw?.intakeVersion===2)return compileIntakeV2(raw);
 return compileIntakeV1(raw);
}
function main(argv){
 if(argv.length!==2||argv[0]!=='--input'||!argv[1]||argv[1].startsWith('--'))throw Error('Usage: node intake.mjs --input <intake.json>');
 const json=fs.readFileSync(argv[1],'utf8');
 process.stdout.write(JSON.stringify(compileIntake(json),null,2)+'\n');
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{main(process.argv.slice(2))}catch(e){process.stderr.write('saas-intake: '+e.message+'\n');process.exitCode=1}
}
export {verifyIntake,compileIntake,compileIntakeV1,parseIntakeText};
