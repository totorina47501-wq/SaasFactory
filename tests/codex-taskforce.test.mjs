import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const load = () => JSON.parse(readFileSync(new URL('../docs/codex-taskforce/codex-surge-v1.json', import.meta.url), 'utf8'));
const knownRoles = new Set(['codex-rag-architect', 'codex-backend-security', 'codex-mobile-games', 'codex-devops-performance']);
const readRole = (relative) => readFileSync(new URL('../' + relative, import.meta.url), 'utf8');

test('temporary Codex role packs are explicit and are not new Copilot dispatcher identities', () => {
  const config = load();
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.ownerIssue, 121);
  assert.equal(config.scope, 'github-copilot-codex-partner-role-playbooks');
  assert.equal(config.status, 'documentation-only');
  assert.equal(config.roles.length, 4);
  assert.deepEqual(new Set(config.roles.map(r => r.id)), knownRoles);
  assert.equal(new Set(config.roles.map(r => r.file)).size, 4);
  assert.equal(config.retirement.preservePermanentProfiles, 8);
  assert.equal(config.retirement.removeAutoRoutes, false);
  assert.ok(Date.parse(config.expiresOn) > Date.parse(config.reviewOn));
  for (const role of config.roles) {
    assert.ok(/^codex-[a-z-]+$/.test(role.id));
    assert.ok(role.file.startsWith('docs/codex-taskforce/') && role.file.endsWith('.md'));
    assert.ok(role.issueReferences.length >= 1 && new Set(role.issueReferences).size === role.issueReferences.length);
    assert.ok(role.forbiddenAreas.length >= 2);
    const instructions = readRole(role.file);
    for (const requirement of ['AGENTS.md', 'Files:', 'Reject duplicate work', 'No payment, production deployment', 'GitHub']) {
      assert.ok(instructions.includes(requirement), role.id + ' missing ' + requirement);
    }
  }
});

test('global coordination stays fail closed, with no automatic Codex provider assignment', () => {
  const { activation: a } = load();
  assert.equal(a.provider, 'GitHub Copilot partner Codex');
  assert.equal(a.maxActiveAcrossCopilotAndCodex, 4);
  assert.equal(a.maxNewCodexBeforeCapacityRecheck, 1);
  assert.equal(a.providerMustBeSelectedInGitHubUI, true);
  assert.equal(a.requiresAssigneeReadBack, true);
  assert.equal(a.requiresExplicitIssueAndPlaybook, true);
  assert.equal(a.forbidUnverifiedCapacity, true);
  assert.equal(a.noAutomaticPartnerAssignment, true);
  assert.equal(a.noCustomCopilotRoleRegistration, true);
  assert.equal(a.doesNotChangeDispatcher, true);
  const index = readRole('docs/codex-taskforce/README.md');
  assert.match(index, /Copilot \+ Codex combined/);
  assert.match(index, /do not launch/i);
  assert.match(index, /not four separate GitHub identities/i);
});

test('first actionable specialty is the seasonal game; RAG stays under existing Copilot ownership', () => {
  const { roles } = load();
  const game = roles.find(x => x.id === 'codex-mobile-games');
  assert.deepEqual(game.issueReferences, [119]);
  assert.match(readRole(game.file), /#119/);
  const rag = roles.find(x => x.id === 'codex-rag-architect');
  assert.ok(rag.issueReferences.includes(42));
  assert.match(readRole(rag.file), /PR #103/);
});
