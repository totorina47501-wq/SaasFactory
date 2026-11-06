'use strict';
// Reconcile existing Project V2 cards only. Never create items or assign agents.
const REPO='totorina47501-wq/SaasFactory', OWNER='totorina47501-wq', TITLE='SaaSFactory — Agents';
const STATES=['Backlog','Approved','Assigned','Coding','In Progress','PR Review','CI Blocked','Done'];
function desiredStatus(c){
  if(!c || c.repository?.nameWithOwner!==REPO) return null;
  const labs=new Set((c.labels?.nodes||[]).map(x=>x.name));
  if(c.__typename==='Issue'){
    if(c.state==='CLOSED') return 'Done';
    if(c.state!=='OPEN') return null;
    if(labs.has('agent:blocked')) return 'CI Blocked';
    if(labs.has('agent:review')) return 'PR Review';
    if(labs.has('agent:coding')) return 'Coding';
    if(labs.has('agent:in-progress')) return 'In Progress';
    if((c.assignees?.nodes||[]).some(x=>/^(copilot|copilot-swe-agent)(\[bot\])?$/i.test(x.login))) return 'Assigned';
    return labs.has('agent:approved')?'Approved':null;
  }
  if(c.__typename==='PullRequest'){
    if(c.merged) return 'Done';
    if(c.prState!=='OPEN') return null;
    return labs.has('agent:blocked')?'CI Blocked':'PR Review';
  }
  return null;
}
const QUERY=[
  'query($login:String!,$number:Int!,$cursor:String){',
  'user(login:$login){projectV2(number:$number){id title url',
  'fields(first:50){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}',
  'items(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id',
  'fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name optionId}}',
  'content{__typename',
  '... on Issue{number state repository{nameWithOwner} labels(first:100){nodes{name}} assignees(first:20){nodes{login}}}',
  '... on PullRequest{number prState:state merged repository{nameWithOwner} labels(first:100){nodes{name}}}',
  '}}}}}}'
].join(' ');
const MUTATION=[
  'mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){',
  'updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,',
  'value:{singleSelectOptionId:$option}}){projectV2Item{id}}}'
].join(' ');
async function sync({graphql,core,apply=false}){
  if(process.env.GITHUB_REPOSITORY!==REPO) throw Error('Repository guard rejected');
  let cursor=null,project=null,rows=[],cursors=new Set();
  for(;;){
    const x=(await graphql(QUERY,{login:OWNER,number:2,cursor})).user?.projectV2;
    if(!x||x.title!==TITLE||(project&&project.id!==x.id)) throw Error('Unexpected project identity');
    project=x;rows.push(...(x.items?.nodes||[]));
    if(rows.length>500) throw Error('Too many project items');
    if(!x.items?.pageInfo?.hasNextPage) break;
    cursor=x.items.pageInfo.endCursor;
    if(!cursor||cursors.has(cursor)) throw Error('Repeated pagination cursor');
    cursors.add(cursor);
  }
  const field=project.fields.nodes.find(x=>x?.name==='Status'&&x.options);
  if(!field) throw Error('Missing Status field');
  const options=new Map(field.options.map(o=>[o.name,o.id]));
  for(const x of STATES) if(!options.has(x)) throw Error('Missing Status option: '+x);
  const seen=new Set(),dupes=new Set();
  for(const row of rows){
    const c=row.content;
    if(!c||c.repository?.nameWithOwner!==REPO) continue;
    const key=c.__typename+':'+c.number;
    if(seen.has(key)) dupes.add(key);
    seen.add(key);
  }
  const changes=[];
  for(const row of rows){
    const c=row.content;
    if(!c||c.repository?.nameWithOwner!==REPO) continue;
    const key=c.__typename+':'+c.number,to=desiredStatus(c);
    if(dupes.has(key)||!to||row.fieldValueByName?.name===to) continue;
    changes.push({key,itemId:row.id,from:row.fieldValueByName?.name||'(unset)',to});
  }
  if(dupes.size&&apply) throw Error('Duplicate project cards; refusing to write');
  if(changes.length>100) throw Error('Too many status updates; refusing to write');
  // GraphQL mutations are not atomic across cards: preserve audit evidence on partial failures.
  const report={mode:apply?'apply':'dry-run',project:project.url,items:rows.length,
    duplicates:[...dupes],changes:changes.map(({key,from,to})=>({key,from,to})),
    applied:[],failed:null};
  try {
    if(apply) for(const c of changes){
      try {
        await graphql(MUTATION,{project:project.id,item:c.itemId,field:field.id,option:options.get(c.to)});
        report.applied.push({key:c.key,from:c.from,to:c.to});
      } catch(err) {
        report.failed={key:c.key,from:c.from,to:c.to};
        throw err;
      }
    }
  } finally {
    core.info(JSON.stringify(report));
    await core.summary.addHeading('SaaSFactory Projects V2 status sync')
      .addRaw('\nMode: **'+report.mode+'**; cards: '+rows.length+'; planned: '+changes.length+
        '; applied: '+report.applied.length+'; duplicates: '+dupes.size+'; failed: '+
        (report.failed?.key||'none')+'\n')
      .addCodeBlock(JSON.stringify({planned:report.changes,applied:report.applied,failed:report.failed},null,2),'json').write();
  }
  return report;
}
module.exports={sync,desiredStatus};
