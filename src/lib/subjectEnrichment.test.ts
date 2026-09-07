import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./geocode.js");
vi.mock("./claudeSearch.js");

import { enrichSubjectData, type EnrichmentInput } from "./subjectEnrichment.js";
import { geocodeLocation } from "./geocode.js";
import { getSubjectContextWithClaude } from "./claudeSearch.js";

const mockedGeocode = vi.mocked(geocodeLocation);
const mockedContext = vi.mocked(getSubjectContextWithClaude);

function input(overrides: Partial<EnrichmentInput> = {}): EnrichmentInput {
    return {
        name: "Ανάπλαση πλατείας",
        description: "…",
        locationText: "Πλατεία Συντάγματος",
        topicImportance: "normal",
        proximityImportance: "near",
        topicLabel: null,
        agendaItemIndex: 1,
        introducedByPersonId: null,
        speakerContributions: [],
        discussedIn: null,
        ...overrides,
    };
}

describe("enrichSubjectData", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mockedContext.mockResolvedValue({ result: { text: "", citationUrls: [] } } as any);
    });

    it("emits coordinates in GeoJSON [lng, lat] order", async () => {
        // Athens: lat 37.98 (north), lng 23.73 (east). Emitting [lat, lng]
        // instead lands the pin near Cairo once read as [lng, lat].
        mockedGeocode.mockResolvedValue({ lat: 37.9838, lng: 23.7275 });

        const { result } = await enrichSubjectData(input(), "abc123", {
            cityName: "Αθήνα",
            country: "GR",
            date: "2026-01-01",
        });

        expect(result.location).toEqual({
            text: "Πλατεία Συντάγματος",
            type: "point",
            coordinates: [[23.7275, 37.9838]],
        });
    });

    it("leaves location null when geocoding fails", async () => {
        mockedGeocode.mockResolvedValue(null);

        const { result } = await enrichSubjectData(input(), "abc123", {
            cityName: "Αθήνα",
            date: "2026-01-01",
        });

        expect(result.location).toBeNull();
    });

    it("does not geocode when there is no location text", async () => {
        const { result } = await enrichSubjectData(input({ locationText: null }), "abc123", {
            cityName: "Αθήνα",
            date: "2026-01-01",
        });

        expect(mockedGeocode).not.toHaveBeenCalled();
        expect(result.location).toBeNull();
    });

    it("passes agendaItemTitle through when the input defines it", async () => {
        mockedGeocode.mockResolvedValue(null);

        const { result } = await enrichSubjectData(
            input({ agendaItemTitle: "ΑΝΑΠΛΑΣΗ ΠΛΑΤΕΙΑΣ ΣΥΝΤΑΓΜΑΤΟΣ" }),
            "abc123",
            { cityName: "Αθήνα", date: "2026-09-05" }
        );

        expect(result.agendaItemTitle).toBe("ΑΝΑΠΛΑΣΗ ΠΛΑΤΕΙΑΣ ΣΥΝΤΑΓΜΑΤΟΣ");
    });

    it("passes an explicit null agendaItemTitle through", async () => {
        mockedGeocode.mockResolvedValue(null);

        const { result } = await enrichSubjectData(
            input({ agendaItemTitle: null }),
            "abc123",
            { cityName: "Αθήνα", date: "2026-09-05" }
        );

        expect(result.agendaItemTitle).toBeNull();
    });

    it("omits agendaItemTitle when the input does not define it", async () => {
        // summarize never sets the field; the app keeps the stored value when it is absent.
        mockedGeocode.mockResolvedValue(null);

        const { result } = await enrichSubjectData(input(), "abc123", { cityName: "Αθήνα", date: "2026-09-05" });

        expect("agendaItemTitle" in result).toBe(false);
    });
});
