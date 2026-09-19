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

  it('sends the compaction questions to OpenRouter when only its key is configured', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'save-token-jev-test-'));
    const transcriptPath = join(directory, 'rollout.jsonl');
    await writeFile(transcriptPath, [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Ship the fix.' }] } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{"path":"old.log"}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'x'.repeat(2_000) } },
    ].map(JSON.stringify).join('\n'));
    const requests: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
      requests.push({ url, body: init.body });
      return new Response(JSON.stringify({
        model: 'typesafe/jev-1.13-20260917',
        provider: 'TypeSafe',
        answers: { call_t1: { type: 'noul', noul: 0.01 }, result_t1: { type: 'noul', noul: 0.01 } },
        usage: { input_tokens: 10, output_tokens: 2, cost: 0.00002 },
      }), { status: 200 });
    }));
    const env = {
      OPENROUTER_API_KEY: 'openrouter-test-key',
      SAVE_TOKEN_JEV_DATA_DIR: directory,
      SAVE_TOKEN_JEV_PRESERVE_RECENT: '0',
      SAVE_TOKEN_JEV_MIN_REDUCTION: '0.1',
    };

    const result = await handleCodexHook({
      session_id: 'openrouter',
      transcript_path: transcriptPath,
      hook_event_name: 'PreCompact',
    }, env);

    expect(result.systemMessage).toContain('prepared retained context');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ model: 'typesafe/jev-1.13' });
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
