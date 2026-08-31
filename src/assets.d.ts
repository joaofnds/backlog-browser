/**
 * Bun turns `import x from "./a.css" with { type: "text" }` into the file's contents, and embeds
 * the file when compiling to a binary. TypeScript needs telling what those imports produce.
 */
declare module "*/index.html" {
	const contents: string;
	export default contents;
}

declare module "*.css" {
	const contents: string;
	export default contents;
}

declare module "*/shell.js" {
	const contents: string;
	export default contents;
}
