// A finished turn's steps fold into one row above its answer: which rows
// fold (foldPlan). The chat view's calls: undo.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api } from './harness.mjs';

const row = (type, extra = {}) => ({ type, ...extra });

test('Steps, a text that led into a step and the changes row fold; the answer and an ask_user question stay', () => {
  const user = row('user', { turnId: 't1' });
  const lead = row('assistant', { text: 'Let me check.' });
  const read = row('tool-result');
  const edit = row('tool-result');
  const changes = row('changes', { turnId: 't1' });
  const answer = row('assistant', { text: 'Done.' });
  const next = row('user', { turnId: 't2' });
  const plan = api.foldPlan([user, lead, read, edit, changes, answer, next], 't1');
  assert.deepEqual(plan.steps, [lead, read, edit]);
  assert.equal(plan.changes, changes);
  // The row goes right above the answer.
  assert.equal(plan.at, 5);

  // Added while the turn ran (no turn ID): it stays, and the row comes after it, above the answer.
  const added = row('user', { text: 'Also one on the right' });
  const withAdded = api.foldPlan([user, read, added, edit, changes, answer], 't1');
  assert.deepEqual(withAdded.steps, [read, edit]);
  assert.equal(withAdded.at, 5);
  // Stopped before an answer: where the first step was.
  assert.equal(api.foldPlan([user, read, edit], 't1').at, 1);

  // A question to the user is no step: it stays, and what came before it folds.
  const question = row('assistant', { text: 'Which card?' });
  const reply = row('user', { text: 'The blank one' });
  const asked = api.foldPlan([user, read, question, reply, edit, answer], 't1');
  assert.deepEqual(asked.steps, [read, edit]);
});

test('A single step without changes stays; one with changes folds; another turn is left alone', () => {
  const user = row('user', { turnId: 't1' });
  const read = row('tool-result');
  const answer = row('assistant', { text: 'It says hi.' });
  assert.equal(api.foldPlan([user, read, answer], 't1'), null);
  const changes = row('changes', { turnId: 't1' });
  assert.deepEqual(api.foldPlan([user, read, changes, answer], 't1').steps, [read]);
  assert.equal(api.foldPlan([user, read, answer], 'other'), null);
});

test('A turn without an answer (an error, a pause, Stop) keeps its texts and says so', () => {
  const user = row('user', { turnId: 't1' });
  const lead = row('assistant', { text: 'The notes were cut off, so I read them again.' });
  const read = row('tool-result');
  const edit = row('tool-result');
  const changes = row('changes', { turnId: 't1' });
  const error = row('error', { text: 'Paused after 20 steps.' });
  const plan = api.foldPlan([user, lead, read, edit, changes, error], 't1');
  assert.deepEqual(plan.steps, [read, edit]);
  assert.equal(plan.unanswered, true);
  // With an answer the lead-in folds and the row is a finished one.
  const answered = api.foldPlan([user, lead, read, edit, row('assistant', { text: 'Done.' })], 't1');
  assert.deepEqual(answered.steps, [lead, read, edit]);
  assert.equal(answered.unanswered, undefined);
});
