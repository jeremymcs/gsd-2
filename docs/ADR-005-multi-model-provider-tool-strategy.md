# ADR-005: Multi-Model, Multi-Provider, and Tool Strategy

**Status:** Draft
**Date:** 2026-03-27
**Deciders:** Jeremy McSpadden
**Related:** ADR-004 (capability-aware model routing), ADR-003 (pipeline simplification), [PR #2755](https://github.com/gsd-build/gsd-2/pull/2755)

## Context

PR #2755 lands capability-aware model routing (ADR-004), extending the router from a one-dimensional complexity-tier system to a two-dimensional system that scores models across 7 capability dimensions. GSD can now intelligently pick the best model for a task from a heterogeneous pool.

But model selection is only one piece of the multi-model puzzle. The system now faces a set of structural gaps that become more pressing as users configure diverse provider pools:

### 1. Tool compatibility is assumed, not verified

Every registered tool is sent to every model regardless of provider. The `pi-ai` layer normalizes tool schemas per provider (Anthropic `tool_use`, OpenAI `function`, Google `functionDeclarations`, Bedrock `toolSpec`, Mistral `FunctionTool`), but there is no mechanism to express that:

- A model may not support tool calling at all (older/smaller models, some local models)
- A provider may not support certain schema features (Google Gemini doesn't support `patternProperties`; `sanitizeSchemaForGoogle()` patches this silently)
- Some tools produce image content in results that not all models can consume
- Tool call ID formats differ across providers (Anthropic: 64-char alphanumeric; OpenAI Responses: 450+ chars with pipes; Mistral: 9-char hashes) — `transform-messages.ts` normalizes these, but failures are silent

When capability routing (PR #2755) selects a model from a different provider than previous turns, the conversation may contain tool calls and results formatted for the original provider. The system handles this through ID normalization and synthetic tool results for orphaned calls, but this is reactive patching, not architectural intent.

### 2. No tool-aware model routing

ADR-004 scores models on 7 capability dimensions (`coding`, `debugging`, `research`, `reasoning`, `speed`, `longContext`, `instruction`). None of these dimensions encode whether a model can actually use the tools the task requires. A task that needs `bash` execution, file editing, and web search should not route to a model that cannot process tool results — but the router has no way to express this constraint.

### 3. Provider failover loses context fidelity

When a provider fails and the system falls back to another provider, `transform-messages.ts` handles the mechanical translation:

- Thinking blocks from the failed provider are either dropped (if redacted/encrypted) or converted to plain text (losing structured reasoning)
- Thought signatures (Google-specific opaque context) are dropped for cross-provider switches
- Tool call IDs are renormalized, which can cause result-matching ambiguity

This works for resilience but degrades conversation quality in ways that are invisible to the user and untracked by observability.

### 4. Tool availability is static across a session

`pi.registerTool()` registers tools at extension bootstrap. The active tool set can be changed via `setActiveTools()`, but nothing connects tool availability to model capabilities. If the router downgrades from Opus to Haiku mid-session, the same 15+ tools are presented to both — even though a light model may perform better with a smaller, focused tool set.

### 5. No provider capability registry

Each provider implementation in `packages/pi-ai/src/providers/` independently handles its quirks: schema sanitization (Google), tool call ID normalization (all), image support detection (Mistral), thinking block handling (all). There is no unified registry that describes what a provider supports. This knowledge is scattered across `*-shared.ts` files and discovered by reading code.

## Decision

**Introduce a provider capability registry and tool compatibility layer that integrates with the existing capability-aware model router (ADR-004/PR #2755), enabling tool-aware model selection, provider-aware tool filtering, and explicit cross-provider conversation handling.**

### Design Principles

1. **Layered on ADR-004, not replacing it.** Capability scoring from PR #2755 remains the primary model selection mechanism. This ADR adds tool compatibility as a hard constraint applied before scoring, and provider capabilities as metadata that informs tool presentation.

2. **Hard constraints filter; soft scores rank.** Tool support is binary (model can or cannot use tools) — it filters the eligible set. Capability scores rank within the filtered set. This prevents the router from ever selecting a model that cannot execute the required tools.

3. **Provider knowledge is declarative, not scattered.** Provider capabilities move from implicit code behavior to an explicit registry that the router, tool system, and observability layer can query.

4. **Tool sets adapt to model capabilities.** When the router selects a different model tier, the active tool set can be adjusted — not to remove tools the model "shouldn't" use, but to reduce prompt complexity for models that benefit from focus.

5. **Graceful degradation preserved.** Unknown providers and models without registry entries get full tool access and no filtering — same behavior as today. The system only restricts when it has explicit knowledge.

### Provider Capability Registry

A declarative registry describing what each provider/model combination supports:

```ts
interface ProviderCapabilities {
  /** Whether models from this provider support tool calling */
  toolCalling: boolean;
  /** Maximum number of tools the provider handles well (0 = unlimited) */
  maxTools: number;
  /** Whether tool results can contain images */
  imageToolResults: boolean;
  /** Whether the provider supports structured JSON output */
  structuredOutput: boolean;
  /** Tool call ID format constraints */
  toolCallIdFormat: {
    maxLength: number;
    allowedChars: RegExp;
  };
  /** Whether thinking/reasoning blocks are preserved cross-turn */
  thinkingPersistence: "full" | "text-only" | "none";
  /** Schema features NOT supported (tools using these get filtered) */
  unsupportedSchemaFeatures: string[];  // e.g., ["patternProperties"]
}

const PROVIDER_CAPABILITIES: Record<string, ProviderCapabilities> = {
  "anthropic-messages": {
    toolCalling: true,
    maxTools: 0,
    imageToolResults: true,
    structuredOutput: true,
    toolCallIdFormat: { maxLength: 64, allowedChars: /^[a-zA-Z0-9_-]+$/ },
    thinkingPersistence: "full",
    unsupportedSchemaFeatures: [],
  },
  "openai-responses": {
    toolCalling: true,
    maxTools: 0,
    imageToolResults: false,
    structuredOutput: true,
    toolCallIdFormat: { maxLength: 512, allowedChars: /^.+$/ },
    thinkingPersistence: "text-only",
    unsupportedSchemaFeatures: [],
  },
  "google-generative-ai": {
    toolCalling: true,
    maxTools: 0,
    imageToolResults: true,
    structuredOutput: true,
    toolCallIdFormat: { maxLength: 64, allowedChars: /^[a-zA-Z0-9_-]+$/ },
    thinkingPersistence: "text-only",
    unsupportedSchemaFeatures: ["patternProperties"],
  },
  "mistral-conversations": {
    toolCalling: true,
    maxTools: 0,
    imageToolResults: false,
    structuredOutput: true,
    toolCallIdFormat: { maxLength: 9, allowedChars: /^[a-zA-Z0-9]+$/ },
    thinkingPersistence: "none",
    unsupportedSchemaFeatures: [],
  },
  "bedrock-converse-stream": {
    toolCalling: true,
    maxTools: 0,
    imageToolResults: false,
    structuredOutput: true,
    toolCallIdFormat: { maxLength: 64, allowedChars: /^[a-zA-Z0-9_-]+$/ },
    thinkingPersistence: "text-only",
    unsupportedSchemaFeatures: [],
  },
};
```

Unknown providers default to a permissive profile (`toolCalling: true`, no restrictions) preserving current behavior.

### Tool Compatibility Metadata

Each tool definition gains optional compatibility metadata:

```ts
interface ToolCompatibility {
  /** Tool requires image content in results */
  producesImages?: boolean;
  /** Tool requires schema features that some providers don't support */
  schemaFeatures?: string[];
  /** Tool is effective only with models above a minimum capability threshold */
  minCapabilityTier?: "light" | "standard" | "heavy";
}
```

This is added to the existing `ToolDefinition` interface in `pi-coding-agent`:

```ts
interface ToolDefinition<TParams, TDetails> {
  name: string;
  label: string;
  description: string;
  parameters: TParams;
  execute(...): Promise<AgentToolResult>;
  // New:
  compatibility?: ToolCompatibility;
}
```

Tools without `compatibility` metadata are assumed universally compatible (no filtering).

### The Revised Routing Pipeline

Building on ADR-004's pipeline (as implemented in PR #2755):

```
unit dispatch
  → classifyUnitComplexity(...)
      [unchanged — determines tier eligibility and budget filtering]
  → resolveModelForComplexity(...)
      → STEP 1: filter to tier-eligible models (downgrade-only from user ceiling)
      → STEP 2: NEW — filter out models whose provider cannot support required tools
          → getRequiredTools(unitType, taskMetadata) → tool names
          → for each eligible model, check provider capabilities against tool compatibility
          → remove models that fail hard constraints (no tool calling, unsupported schema, etc.)
      → STEP 3: capability scoring (PR #2755) among filtered set
      → STEP 4: assemble fallback chain
  → resolveModelId() → pi.setModel()
  → NEW — adjustToolSet(selectedModel, registeredTools)
      → filter active tools based on provider capabilities of selected model
      → order tools by relevance to task type (most-used first for prompt efficiency)
```

### Tool Filtering on Model Selection

When a model is selected, the tool set presented to it can be adjusted:

```ts
function adjustToolSet(
  selectedModel: { id: string; provider: string; api: string },
  registeredTools: ToolDefinition[],
  providerCaps: ProviderCapabilities,
): ToolDefinition[] {
  return registeredTools.filter(tool => {
    const compat = tool.compatibility;
    if (!compat) return true;  // no metadata = always included

    // Hard filter: provider doesn't support image tool results
    if (compat.producesImages && !providerCaps.imageToolResults) return false;

    // Hard filter: tool uses schema features provider doesn't support
    if (compat.schemaFeatures?.some(f => providerCaps.unsupportedSchemaFeatures.includes(f))) {
      return false;
    }

    return true;
  });
}
```

This is a **hard filter** — it removes tools that would fail at the provider level. It does not remove tools based on soft heuristics like "Haiku shouldn't use complex tools." That path leads to fragile assumptions and surprising behavior.

### Cross-Provider Conversation Continuity

When the router switches providers mid-conversation (e.g., Anthropic → Google on a research task), formalize the existing `transform-messages.ts` behavior as an explicit contract:

```ts
interface ProviderSwitchReport {
  fromApi: string;
  toApi: string;
  thinkingBlocksDropped: number;
  thinkingBlocksDowngraded: number;  // full → text-only
  toolCallIdsRemapped: number;
  syntheticToolResultsInserted: number;
  thoughtSignaturesDropped: number;
}
```

This report is:
1. Logged to routing history alongside the `RoutingDecision` from ADR-004
2. Surfaced in verbose mode output
3. Available to the `before_model_select` hook so extensions can factor context fidelity into routing decisions

### Configuration

Provider capability overrides in `models.json`, alongside existing `modelOverrides`:

```json
{
  "providers": {
    "openai-responses": {
      "capabilities": {
        "imageToolResults": true
      }
    }
  }
}
```

Partial overrides deep-merge with built-in defaults, same pattern as ADR-004's capability profile overrides.

## Consequences

### Positive

#### 1. Eliminates silent tool failures

Today, if the router selects a model whose provider can't handle a tool's schema or result format, the failure surfaces as a cryptic API error or degraded output. With explicit compatibility filtering, the router never selects a model that can't execute the task's tools.

#### 2. Makes cross-provider routing safe by default

PR #2755 enables capability scoring across providers (`cross_provider: true`). This ADR ensures that cross-provider selection accounts for tool compatibility, not just capability scores. A model that scores highest on `research` but can't handle the task's tools won't be selected.

#### 3. Provider knowledge becomes queryable

Moving provider quirks from scattered `*-shared.ts` code into a declarative registry means the router, the tool system, observability, and extensions can all query provider capabilities without reading implementation code.

#### 4. Cross-provider context loss becomes visible

The `ProviderSwitchReport` makes it explicit when and how conversation fidelity degrades during provider switches. Users and extensions can make informed decisions about whether cross-provider routing is worth the context cost.

#### 5. Foundation for adaptive tool presentation

While this ADR only implements hard filtering (remove incompatible tools), the `adjustToolSet` hook point enables future soft optimization: ordering tools by task relevance, collapsing rarely-used tools into a meta-tool, or presenting tier-appropriate tool descriptions. These are natural extensions, not scope for this ADR.

### Negative

#### 1. More metadata surfaces to maintain

Provider capabilities and tool compatibility metadata are new data tables that must stay current. Mitigation: provider capabilities change rarely (they track API contracts, not model performance); tool compatibility is optional and only needed for tools with provider-specific requirements.

#### 2. Tool filtering adds a pipeline step

Each model selection now checks tool compatibility. Mitigation: the check is O(models × tools) with small constants — both sets are typically < 20 items. No API calls, sub-millisecond.

#### 3. Risk of over-filtering

Aggressive tool filtering could remove tools a model actually handles fine, reducing agent capability. Mitigation: filtering is opt-in per tool (requires explicit `compatibility` metadata) and permissive by default (unknown providers/tools = no filtering). Hard filters only apply to known incompatibilities, not heuristic guesses.

### Neutral / Migration

#### 1. Existing behavior unchanged without metadata

Tools without `compatibility` and providers not in the registry behave exactly as today. This is a pure extension — no existing configuration breaks.

#### 2. ADR-004 scoring is unmodified

Capability scoring from PR #2755 runs on the filtered eligible set. The scoring function, profiles, and `before_model_select` hook are unchanged. This ADR adds a pre-filter step, not a scoring change.

#### 3. Provider implementations simplify over time

As provider capabilities move into the registry, scattered workarounds in `*-shared.ts` files can be consolidated. Schema sanitization (Google), image support detection (Mistral), and ID normalization logic can reference the registry instead of hardcoding assumptions.

## Risks

### 1. Registry staleness on new provider additions

When a new provider is added to `packages/pi-ai/src/providers/`, the capability registry must be updated. A lint rule should flag providers in `register-builtins.ts` that are missing from the registry (same pattern as ADR-004's profile completeness lint).

### 2. Tool compatibility metadata is author-maintained

Tool authors must opt in to declaring compatibility. If a tool produces images but doesn't declare `producesImages: true`, the filter won't catch it. Mitigation: this fails open (tool is included), matching today's behavior. Over time, common tools can be audited and annotated.

### 3. Over-reliance on provider-level capabilities

Some capability differences are per-model, not per-provider (e.g., `gpt-4o` supports image tool results but `gpt-4o-mini` may not). The registry is provider-scoped as a starting point. Per-model capability overrides via `models.json` provide the escape hatch. If per-model variance proves common, the registry can be extended to support model-level entries.

### 4. Cross-provider routing may be discouraged by visibility

Making context loss visible via `ProviderSwitchReport` could lead users to disable `cross_provider` routing. This is a feature, not a bug — users should understand the tradeoff. The default remains `cross_provider: true`.

## Alternatives Considered

### A. Encode tool support as a capability dimension in ADR-004

Rejected because tool support is a hard constraint (binary: works or doesn't), not a soft score. Mixing it into the 0–100 scoring system would allow a high score in other dimensions to override a fundamental incompatibility. Hard constraints belong in a filter step, not a scoring function.

### B. Per-provider tool translation layers

Each provider could translate any tool schema to its native subset (e.g., strip `patternProperties` for Google, convert image results to text descriptions for providers without image support). Rejected because lossy translation hides failures — a tool that requires image understanding cannot work with a text-only description of the image, regardless of how clean the translation is.

### C. Static tool-to-provider compatibility matrix

A hardcoded `Record<toolName, providerApi[]>` mapping. Rejected because it couples tool names to provider knowledge, doesn't scale with user-defined tools or MCP tools, and requires updating the matrix for every new tool or provider.

### D. Let users manually configure tool sets per model

A `models.json` config like `"claude-haiku-4-5": { "excludeTools": ["WebSearch"] }`. Not rejected as an escape hatch (the `adjustToolSet` extension point enables this), but insufficient as the primary mechanism — it pushes all compatibility knowledge onto users.

### E. Do nothing — rely on providers to error gracefully

Rejected because provider error messages for tool incompatibilities are often opaque (HTTP 400 with schema validation errors), consume tokens on the failed request, and trigger retry logic that burns budget before the router escalates to a compatible model.

## Implementation Sequence

1. **Phase 1:** Add `ProviderCapabilities` registry in `packages/pi-ai/src/providers/`. Populate from existing scattered knowledge in `*-shared.ts` files. Add lint rule for registry completeness. No routing changes.

2. **Phase 2:** Add `ToolCompatibility` to `ToolDefinition` interface. Annotate built-in tools (bash, read, write, edit) — these are universally compatible, so annotations are trivial. Annotate tools with known restrictions (image-producing tools, MCP tools with complex schemas).

3. **Phase 3:** Add tool-compatibility filter step to `resolveModelForComplexity()`, after tier filtering and before capability scoring (PR #2755). Add `ProviderSwitchReport` to `transform-messages.ts`. Wire verbose output.

4. **Phase 4:** Expose `adjustToolSet` as a hook for extensions. Enable tool-set adaptation experiments without core changes.

## Appendix: Current Architecture Reference

| File | Role |
|------|------|
| `packages/pi-ai/src/providers/register-builtins.ts` | Provider registration |
| `packages/pi-ai/src/providers/*-shared.ts` | Provider-specific tool/message handling |
| `packages/pi-ai/src/providers/transform-messages.ts` | Cross-provider message normalization |
| `packages/pi-ai/src/types.ts` | Core types (Tool, Context, ToolCall) |
| `packages/pi-coding-agent/src/core/extensions/types.ts` | ToolDefinition, ExtensionAPI |
| `src/resources/extensions/gsd/model-router.ts` | Tier → model resolution + capability scoring (PR #2755) |
| `src/resources/extensions/gsd/auto-model-selection.ts` | Model selection orchestration |
| `src/resources/extensions/gsd/complexity-classifier.ts` | Complexity + task metadata extraction |
| `src/resources/extensions/gsd/bootstrap/dynamic-tools.ts` | GSD tool registration |
| `src/resources/extensions/gsd/bootstrap/register-extension.ts` | Extension bootstrap |
