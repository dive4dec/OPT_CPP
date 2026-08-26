// Shared Ask AI prompt configuration (single source of truth).
//
// The system prompt and the code-fence language tag are build-time
// constants with C++ defaults. They can be overridden per deployment
// without code changes:
//
//   DefinePlugin mode (API_INJECT_TARGET=define):
//     __AI_SYSTEM_PROMPT__ / __AI_CODE_LANG__ injected by webpack.config.js
//     from env vars AI_SYSTEM_PROMPT / AI_CODE_LANG (set in Dockerfile
//     via ARG, in CI via workflow env, or in Makefile --build-arg).
//
//   Window mode (API_INJECT_TARGET=window):
//     window.AI_SYSTEM_PROMPT / window.AI_CODE_LANG written into the HTML
//     by HtmlWebpackPlugin's `window` option, read here at runtime.
//
// When unset/empty in both, the C++ defaults apply — so every existing
// deployment builds correct C++ prompts with zero configuration.

// Optional build-time constants (injected when API_INJECT_TARGET === 'define')
declare const __AI_SYSTEM_PROMPT__: string | undefined;
declare const __AI_CODE_LANG__: string | undefined;

export const DEFAULT_AI_SYSTEM_PROMPT =
  "You are a C++ tutor. Respond ONLY with Socratic-style hints: short, guiding QUESTIONS (no solutions, no code, no imperative fixes). At most 100 words.";

export const DEFAULT_AI_CODE_LANG = "cpp";

function resolveOverride(defineValue: string | undefined, windowKey: string): string | undefined {
  // 1. Compile-time constant (DefinePlugin) — only present in define builds
  if (typeof defineValue !== 'undefined' && typeof defineValue === 'string' && defineValue.trim()) {
    return defineValue.trim();
  }
  // 2. Window injection (HtmlWebpackPlugin `window` option)
  const w: any = (window as any) || {};
  if (typeof w[windowKey] === 'string' && w[windowKey].trim()) {
    return w[windowKey].trim();
  }
  return undefined;
}

export function getAiSystemPrompt(): string {
  return resolveOverride(__AI_SYSTEM_PROMPT__, 'AI_SYSTEM_PROMPT') || DEFAULT_AI_SYSTEM_PROMPT;
}

export function getAiCodeLang(): string {
  return resolveOverride(__AI_CODE_LANG__, 'AI_CODE_LANG') || DEFAULT_AI_CODE_LANG;
}
