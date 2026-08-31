/** Stands in for the kernel: a free preferred port is honoured, anything else is the next one up. */
export class FakePortSpace {
	private readonly taken = new Set<number>();
	private next = 40_000;

	allocate = async (preferred = 0): Promise<number> => {
		if (preferred !== 0 && !this.taken.has(preferred)) {
			return preferred;
		}

		this.next += 1;

		return this.next;
	};

	occupy(...ports: number[]): void {
		for (const port of ports) {
			this.taken.add(port);
		}
	}

	/** Marks the next `count` ports the counter will hand out, without naming their numbers. */
	occupyNext(count: number): void {
		for (let ahead = 1; ahead <= count; ahead += 1) {
			this.taken.add(this.next + ahead);
		}
	}

	isTaken(port: number): boolean {
		return this.taken.has(port);
	}
}
