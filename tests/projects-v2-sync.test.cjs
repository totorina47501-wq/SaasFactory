'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {sync,desiredStatus}=require('../.github/scripts/projects-v2-sync.cjs');
const repo={nameWithOwner:'totorina47501-wq/SaasFactory'};
const labels=(...xs)=>({nodes:xs.map(name=>({name})),pageInfo:{hasNextPage:false}});
const issue=(n,l=[],state='OPEN',users=[],stateReason=state==='CLOSED'?'COMPLETED':null,body='')=>({
  __typename:'Issue',number:n,state,stateReason,body,repository:repo,labels:labels(...l),
  assignees:{nodes:users.map(login=>({login})),pageInfo:{hasNextPage:false}}
});
const pr=(n,state='OPEN',merged=false,closingIssues=[])=>({
  __typename:'PullRequest',number:n,prState:state,merged,repository:repo,labels:labels(),
  closingIssuesReferences:{nodes:closingIssues.map(number=>({number,repository:repo})),pageInfo:{hasNextPage:false}}
});
const row=(id,content,s)=>({id,content,fieldValueByName:s?{name:s,optionId:'O'}:null});
const states=['Backlog','Approved','Assigned','Coding','In Progress','PR Review','CI Blocked','Done'];
async function run(items,apply=false,pages=null,mutationResult=null){
  process.env.GITHUB_REPOSITORY='totorina47501-wq/SaasFactory';
  const writes=[],chunks=pages||[items];
  const graphql=async(q,v)=>{
    if(q.includes('mutation(')){
      writes.push(v);
      return mutationResult?mutationResult(v):{updateProjectV2ItemFieldValue:{projectV2Item:{id:v.item}}};
    }
    const n=v.cursor?Number(v.cursor):0;
    return {user:{projectV2:{
      id:'PVT_1',title:'SaaSFactory — Agents',url:'https://github.com/users/totorina47501-wq/projects/2',
      fields:{nodes:[{id:'F1',name:'Status',options:states.map((name,i)=>({name,id:'O'+i}))}],pageInfo:{hasNextPage:false}},
      items:{nodes:chunks[n],pageInfo:{hasNextPage:n<chunks.length-1,endCursor:n<chunks.length-1?String(n+1):null}}
    }}};
  };
  const summary={addHeading(){return this},addRaw(){return this},addCodeBlock(){return this},async write(){}};
  const result=await sync({graphql,core:{info(){},summary},apply});
  return {result,writes};
}
test('open approved issue and Copilot assignment',()=>{
  assert.equal(desiredStatus(issue(6,['agent:approved'])),'Approved');
  assert.equal(desiredStatus(issue(5,['agent:approved'], 'OPEN',['Copilot'])),'Assigned');
});
test('work takes priority and draft PR review is not Done',()=>{
  assert.equal(desiredStatus(issue(5,['agent:approved','agent:in-progress'],'OPEN',['Copilot'])),'In Progress');
  assert.equal(desiredStatus(pr(7)),'PR Review');
  assert.equal(desiredStatus(pr(8,'CLOSED',false)),null);
});
test('dry run never writes',async()=>{
  const x=await run([row('a',issue(6,['agent:approved']),'Backlog')]);
  assert.equal(x.result.changes.length,1);assert.equal(x.writes.length,0);
});
test('idempotent: unchanged statuses never updated',async()=>{
  const x=await run([row('a',issue(6,['agent:approved']),'Approved'),row('b',pr(7),'Backlog')],true);
  assert.deepEqual(x.writes.map(y=>y.item),['b']);
  assert.equal(x.writes[0].option,'O5');
});
test('duplicate project items fail closed',async()=>{
  await assert.rejects(()=>run([row('a',pr(7),'Backlog'),row('b',pr(7),'Backlog')],true),/Duplicate project cards/);
});
test('pagination and untouched unknown items',async()=>{
  const other=issue(99,['agent:approved']);other.repository={nameWithOwner:'other/repo'};
  const x=await run([] ,false,[[row('a',issue(6,['agent:approved']),'Backlog')],[row('b',other,'Backlog'),row('c',issue(10),'Backlog')]]);
  assert.equal(x.result.items,3);assert.equal(x.result.changes.length,1);
});
test('closed issue, merged PR, blocked label',()=>{
  assert.equal(desiredStatus(issue(5,[],'CLOSED')),'Done');
  assert.equal(desiredStatus(issue(5,[],'CLOSED',[],'NOT_PLANNED')),'Backlog');
  assert.equal(desiredStatus(issue(5,[],'CLOSED',[],'REOPENED')),'Backlog');
  assert.equal(desiredStatus(pr(7,'CLOSED',true)),'Done');
  assert.equal(desiredStatus(issue(6,['agent:approved','agent:blocked'])),'CI Blocked');
});

