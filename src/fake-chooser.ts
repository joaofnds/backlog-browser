import type { ChosenFolder } from "./choose-folder.ts";

/** Stands in for the host's chooser: the tests say what the user chose, no window involved. */
export class FakeChooser {
	public readonly openedAt: string[] = [];
	private answer: ChosenFolder = { kind: "cancelled" };

	public chooses(path: string): void {
		this.answer = { kind: "chosen", path };
	}

	public cancels(): void {
		this.answer = { kind: "cancelled" };
	}

	public breaks(reason: string): void {
		this.answer = { kind: "unavailable", reason };
	}

	public fails(reason: string): void {
		this.answer = { kind: "failed", reason };
	}

	public choose = ({
		startAt,
	}: {
		readonly startAt: string;
	}): Promise<ChosenFolder> => {
		this.openedAt.push(startAt);

		return Promise.resolve(this.answer);
	};
}
