import { describe, expect, test } from "bun:test";

import { PortBook } from "./port-book.ts";

const ALPHA = "/code/alpha";
const BETA = "/code/beta";

describe("PortBook", () => {
  test("knows no port for a project it has never seen", () => {
    expect(PortBook.empty().portFor(ALPHA)).toBeNull();
  });

  test("hands back the port a project was assigned", () => {
    expect(PortBook.empty().assign(ALPHA, 40_001).portFor(ALPHA)).toEqual(40_001);
  });

  test("keeps one port per project", () => {
    const book = PortBook.empty().assign(ALPHA, 40_001).assign(BETA, 40_002);

    expect(book.portFor(ALPHA)).toEqual(40_001);
  });

  test("replaces a project's port when it is assigned again", () => {
    const book = PortBook.empty().assign(ALPHA, 40_001).assign(ALPHA, 40_002);

    expect(book.portFor(ALPHA)).toEqual(40_002);
  });

  describe("reading stored state", () => {
    test("reads a stored port back", () => {
      expect(PortBook.from({ ports: { [ALPHA]: 40_001 } }).portFor(ALPHA)).toEqual(40_001);
    });

    test("is empty when the root holds no ports", () => {
      expect(PortBook.from({ active: "alpha-1234abcd" })).toEqual(PortBook.empty());
    });

    test("is empty when the root is a bare slug", () => {
      expect(PortBook.from("alpha-1234abcd")).toEqual(PortBook.empty());
    });

    test.each([["not a number"], [0], [70_000], [40_001.5], [null]])(
      "drops %s as a port",
      (stored) => {
        expect(PortBook.from({ ports: { [ALPHA]: stored } }).portFor(ALPHA)).toBeNull();
      },
    );
  });
});
