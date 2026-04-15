/**
 * Config reader for the standalone fallback plugin.
 *
 * Reads `fallback_models` from OpenCode's agent config section
 * (passed via the plugin config hook), NOT from oh-my-opencode.jsonc.
 */

type AgentRecord = Record<string, unknown>

const SESSION_ID_NOISE_WORDS = new Set(["ses", "work", "task", "session"])

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function normalizeFallbackModelsField(
	value: unknown
): string[] {
	if (!value) return []
	if (typeof value === "string") return [value]
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === "string")
	}
	return []
}

export function readFallbackModels(
	agentName: string,
	agents: AgentRecord | undefined
): string[] {
	if (!agents) return []

	const agentConfig = agents[agentName]
	if (!isRecord(agentConfig)) return []

	// Two shapes supported:
	//
	// 1. `opencode.json:agent.<name>.fallback_models` — top-level. This is
	//    what users write directly in opencode.json.
	//
	// 2. `.opencode/agents/<name>.md` YAML frontmatter — when opencode
	//    parses MD-defined agents, it keeps known schema fields at the
	//    top level (model, temperature, tools, etc.) and relocates
	//    unknown keys into an `options` sub-object. `fallback_models`
	//    is unknown to opencode's agent schema, so frontmatter-authored
	//    chains land at `agentConfig.options.fallback_models`.
	//
	// Check the top-level first (explicit wins over frontmatter), then
	// fall back to the options path. This lets a consumer override an
	// upstream-shipped chain by adding their own `agent.<name>.fallback_models`
	// block to opencode.json.
	const topLevel = normalizeFallbackModelsField(agentConfig.fallback_models)
	if (topLevel.length > 0) return topLevel

	const options = agentConfig.options
	if (isRecord(options)) {
		return normalizeFallbackModelsField(options.fallback_models)
	}

	return []
}

export function resolveAgentForSession(
	sessionID: string,
	eventAgent?: string
): string | undefined {
	if (eventAgent && eventAgent.trim().length > 0) {
		return eventAgent.trim().toLowerCase()
	}

	const segments = sessionID.split(/[\s_\-/]+/).filter(Boolean)
	for (const segment of segments) {
		const candidate = segment.toLowerCase()
		const isAlphaOnly = /^[a-z][a-z-]*$/.test(candidate)
		if (candidate.length > 2 && isAlphaOnly && !SESSION_ID_NOISE_WORDS.has(candidate)) {
			return candidate
		}
	}

	return undefined
}

export function getFallbackModelsForSession(
	sessionID: string,
	eventAgent: string | undefined,
	agents: AgentRecord | undefined,
	globalFallbackModels?: string[]
): string[] {
	const resolvedAgent = resolveAgentForSession(sessionID, eventAgent)

	// Tier 1: Per-agent fallback_models
	if (resolvedAgent && agents) {
		const models = readFallbackModels(resolvedAgent, agents)
		
		// Implicitly include the agent's configured primary model as a
		// last-resort fallback candidate — but only when fallback_models
		// was explicitly configured with entries.  If the user didn't set
		// fallback_models at all (or set it to []), we don't inject the
		// primary — they didn't opt into fallback for this agent.
		//
		// This handles the case where the user manually switches to a
		// fallback model and it later fails: the configured primary
		// becomes available as a recovery target instead of the chain
		// appearing exhausted.
		if (models.length > 0) {
			const agentConfig = agents[resolvedAgent]
			if (isRecord(agentConfig) && typeof agentConfig.model === "string") {
				const primaryModel = agentConfig.model
				if (!models.includes(primaryModel)) {
					models.unshift(primaryModel)
				}
			}
			return models
		}
	}

	// Tier 2: Global fallback_models from plugin config
	if (globalFallbackModels && globalFallbackModels.length > 0) {
		return globalFallbackModels
	}

	// Tier 3: No fallback
	return []
}
