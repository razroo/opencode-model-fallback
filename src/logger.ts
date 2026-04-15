import { PLUGIN_NAME } from "./constants"
import { appendFileSync, mkdirSync, statSync, renameSync, existsSync, unlinkSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const LOG_FILE = join(homedir(), ".config", "opencode", "opencode-model-fallback.log")

// Log rotation: when the current log exceeds this size, rename it to
// `<log>.1` (overwriting any previous rotation) and start fresh.  Keeps
// one backup file, caps total on-disk footprint at ~2× MAX_LOG_BYTES.
//
// Override with OPENCODE_MODEL_FALLBACK_LOG_MAX_BYTES=0 to disable rotation,
// or set to a positive number to customize.
const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024
const envMax = process.env.OPENCODE_MODEL_FALLBACK_LOG_MAX_BYTES
const MAX_LOG_BYTES = envMax === undefined
	? DEFAULT_MAX_LOG_BYTES
	: Math.max(0, Number.parseInt(envMax, 10) || 0)

// Ensure directory exists
try {
	mkdirSync(join(homedir(), ".config", "opencode"), { recursive: true })
} catch {
	// Directory might already exist
}

function rotateIfNeeded(): void {
	if (MAX_LOG_BYTES <= 0) return  // rotation disabled
	try {
		if (!existsSync(LOG_FILE)) return
		const stats = statSync(LOG_FILE)
		if (stats.size < MAX_LOG_BYTES) return

		const rotated = `${LOG_FILE}.1`
		// Remove previous rotation if it exists, then rename current log.
		try {
			if (existsSync(rotated)) unlinkSync(rotated)
		} catch {
			// If we can't unlink the old backup, renameSync may overwrite on
			// most platforms; fall through.
		}
		renameSync(LOG_FILE, rotated)
	} catch {
		// Best-effort: if rotation fails (permissions, race, etc.) just keep
		// appending to the existing file.  Never throw from the log path.
	}
}

function writeToFile(level: string, message: string, context?: Record<string, unknown>): void {
	const timestamp = new Date().toISOString()
	const contextStr = context ? ` ${JSON.stringify(context)}` : ""
	const logLine = `[${timestamp}] [${level}] [${PLUGIN_NAME}] ${message}${contextStr}\n`

	try {
		rotateIfNeeded()
		appendFileSync(LOG_FILE, logLine)
	} catch {
		// Silently fail if can't write to file
	}
}

// Set to true to enable console logging (for debugging only)
const DEBUG_MODE = false

export function logInfo(message: string, context?: Record<string, unknown>): void {
	if (DEBUG_MODE) {
		const contextStr = context ? ` ${JSON.stringify(context)}` : ""
		console.log(`[${PLUGIN_NAME}] ${message}${contextStr}`)
	}
	writeToFile("INFO", message, context)
}

export function logError(message: string, context?: Record<string, unknown>): void {
	if (DEBUG_MODE) {
		const contextStr = context ? ` ${JSON.stringify(context)}` : ""
		console.error(`[${PLUGIN_NAME}] ${message}${contextStr}`)
	}
	writeToFile("ERROR", message, context)
}

export function getLogFilePath(): string {
	return LOG_FILE
}
