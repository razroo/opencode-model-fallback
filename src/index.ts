import type {
	PluginContext,
	FallbackPluginConfig,
	HookDeps,
	ChatMessageInput,
	ChatMessageOutput,
} from "./types"
import { DEFAULT_CONFIG, PLUGIN_NAME } from "./constants"
import { createAutoRetryHelpers } from "./auto-retry"
import { createEventHandler } from "./event-handler"
import { createMessageUpdateHandler } from "./message-update-handler"
import { createChatMessageHandler } from "./chat-message-handler"
import { normalizeFallbackModelsField } from "./config-reader"
import { isEmptyTaskResult, extractChildSessionID, waitForChildFallbackResult } from "./subagent-result-sync"
import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { parse as parseJsonc } from "jsonc-parser"
import { logInfo } from "./logger"

/** Validate that each fallback model string looks like `provider/model`.
 *  At dispatch time the rotation silently skips malformed entries, which
 *  can mask typos for a long time; warn loudly once per bad entry here
 *  so operators can catch config errors in the first log line. */
const MODEL_FORMAT = /^[^/\s][^\s]*\/[^\s]+$/
function validateFallbackModels(
	models: string[],
	context: { scope: string; agent?: string }
): void {
	for (const model of models) {
		if (typeof model !== "string" || !MODEL_FORMAT.test(model)) {
			logInfo(
				"Invalid fallback_models entry — expected 'provider/model' format",
				{
					invalidEntry: typeof model === "string" ? model : String(model),
					scope: context.scope,
					...(context.agent ? { agent: context.agent } : {}),
					hint: "Rotations that reach this entry will be skipped. Fix in opencode.json.",
				}
			)
		}
	}
}

declare function setInterval(
	callback: () => void,
	delay: number
): { unref: () => void } & ReturnType<typeof globalThis.setInterval>

function loadPluginConfig(directory: string): Partial<FallbackPluginConfig> {
	const configPaths = [
		join(directory, ".opencode", "opencode-model-fallback.json"),
		join(directory, ".opencode", "opencode-model-fallback.jsonc"),
		join(process.env.HOME || "", ".config", "opencode", "opencode-model-fallback.json"),
		join(process.env.HOME || "", ".config", "opencode", "opencode-model-fallback.jsonc"),
	]

	for (const configPath of configPaths) {
		if (existsSync(configPath)) {
			try {
				const content = readFileSync(configPath, "utf-8")
				// parseJsonc handles // comments, /* */ blocks, and trailing commas seamlessly
				return parseJsonc(content) as Partial<FallbackPluginConfig>
			} catch (err) {
				logInfo(`[${PLUGIN_NAME}] Failed to parse config: ${configPath}`, err as Record<string, unknown>)
			}
		}
	}

	return {}
}

