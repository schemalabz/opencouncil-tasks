import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";

vi.mock("axios");

import { geocodeLocation, DEFAULT_COUNTRY } from "./geocode.js";

const mockedGet = vi.mocked(axios.get);

function okResponse() {
    return {
        data: {
            status: "OK",
            results: [{ geometry: { location: { lat: 37.9838, lng: 23.7275 } } }],
        },
    };
}

/** The params object handed to the Google Geocoding API on the last call. */
function lastParams() {
    return mockedGet.mock.calls.at(-1)?.[1]?.params as Record<string, string>;
}

describe("geocodeLocation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
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

        expect(DEFAULT_COUNTRY).toBe("GR");
        expect(lastParams().components).toBe("country:GR");
    });

    it("returns the coordinates of the first result", async () => {
        mockedGet.mockResolvedValue(okResponse());

        await expect(geocodeLocation("Πλατεία Συντάγματος, Αθήνα")).resolves.toEqual({
            lat: 37.9838,
            lng: 23.7275,
        });
    });

    it("returns null when the country filter excludes every result", async () => {
        mockedGet.mockResolvedValue({ data: { status: "ZERO_RESULTS", results: [] } });

        await expect(geocodeLocation("Knez Mihailova, Beograd", "RS")).resolves.toBeNull();
    });

    it("returns null when the request throws", async () => {
        mockedGet.mockRejectedValue(new Error("network down"));

        await expect(geocodeLocation("anywhere")).resolves.toBeNull();
    });
});
