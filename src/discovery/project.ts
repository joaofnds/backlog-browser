import { createHash } from "node:crypto";
import { basename } from "node:path";

export class Project {
	public readonly path: string;
	public readonly name: string;
	public readonly slug: string;

	public constructor(props: { path: string; name: string }) {
		this.path = props.path;
		this.name = props.name;
		this.slug = slugFor(props.path);
	}

	public static byName(left: Project, right: Project): number {
		return left.name.localeCompare(right.name, undefined, {
			sensitivity: "base",
		});
	}
}

function slugFor(path: string): string {
	const label = basename(path)
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/gu, "-")
		.replaceAll(/^-+|-+$/gu, "");
	const digest = createHash("sha256").update(path).digest("hex").slice(0, 8);

	return label === "" ? digest : `${label}-${digest}`;
}