test('planned issues use Backlog while report distinguishes planned from dependency waiting',async()=>{
  const completed=issue(17,[],'CLOSED');
  const proof=pr(60,'CLOSED',true,[17]);
  const waiting=issue(51,['agent:planned'],'OPEN',[],null,'Files: .github/scripts/projects-v2-sync.cjs\nDepends-On: #17');
  const a=await run([row('a',completed,'Done'),row('b',proof,'Done'),row('c',waiting,'Backlog')]);
  assert.equal(a.result.cards.find(x=>x.key==='Issue:51').status,'planned');
  assert.deepEqual(a.result.cards.find(x=>x.key==='Issue:51').dependencies,[{kind:'issue',number:17,status:'done'}]);

  const unresolved=issue(17);
  const b=await run([row('a',unresolved,'In Progress'),row('b',proof,'Done'),row('c',waiting,'Backlog')]);
  assert.equal(b.result.cards.find(x=>x.key==='Issue:51').status,'waiting');
  assert.equal(b.result.cards.find(x=>x.key==='Issue:51').dependencies[0].status,'open');
});

test('completed issue without merged closing PR is not a delivered dependency',async()=>{
  const completed=issue(17,[],'CLOSED');
  const waiting=issue(51,['agent:planned'],'OPEN',[],null,'Depends-On: #17');
  const x=await run([row('a',completed,'Done'),row('b',waiting,'Backlog')]);
  assert.equal(x.result.cards.find(c=>c.key==='Issue:51').status,'waiting');
  assert.equal(x.result.cards.find(c=>c.key==='Issue:51').dependencies[0].status,'unverified');
});

test('planned issue without a valid dependency declaration remains waiting',async()=>{
  const x=await run([row('a',issue(51,['agent:planned']),'Backlog')]);
  assert.equal(x.result.cards[0].status,'waiting');
  assert.equal(x.result.cards[0].dependencyStatus,'unknown');
});

test('closed not_planned items are reported as not_planned, never done',async()=>{
  const x=await run([row('a',issue(6,[],'CLOSED',[],'NOT_PLANNED'),'Done')]);
  assert.equal(x.result.changes[0].to,'Backlog');
  assert.equal(x.result.cards[0].status,'not_planned');
});

test('incomplete project API responses fail closed',async()=>{
  process.env.GITHUB_REPOSITORY='totorina47501-wq/SaasFactory';
  const s={addHeading(){return this},addRaw(){return this},addCodeBlock(){return this},async write(){}};
  await assert.rejects(()=>sync({
    graphql:async()=>({user:{projectV2:{id:'PVT_1',title:'SaaSFactory — Agents',
      fields:{nodes:[{id:'F1',name:'Status',options:states.map((name,i)=>({name,id:'O'+i}))}],pageInfo:{hasNextPage:false}},
      items:{pageInfo:{hasNextPage:false,endCursor:null}}}}}),
    core:{info(){},summary:s}
  }),/Incomplete project items response/);
});

test('mutation without a matching acknowledgement is not reported as applied',async()=>{
  await assert.rejects(()=>run([row('a',issue(6,['agent:approved']),'Backlog')],true,null,()=>({})),
    /Incomplete mutation acknowledgement/);
});

test('query aliases PullRequest state to avoid GraphQL field conflict',async()=>{
  process.env.GITHUB_REPOSITORY='totorina47501-wq/SaasFactory';
  const s={addHeading(){return this},addRaw(){return this},addCodeBlock(){return this},async write(){}};
  let observed;
  await sync({graphql:async(q)=>{
    observed=q;
    return {user:{projectV2:{id:'PVT_1',title:'SaaSFactory — Agents',url:'https://github.com/users/totorina47501-wq/projects/2',fields:{nodes:[{id:'F1',name:'Status',options:states.map((name,i)=>({name,id:'O'+i}))}],pageInfo:{hasNextPage:false}},items:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}};
  },core:{info(){},summary:s}});
  assert.match(observed,/prState:state/);
  assert.equal(desiredStatus(pr(7,'CLOSED',false)),null);
});

test('partial mutation failure records acknowledged writes and still throws original error',async()=>{
  process.env.GITHUB_REPOSITORY='totorina47501-wq/SaasFactory';
  const writes=[],log=[],blocks=[];
  const boom=new Error('API mutation refused');
  const s={addHeading(){return this},addRaw(){return this},addCodeBlock(x){blocks.push(x);return this},async write(){}};
  const graphql=async(q,v)=>{
    if(q.includes('mutation(')){writes.push(v);if(writes.length===2)throw boom;return {updateProjectV2ItemFieldValue:{projectV2Item:{id:v.item}}};}
    return {user:{projectV2:{id:'PVT_1',title:'SaaSFactory — Agents',url:'https://github.com/users/totorina47501-wq/projects/2',
      fields:{nodes:[{id:'F1',name:'Status',options:states.map((name,i)=>({name,id:'O'+i}))}],pageInfo:{hasNextPage:false}},
      items:{nodes:[row('a',issue(6,['agent:approved']),'Backlog'),row('b',pr(7),'Backlog')],pageInfo:{hasNextPage:false,endCursor:null}}}}};
  };
  await assert.rejects(()=>sync({graphql,core:{info(x){log.push(JSON.parse(x))},summary:s},apply:true}),e=>e===boom);
  assert.equal(log.length,1);
  assert.deepEqual(log[0].applied,[{key:'Issue:6',from:'Backlog',to:'Approved'}]);
  assert.deepEqual(log[0].failed,{key:'PullRequest:7',from:'Backlog',to:'PR Review'});
  assert.equal(JSON.parse(blocks[0]).applied.length,1);
});
