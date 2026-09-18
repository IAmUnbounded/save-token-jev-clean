import { fromOpenCode } from '../adapters/opencode.js';
import { compactMessages, reductionRatio, type CompactMessagesOptions } from '../core.js';
import { renderTranscript } from '../render.js';

interface OpenCodeCompactionEvent {
  messages: unknown[];
  result?: {
    summary: string;
    metadata?: Record<string, unknown>;
  };
}

interface Registration {
  dispose(): Promise<void> | void;
}

interface OpenCodeContext {
  options?: Record<string, unknown>;
  session: {
    hook(name: 'compaction', callback: (event: OpenCodeCompactionEvent) => Promise<void>): Promise<Registration>;
  };
}

export interface OpenCodePluginOptions extends CompactMessagesOptions {
  minReductionRatio?: number;
  onError?: (error: unknown) => void;
}

/** Creates a V2 OpenCode plugin using the documented `session.hook("compaction")` API. */
export function createOpenCodePlugin(options: OpenCodePluginOptions = {}) {
  return {
    id: 'save-token-jev',
    async setup(context: OpenCodeContext): Promise<void> {
      const configured = { ...options, ...(context.options ?? {}) } as OpenCodePluginOptions;
      await context.session.hook('compaction', async (event) => {
        try {
          const result = await compactMessages(fromOpenCode(event.messages), configured);
          if (reductionRatio(result) < (configured.minReductionRatio ?? 0.15)) return;
          event.result = {
            summary: renderTranscript(result.messages, { source: 'OpenCode compaction' }),
            metadata: {
              compactor: 'save-token-jev',
              stats: result.stats,
            },
          };
        } catch (error) {
          configured.onError?.(error);
          // Leaving result unset deliberately invokes OpenCode's built-in fallback.
        }
      });
    },
  };
}

const plugin = createOpenCodePlugin({
  keepThreshold: Number(process.env.SAVE_TOKEN_JEV_KEEP_THRESHOLD || 0.5),
  preserveRecentMessages: Number(process.env.SAVE_TOKEN_JEV_PRESERVE_RECENT || 6),
  minReductionRatio: Number(process.env.SAVE_TOKEN_JEV_MIN_REDUCTION || 0.15),
});

export default plugin;
