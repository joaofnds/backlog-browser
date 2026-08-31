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

/**
 * The environment a child server inherits. A `Map` rather than an object, because an environment
 * is a set of names looked up at runtime, not a record whose fields anyone knows in advance: the
 * dictionary shape is what made this a value nothing could describe.
 */
export type Environment = ReadonlyMap<string, string>;

/** The inherited environment with the project a child serves named in it. */
export function childEnvironment(cwd: string): Environment {
	return new Map([...namesOf(process.env), ["BACKLOG_CWD", cwd]]);
}

/** What a spawn wants: the same names, in the shape the API takes. */
export function spawnable(environment: Environment): Record<string, string> {
	return Object.fromEntries(environment);
}

/** An environment holds `string | undefined`; an unset name is absent rather than empty. */
function namesOf(env: Readonly<NodeJS.ProcessEnv>): [string, string][] {
	const named: [string, string][] = [];
	for (const [name, value] of Object.entries(env)) {
		if (value !== undefined) {
			named.push([name, value]);
		}
	}

	return named;
}
