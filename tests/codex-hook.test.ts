import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexDataPath, handleCodexHook } from '../src/integrations/codex.js';

afterEach(() => vi.unstubAllGlobals());

describe('Codex hook integration', () => {
  it('writes retained context before compaction and injects it afterward', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'save-token-jev-test-'));
    const transcriptPath = join(directory, 'rollout.jsonl');
    const rows = [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the bug.' }] } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{"path":"old.log"}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'x'.repeat(2_000) } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I found it.' }] } },
    ];
    await writeFile(transcriptPath, rows.map(JSON.stringify).join('\n'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      answers: { call_t1: { noul: 0.01 }, result_t1: { noul: 0.01 } },
    }), { status: 200 })));
    const env = {
      TYPESAFE_API_KEY: 'test-key',
      SAVE_TOKEN_JEV_DATA_DIR: directory,
      SAVE_TOKEN_JEV_PRESERVE_RECENT: '0',
      SAVE_TOKEN_JEV_MIN_REDUCTION: '0.1',
    };

    const before = await handleCodexHook({
      session_id: 'session/unsafe',
      transcript_path: transcriptPath,
      hook_event_name: 'PreCompact',
    }, env);
    expect(before.systemMessage).toContain('prepared retained context');
    expect(JSON.parse(await readFile(codexDataPath('session/unsafe', env), 'utf8'))).toMatchObject({ version: 1 });

    const after = await handleCodexHook({
      session_id: 'session/unsafe',
      hook_event_name: 'SessionStart',
      source: 'compact',
    }, env);
    expect(after).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
      },
    });
    expect(JSON.stringify(after)).toContain('Fix the bug.');
    expect(JSON.stringify(after)).not.toContain('x'.repeat(100));
  });

  it('allows built-in compaction when Jev fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const directory = await mkdtemp(join(tmpdir(), 'save-token-jev-test-'));
    const transcriptPath = join(directory, 'rollout.jsonl');
    await writeFile(transcriptPath, [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'goal' }] } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'c', name: 'read', arguments: '{}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c', output: 'old' } },
    ].map(JSON.stringify).join('\n'));
    const result = await handleCodexHook({ session_id: 's', transcript_path: transcriptPath, hook_event_name: 'PreCompact' }, {
      TYPESAFE_API_KEY: 'test-key', SAVE_TOKEN_JEV_DATA_DIR: directory, SAVE_TOKEN_JEV_PRESERVE_RECENT: '0',
    });
    expect(result).toMatchObject({ continue: true });
    expect(result.systemMessage).toContain('fell back');
  });
});
