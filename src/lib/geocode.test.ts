import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";

vi.mock("axios");

import { geocodeLocation } from "./geocode.js";

const mockedGet = vi.mocked(axios.get);

/** Google's shape for a resolved address. `types` drives the country guard. */
function okResponse(types: string[] = ["route"], lat = 37.9838, lng = 23.7275) {
    return {
        data: {
            status: "OK",
            results: [{ types, geometry: { location: { lat, lng } } }],
        },
    };
}

/** The params object handed to the Google Geocoding API on the last call. */
function lastParams() {
    expect(mockedGet).toHaveBeenCalledOnce();
    return mockedGet.mock.calls.at(-1)?.[1]?.params as Record<string, string>;
}

describe("geocodeLocation", () => {
    beforeEach(() => {
        // resetAllMocks, not clearAllMocks: the latter keeps implementations, so
        // a test added below would inherit the previous one's mocked outcome.
        vi.resetAllMocks();
        vi.spyOn(console, "warn").mockImplementation(() => { });
        vi.spyOn(console, "error").mockImplementation(() => { });
    });

    it("restricts results with a components filter instead of appending the country to the address", async () => {
        mockedGet.mockResolvedValue(okResponse());

        await geocodeLocation("Rue de la République, Lyon", "FR");

        // The country must not leak into the address string: appending it only
        // hints, and lets Google snap an unresolvable address to that country.
        expect(lastParams().address).toBe("Rue de la République, Lyon");
        expect(lastParams().components).toBe("country:FR");
    });

    it("defaults to Greece when no country is given", async () => {
        mockedGet.mockResolvedValue(okResponse());

        await geocodeLocation("Πλατεία Συντάγματος, Αθήνα");

        expect(lastParams().components).toBe("country:GR");
    });

    it("returns the coordinates of the first result", async () => {
        mockedGet.mockResolvedValue(okResponse());

        await expect(geocodeLocation("Πλατεία Συντάγματος, Αθήνα")).resolves.toEqual({
            lat: 37.9838,
            lng: 23.7275,
        });
    });

    it("discards a country-level result — the address is not in that country", async () => {
        // What Google actually returns for an out-of-country address under a
        // components filter: OK, with the country itself at its centroid.
        mockedGet.mockResolvedValue(okResponse(["country", "political"], 39.074, 21.824));

        await expect(geocodeLocation("Rue de la République, Lyon", "GR")).resolves.toBeNull();
    });

    it("keeps a locality-level result — villages legitimately resolve to one", async () => {
        mockedGet.mockResolvedValue(okResponse(["locality", "political"]));

        await expect(geocodeLocation("Ζεμενό, Κόρινθος", "GR")).resolves.toEqual({
            lat: 37.9838,
            lng: 23.7275,
        });
    });

    it("returns null on ZERO_RESULTS", async () => {
        mockedGet.mockResolvedValue({ data: { status: "ZERO_RESULTS", results: [] } });

        await expect(geocodeLocation("Knez Mihailova, Beograd", "RS")).resolves.toBeNull();
        expect(lastParams().components).toBe("country:RS");
    });

    it("returns null when the request throws", async () => {
        mockedGet.mockRejectedValue(new Error("network down"));

        await expect(geocodeLocation("anywhere")).resolves.toBeNull();
    });
});