export default async function OpenCodeFallbackPlugin(
	ctx: PluginContext,
	configOverrides?: Partial<FallbackPluginConfig>
) {
	let agentConfigs: Record<string, unknown> | undefined
	let fileConfig: Partial<FallbackPluginConfig> = loadPluginConfig(ctx.directory)
	let mergedConfig: Required<FallbackPluginConfig> | undefined
	const globalFallbackModels = normalizeFallbackModelsField(fileConfig.fallback_models)
	validateFallbackModels(globalFallbackModels, { scope: "global" })

	// Config getter that builds config on first access
	const getConfig = (): Required<FallbackPluginConfig> => {
		mergedConfig ??= {
			enabled:
				configOverrides?.enabled ??
				fileConfig?.enabled ??
				DEFAULT_CONFIG.enabled,
			retry_on_errors:
				configOverrides?.retry_on_errors ??
				fileConfig?.retry_on_errors ??
				DEFAULT_CONFIG.retry_on_errors,
			retryable_error_patterns:
				configOverrides?.retryable_error_patterns ??
				fileConfig?.retryable_error_patterns ??
				DEFAULT_CONFIG.retryable_error_patterns,
			max_fallback_attempts:
				configOverrides?.max_fallback_attempts ??
				fileConfig?.max_fallback_attempts ??
				DEFAULT_CONFIG.max_fallback_attempts,
			cooldown_seconds:
				configOverrides?.cooldown_seconds ??
				fileConfig?.cooldown_seconds ??
				DEFAULT_CONFIG.cooldown_seconds,
			timeout_seconds:
				configOverrides?.timeout_seconds ??
				fileConfig?.timeout_seconds ??
				DEFAULT_CONFIG.timeout_seconds,
			notify_on_fallback:
				configOverrides?.notify_on_fallback ??
				fileConfig?.notify_on_fallback ??
				DEFAULT_CONFIG.notify_on_fallback,
			fallback_models:
				configOverrides?.fallback_models ??
				fileConfig?.fallback_models ??
				DEFAULT_CONFIG.fallback_models,
		}

		return mergedConfig
	}

	const deps: HookDeps = {
		ctx,
		get config() {
			return getConfig()
		},
		get agentConfigs() {
			return agentConfigs
		},
		globalFallbackModels,
		sessionStates: new Map(),
		sessionLastAccess: new Map(),
		sessionRetryInFlight: new Set(),
		sessionAwaitingFallbackResult: new Set(),
		sessionFallbackTimeouts: new Map(),
		sessionFirstTokenReceived: new Map(),
		sessionSelfAbortTimestamp: new Map(),
		sessionParentID: new Map(),
		sessionIdleResolvers: new Map(),
		sessionLastMessageTime: new Map(),
		sessionCompactionInFlight: new Set(),
	}

	const helpers = createAutoRetryHelpers(deps)
	const { handleEvent: baseEventHandler, handleActivity } = createEventHandler(deps, helpers)
	const messageUpdateHandler = createMessageUpdateHandler(deps, helpers)
	const chatMessageHandler = createChatMessageHandler(deps, helpers)

	const cleanupInterval = setInterval(
		helpers.cleanupStaleSessions,
		5 * 60 * 1000
	)
	cleanupInterval.unref()

	logInfo(`Plugin initialized (${globalFallbackModels.length} global fallback model(s) configured)`)

	return {
		name: PLUGIN_NAME,

		config: (opencodeConfig: Record<string, unknown>) => {
			// Try 'agents' (plural) first, then 'agent' (singular)
			const agentsValue = opencodeConfig.agents
			const agentValue = opencodeConfig.agent

			if (agentsValue && typeof agentsValue === "object" && !Array.isArray(agentsValue)) {
				agentConfigs = agentsValue as Record<string, unknown>
			} else if (agentValue && typeof agentValue === "object" && !Array.isArray(agentValue)) {
				agentConfigs = agentValue as Record<string, unknown>
			} else {
				agentConfigs = undefined
			}

			// Walk every agent's fallback_models once at init and warn about
			// malformed entries.  Cheap (N agents × K fallback models) and
			// surfaces typos in the first log line instead of silently
			// skipping them at dispatch time under load.
			if (agentConfigs) {
				for (const [agentName, rawAgentCfg] of Object.entries(agentConfigs)) {
					if (!rawAgentCfg || typeof rawAgentCfg !== "object") continue
					const agentCfg = rawAgentCfg as Record<string, unknown>
					const fm = agentCfg.fallback_models
					if (fm === undefined) continue
					const models = normalizeFallbackModelsField(fm as string | string[])
					validateFallbackModels(models, { scope: "agent", agent: agentName })
				}
			}

			logInfo(`Plugin initialized with ${agentConfigs ? Object.keys(agentConfigs).length : 0} agents`)
		},

		event: async ({
			event,
		}: {
			event: { type: string; properties?: unknown }
		}) => {
			if (event.type === "message.updated") {
				if (!deps.config.enabled) return
				const props = event.properties as
					| Record<string, unknown>
					| undefined
				await messageUpdateHandler(props)
				return
			}
			
			if (
				event.type === "message.part.delta" ||
				event.type === "session.diff" ||
				event.type === "message.part.updated"
			) {
				const props = event.properties as Record<string, unknown> | undefined
				const info = props?.info as Record<string, unknown> | undefined
				const sessionID =
					(props?.sessionID as string | undefined) ??
					(info?.sessionID as string | undefined) ??
					(info?.id as string | undefined)
				// Extract model from activity event so handleActivity can
				// distinguish stale activity from the failed model vs real
				// activity from the fallback model.
				const activityModel =
					(info?.model as string | undefined) ??
					(typeof info?.providerID === "string" && typeof info?.modelID === "string"
						? `${info.providerID}/${info.modelID}`
						: undefined) ??
					(props?.model as string | undefined)
				if (sessionID) {
					await handleActivity(sessionID, activityModel)
				}
			}
			
			await baseEventHandler({ event })

		},

		"tool.execute.after": async (
			input: { tool: string; sessionID: string; callID: string; args: any },
			output: { title: string; output: string; metadata: any }
		) => {
			// Only intercept task tool calls with empty results
			if (input.tool !== "task" || !isEmptyTaskResult(output.output)) {
				return
			}

			const childSessionID = extractChildSessionID(output.output)
			if (!childSessionID) {
				logInfo("Empty task result but no child session ID found", {
					sessionID: input.sessionID,
					outputPreview: output.output?.substring(0, 200),
				})
				return
			}

			logInfo("Detected empty task result, waiting for child fallback", {
				parentSession: input.sessionID,
				childSession: childSessionID,
			})

			// Wait for child session fallback to complete (bounded)
			const maxWaitMs = Math.min(
				(deps.config.timeout_seconds || 120) * 1000,
				120_000,
			)
			const replacementText = await waitForChildFallbackResult(deps, childSessionID, {
				maxWaitMs,
				pollIntervalMs: 500,
			})

			if (replacementText) {
				output.output = replacementText
				logInfo("Replaced empty task result with fallback response", {
					parentSession: input.sessionID,
					childSession: childSessionID,
					responseLength: replacementText.length,
				})
			} else {
				logInfo("No fallback response available, preserving original output", {
					parentSession: input.sessionID,
					childSession: childSessionID,
				})
			}
		},

		"chat.message": async (
			input: ChatMessageInput,
			output: ChatMessageOutput
		) => {
			await chatMessageHandler(input, output)
		},
	}
}
