// Answers are rendered with math delimiters models often use (\(..\), \[..\],
// math fences) rewritten for Obsidian, and with the alias pipe of a wiki link
// in a table row escaped. Code stays untouched.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api } from './harness.mjs';

const normalize = api.normalizeMathMarkdown;

test('inline \\(...\\) becomes $...$ and is trimmed', () => {
  assert.equal(normalize('Let \\( x^2 \\) be given.'), 'Let $x^2$ be given.');
});

test('display \\[...\\] becomes $$...$$ and keeps its lines', () => {
  assert.equal(normalize('Sum:\n\\[\n\\sum_{i=1}^n i\n\\]\nDone.'), 'Sum:\n$$\n\\sum_{i=1}^n i\n$$\nDone.');
  assert.equal(normalize('Inline \\[a+b\\] display'), 'Inline $$a+b$$ display');
  assert.equal(normalize('- item\n  \\[\n  x\n  \\]'), '- item\n  $$\n  x\n  $$');
});

test('several delimiters in one message', () => {
  assert.equal(
    normalize('If \\(a\\) and \\(b\\), then\n\\[a+b\\]\nand \\[c\\].'),
    'If $a$ and $b$, then\n$$a+b$$\nand $$c$$.',
  );
});

test('empty delimiters, escaped backslashes and dollars stay as they are', () => {
  assert.equal(normalize('Empty \\( \\) and \\[\\]'), 'Empty \\( \\) and \\[\\]');
  // `\\[2pt]` is a LaTeX line break inside existing math, not a delimiter.
  const matrix = '$$\\begin{matrix} a \\\\[2pt] b \\end{matrix}$$';
  assert.equal(normalize(matrix), matrix);
  assert.equal(normalize('A path \\\\(x\\\\) stays'), 'A path \\\\(x\\\\) stays');
  assert.equal(normalize('Costs \\$5, or $x$ and $$y$$'), 'Costs \\$5, or $x$ and $$y$$');
  assert.equal(normalize('Price \\(\\$5\\)'), 'Price $\\$5$');
});

test('inline code and code fences are untouched', () => {
  assert.equal(normalize('Write `\\(x\\)` or ``\\[y\\]`` for \\(z\\)'), 'Write `\\(x\\)` or ``\\[y\\]`` for $z$');
  const fenced = '```js\nconst s = "\\\\(x\\\\)";\n```\n~~~\n\\[y\\]\n~~~';
  assert.equal(normalize(fenced), fenced);
  // An unclosed fence runs to the end of the message.
  assert.equal(normalize('```\n\\(x\\)'), '```\n\\(x\\)');
  // A math fence shown as an example inside a longer fence is code too.
  const example = '````markdown\n```math\nx\n```\n````';
  assert.equal(normalize(example), example);
});

test('math, latex and tex fences become $$ blocks', () => {
  assert.equal(normalize('Before\n```math\nE = mc^2\n```\nAfter'), 'Before\n$$\nE = mc^2\n$$\nAfter');
  assert.equal(normalize('```latex\n\n\\frac{a}{b}\n\n```'), '$$\n\\frac{a}{b}\n$$');
  assert.equal(normalize('~~~TeX\nx\n~~~'), '$$\nx\n$$');
  assert.equal(normalize('```math\r\nx\r\n```\r\n'), '$$\nx\n$$\n');
  assert.equal(normalize('```math\n\n```'), '```math\n\n```');
});

test('a [[link|alias]] in a table row gets its pipe escaped; elsewhere, escaped or in code it stays', () => {
  assert.equal(normalize('| Mira | [[2026-10-05 Kickoff|Kickoff]] |'), '| Mira | [[2026-10-05 Kickoff\\|Kickoff]] |');
  assert.equal(normalize('| [[A|a]] and [[B|b]] |'), '| [[A\\|a]] and [[B\\|b]] |');
  assert.equal(normalize('| [[A\\|a]] | [[Plain]] |'), '| [[A\\|a]] | [[Plain]] |');
  assert.equal(normalize('See [[A|a]] here.'), 'See [[A|a]] here.');
  assert.equal(normalize('| `[[A|a]]` |'), '| `[[A|a]]` |');
  assert.equal(normalize('```\n| [[A|a]] |\n```'), '```\n| [[A|a]] |\n```');
});
