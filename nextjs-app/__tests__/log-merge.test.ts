import { fromSavedRow, mergeSavedRows, type SavedLogRow } from '@/lib/log-merge';
import type { LogEntry } from '@/lib/types';

const T0 = Date.parse('2026-11-16T13:16:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
let n = 0;
const row = (s: number, title: string, message: string, category = 'system'): SavedLogRow =>
  ({ id: `c${++n}`, level: 'info', category, title, message, details: null, duration: null, createdAt: at(s) });
const mine = (s: number, title: string, message: string, category = 'llm'): LogEntry =>
  ({ id: `${T0 + s * 1000}-x${++n}`, level: 'info', category: category as LogEntry['category'], title, message,
     timestamp: new Date(T0 + s * 1000), unsaved: true });

test('a turn begun at the tower shows as its rows are saved, newest first', () => {
  const shown = [fromSavedRow(row(-36000, 'LLM Response', 'last night'))];
  const rows = [row(55, 'Tool Result: ask_engineering_question', 'Success'), row(14, 'Tool Call: web_search', 'Arguments: {}')];
  const merged = mergeSavedRows(shown, rows, [], 500, new Set(), T0 + 60_000)!;
  expect(merged.map((e) => e.title)).toEqual(['Tool Result: ask_engineering_question', 'Tool Call: web_search', 'LLM Response']);
});

test('rows already shown, or looked at last time, are not added again', () => {
  const saved = row(5, 'Tool Call: run_command', 'Arguments: {}');
  const edge = row(6, 'Tool Result: run_command', 'Success');
  expect(mergeSavedRows([fromSavedRow(saved)], [saved, edge], [], 500, new Set([edge.id]))).toBeNull();
});

test("the page's own entries, saved a few seconds later, take their rows instead of showing twice", () => {
  const shown = [mine(2, 'Tool Call', 'Calling run_command'), mine(1, 'Tool Call', 'Calling run_command')];
  const rows = [row(5, 'Tool Call', 'Calling run_command', 'llm'), row(5, 'Tool Call', 'Calling run_command', 'llm')];
  const merged = mergeSavedRows(shown, rows, [], 500)!;
  expect(merged).toHaveLength(2);
  expect(merged.every((e) => e.unsaved === false)).toBe(true);
  // a third saved copy has no entry left to take it: it is someone else's and shows
  expect(mergeSavedRows(merged, [row(9, 'Tool Call', 'Calling run_command', 'llm')], [], 500)).toHaveLength(3);
});

test("the server's rows for a turn this page streamed itself are skipped; after it, rows show again", () => {
  const own = [{ from: T0, to: T0 + 30_000 }];
  const during = row(12, 'Tool Call: run_command', 'Arguments: {}');
  const justAfter = row(32, 'LLM Response', 'deepseek (900 chars)', 'llm');
  const later = row(120, 'Tool Call: web_search', 'Arguments: {}');
  const merged = mergeSavedRows([], [during, justAfter, later], own, 500, new Set(), T0 + 130_000)!;
  expect(merged.map((e) => e.title)).toEqual(['Tool Call: web_search']);
  // while it is still streaming (to: null), everything since it began is its own
  expect(mergeSavedRows([], [later], [{ from: T0, to: null }], 500, new Set(), T0 + 130_000)).toBeNull();
});

test('at most max entries are kept, the newest', () => {
  const rows = Array.from({ length: 5 }, (_, i) => row(i, `Tool Call: t${i}`, 'Arguments: {}'));
  expect(mergeSavedRows([], rows, [], 3)!.map((e) => e.title)).toEqual(['Tool Call: t4', 'Tool Call: t3', 'Tool Call: t2']);
});

test('saved details come back as an object, or wrapped when they are not one', () => {
  expect(fromSavedRow({ ...row(0, 'a', 'b'), details: '{"toolName":"x"}' }).details).toEqual({ toolName: 'x' });
  expect(fromSavedRow({ ...row(0, 'a', 'b'), details: '"text"' }).details).toEqual({ raw: 'text' });
  expect(fromSavedRow({ ...row(0, 'a', 'b'), details: 'not json' }).details).toEqual({ raw: 'not json' });
});
