#!/usr/bin/env node
// SaaS Intake v1: pure, deterministic hand-off from ChatGPT product brief to generator config.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseConfigText, validateConfig} from './generate.mjs';

const allowedKeys=['intakeVersion','product','market','mvp','scaffold','assumptions'];
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
 if(extra.length||missing.length)throw Error(context+' keys invalid: extra='+extra.join(',')+' missing='+missing.join(','));
}
function string(v,name,max=500){
 if(typeof v!=='string'||!v.trim()||v.length>max||/[\\u0000-\\u001f\\u007f]/u.test(v))throw Error(name+' must be a nonempty printable string of at most '+max+' characters');
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
 if(!Array.isArray(raw.assumptions)||raw.assumptions.length>20)throw Error('assumptions must be array <=20');
 const assumptions=raw.assumptions.map((a,i)=>string(a,'assumptions['+i+']',300));
 // The generator remains the authority for the scaffold schema and policy.
 const generatorConfig=validateConfig({
  schemaVersion:1,productName:product.name,projectSlug:product.slug,domain:product.domain,
  modules:raw.scaffold.modules,languages:raw.scaffold.languages,
  defaultLanguage:raw.scaffold.defaultLanguage,deploymentTarget:raw.scaffold.deploymentTarget
 });
 // Do not carry customer details or AI prose into the generated starter.
 return {intakeVersion:1,product,market,mvp,assumptions,generatorConfig};
}
function compileIntake(text){
 const verified=verifyIntake(parseConfigText(text));
 return {schemaVersion:1,kind:'saas-factory-intake-plan',projectSlug:verified.generatorConfig.projectSlug,
  generatorConfig:verified.generatorConfig,
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
function main(argv){
 if(argv.length!==2||argv[0]!=='--input'||!argv[1]||argv[1].startsWith('--'))throw Error('Usage: node intake.mjs --input <intake.json>');
 const json=fs.readFileSync(argv[1],'utf8');
 process.stdout.write(JSON.stringify(compileIntake(json),null,2)+'\n');
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{main(process.argv.slice(2))}catch(e){process.stderr.write('saas-intake: '+e.message+'\n');process.exitCode=1}
}
export {verifyIntake,compileIntake};
