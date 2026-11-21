import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";

vi.mock("axios");

import { geocodeInRegion, geocodeLocation } from "./geocode.js";

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

describe("geocodeInRegion", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.spyOn(console, "warn").mockImplementation(() => { });
        vi.spyOn(console, "error").mockImplementation(() => { });
    });

    /** Answers each address with its own point. An address that is not in the table has no result. */
    function answer(points: Record<string, [number, number]>) {
        mockedGet.mockImplementation(async (_url, config) => {
            const point = points[(config?.params as { address: string }).address];
            return point ? okResponse(["route"], point[0], point[1]) : { data: { status: "ZERO_RESULTS", results: [] } };
        });
    }

    it("asks for the place and then the name of the region, and returns its point", async () => {
        answer({ "Οδός Κύπρου 12, Λάρισα, Θεσσαλία": [39.639, 22.419], "Θεσσαλία": [39.5, 22.0] });

        await expect(geocodeInRegion("Οδός Κύπρου 12, Λάρισα", "Θεσσαλία", "GR")).resolves.toEqual({ lat: 39.639, lng: 22.419 });
    });

    it("discards a place that gets the point of the region itself", async () => {
        answer({ "Πλατεία Ανύπαρκτη, Ήπειρος": [39.6, 20.8], "Ήπειρος": [39.6, 20.8] });

        await expect(geocodeInRegion("Πλατεία Ανύπαρκτη", "Ήπειρος", "GR")).resolves.toBeNull();
    });

    it("asks for the point of a region once for many places", async () => {
        answer({ "Α, Κρήτη": [35.1, 24.1], "Β, Κρήτη": [35.2, 24.2], "Κρήτη": [35.3, 24.9] });

        await geocodeInRegion("Α", "Κρήτη", "GR");
        await geocodeInRegion("Β", "Κρήτη", "GR");

        expect(mockedGet.mock.calls.filter(call => (call[1]?.params as { address: string }).address === "Κρήτη")).toHaveLength(1);
    });

    it("keeps the place when the geocoder has no answer for the region alone, and asks again next time", async () => {
        answer({ "Α, Πελοπόννησος": [37.5, 22.3] });

        await expect(geocodeInRegion("Α", "Πελοπόννησος", "GR")).resolves.toEqual({ lat: 37.5, lng: 22.3 });
        await geocodeInRegion("Α", "Πελοπόννησος", "GR");

        expect(mockedGet.mock.calls.filter(call => (call[1]?.params as { address: string }).address === "Πελοπόννησος")).toHaveLength(2);
    });

    it("asks nothing about the region when the place has no result", async () => {
        answer({});

        await expect(geocodeInRegion("Α", "Δυτική Ελλάδα", "GR")).resolves.toBeNull();
        expect(mockedGet).toHaveBeenCalledOnce();
    });
});
