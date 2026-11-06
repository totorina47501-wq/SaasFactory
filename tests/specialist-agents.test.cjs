'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const profiles=["product-architect","generator-engineer","qa-engineer","security-engineer","platform-engineer","ux-accessibility","documentation-release"];
const bans={"product-architect":"Do not approve scope changes, deployments or spending; obtain explicit maintainer authorization.","generator-engineer":"Never copy an existing business app or activate external provider integrations.","qa-engineer":"Never change production behavior merely to make tests green without an approved implementation contract.","security-engineer":"Never read, disclose or reveal secrets, weaken authentication, or bypass security protections.","platform-engineer":"Never automerge, deploy, modify branch protection, create access tokens or alter secrets.","ux-accessibility":"Never import existing product branding, customer information or user data into generated templates.","documentation-release":"Never claim live verification without evidence, publish artifacts, or deploy without explicit authorization."};
test('all specialist instructions explicitly forbid dangerous actions',()=>{
 const dir=path.join(__dirname,'..','.github','agents');
 const files=fs.readdirSync(dir).filter(n=>n.endsWith('.agent.md')).sort();
 assert.deepEqual(files,profiles.map(s=>s+'.agent.md').sort());
 for(const slug of profiles){
   const content=fs.readFileSync(path.join(dir,slug+'.agent.md'),'utf8');
   assert.match(content,/^---\nname: [a-z-]+\n/m);
   assert.ok(content.includes('- '+bans[slug]),slug+' must have explicit prohibition');
   assert.match(content,/No payment, production deployment/);
   assert.match(content,/No payment, production deployment/);
   assert.match(content,/Reject duplicate work/);
 }
});
