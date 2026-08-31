/**
 * What JSON can carry. A value going out to a file or a response is this, not `unknown`: a
 * function or a cycle would be dropped or throw at serialisation, and the type says so up front.
 *
 * Incoming bytes are still parsed against a schema before anything reads them. This type describes
 * what can be written, not what a document turned out to hold.
 */
export type Json =
	| string
	| number
	| boolean
	| null
	| readonly Json[]
	| JsonObject;

/**
 * Declared rather than inlined so a declared shape can satisfy it: TypeScript gives an interface
 * no implicit index signature, so an inline one would refuse every named response type.
 */
export interface JsonObject {
	readonly [key: string]: Json | undefined;
}
