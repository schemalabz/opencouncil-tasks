import { describe, it, expect } from "vitest";
import { OcAsrProvider } from "./ocasr.js";

/**
 * One provider instance serves every concurrent segment. The identity is half
 * the component cache key, so it has to describe the call being made and not
 * whichever call happened to run most recently.
 */
describe("OcAsrProvider identity", () => {
    it("depends on the transport it is given, not on a previous call", () => {
        const provider = new OcAsrProvider();

        const url = provider.identity("url");
        const bytes = provider.identity("bytes");

        expect(url.paramsSha).not.toBe(bytes.paramsSha);
        // Asking again in the other order returns the same answers: nothing
        // about the first call leaked into the second.
        expect(provider.identity("bytes").paramsSha).toBe(bytes.paramsSha);
        expect(provider.identity("url").paramsSha).toBe(url.paramsSha);
    });
});
