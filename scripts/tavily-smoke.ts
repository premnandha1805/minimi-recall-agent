import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EnvSchema, loadEnvIfPresent } from '../src/config.js';
import { searchTavily, TavilySearchError } from '../src/search.js';

/** Manual only. Tests inject fetch; importing this module never makes a request. */
export async function runTavilySmoke(args: string[], dependencies: {
  fetchImpl?: typeof fetch;
  readKey?: () => string | undefined;
} = {}): Promise<{ exitCode: number; metadata: Record<string, string | number | null> }> {
  if (args.length !== 1 || args[0] !== '--live') return {
    exitCode: 1, metadata: { status: 'not_run', message: 'Explicit --live is required. Check available free credits first; one basic query will be sent.' },
  };
  try {
    const apiKey = dependencies.readKey ? dependencies.readKey() : (() => {
      loadEnvIfPresent();
      return EnvSchema.shape.TAVILY_API_KEY.parse(process.env.TAVILY_API_KEY);
    })();
    const start = performance.now();
    const result = await searchTavily('What is the Internet Engineering Task Force?', {
      apiKey, signal: new AbortController().signal, fetchImpl: dependencies.fetchImpl,
    });
    return { exitCode: 0, metadata: {
      status: 'ok', resultCount: result.documents.length, elapsedMs: Math.round(performance.now() - start),
      credits: result.credits ?? null, // null means unreported, not free or zero.
      publicationDates: result.documents.filter((document) => document.published_at !== undefined).length,
    } };
  } catch (error) {
    return { exitCode: 1, metadata: { status: 'failed',
      code: error instanceof TavilySearchError ? error.code : 'CONFIGURATION_ERROR', credits: null } };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runTavilySmoke(process.argv.slice(2));
  console.log(JSON.stringify(result.metadata));
  process.exitCode = result.exitCode;
}
