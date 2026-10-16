import { describe, it, expect } from "vitest";
import { parsePagedText } from "./pagedText.js";

describe("parsePagedText", () => {
    it("puts text before the first marker on page 1, trims lines, drops blank lines, reads CRLF", () => {
        expect(parsePagedText("  ΠΡΟΕΔΡΟΣ: Ναι. \r\n\r\n=== page 2\r\nΔΗΜΑΡΧΟΣ: Όχι.\n")).toEqual([
            { page: 1, lines: ["ΠΡΟΕΔΡΟΣ: Ναι."] },
            { page: 2, lines: ["ΔΗΜΑΡΧΟΣ: Όχι."] },
        ]);
    });
});
