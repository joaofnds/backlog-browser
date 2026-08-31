import { homedir } from "node:os";
import { join } from "node:path";

/**
 * What the process environment tells this tool, named in one place rather than read wherever it
 * happens to be wanted. Everything the environment decides is visible here.
 */

/** Where per-user state belongs, following the XDG base directory spec when it is set. */
export function stateHome(): string {
	return process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
}

/** The environment a child server inherits, with the project it serves named in it. */
export function childEnvironment(cwd: string): Record<string, string> {
	const inherited: NodeJS.ProcessEnv = process.env;

	return { ...stringsOf(inherited), BACKLOG_CWD: cwd };
}

/** An environment holds `string | undefined`; an unset name is absent rather than empty. */
function stringsOf(env: NodeJS.ProcessEnv): Record<string, string> {
	const named: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		if (value !== undefined) {
			named[name] = value;
		}
	}

	return named;
}
