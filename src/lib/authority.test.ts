import { describe, it, expect } from "vitest";
import { authorityTerms, isRegion, locationTextRule, parseAuthorityType } from "./authority.js";

describe("isRegion", () => {
    it.each([
        ["region", true],
        ["municipality", false],
        [undefined, false],
    ] as const)("%s → %s", (authorityType, expected) => {
        expect(isRegion(authorityType)).toBe(expected);
    });
});

describe("parseAuthorityType", () => {
    it("reads a request with no kind as a municipality", () => {
        expect(parseAuthorityType(undefined)).toBe("municipality");
    });

    it.each(["municipality", "region"] as const)("accepts %s", (authorityType) => {
        expect(parseAuthorityType(authorityType)).toBe(authorityType);
    });

    it.each(["prefecture", "", "Region", "toString", null, 1, {}, ["region"]].map((value): [unknown] => [value]))("refuses %j", (value) => {
        expect(() => parseAuthorityType(value)).toThrow(RangeError);
        expect(() => parseAuthorityType(value)).toThrow(/Expected one of: municipality, region/);
    });
});

describe("authorityTerms", () => {
    it("gives a request with no kind the words of a municipality", () => {
        expect(authorityTerms()).toBe(authorityTerms("municipality"));
        expect(authorityTerms(undefined).el.head).toBe("δήμαρχος");
    });

    it("gives a region its own words", () => {
        const region = authorityTerms("region");
        expect(region.el.head).toBe("περιφερειάρχης");
        expect(region.el.label).toBe("Περιφέρεια");
        expect(region.en.adjective).toBe("regional");
    });

    it("gives every term of a municipality to a region too", () => {
        const municipality = authorityTerms("municipality");
        const region = authorityTerms("region");
        expect(Object.keys(region.el)).toEqual(Object.keys(municipality.el));
        expect(Object.keys(region.en)).toEqual(Object.keys(municipality.en));
    });
});

describe("locationTextRule", () => {
    it("tells a municipality to write the place name only", () => {
        expect(locationTextRule().spoken).toContain("ΜΗΝ προσθέτεις πόλη");
        expect(locationTextRule("municipality").written).toContain("ΜΗΝ προσθέτεις πόλη");
    });

    it("tells a region to write the town after the place, and never the name of the region", () => {
        for (const rule of [locationTextRule("region").spoken, locationTextRule("region").written]) {
            expect(rule).toContain("«Πλατεία Ηρώων, Τρίκαλα»");
            expect(rule).toContain("ΜΗΝ προσθέτεις το όνομα της περιφέρειας ή τη χώρα");
            expect(rule).not.toContain("ΜΗΝ προσθέτεις πόλη");
        }
    });

    it("tells a region to give no place when the town is not known", () => {
        for (const rule of [locationTextRule("region").spoken, locationTextRule("region").written]) {
            expect(rule).toContain("βάλε null");
            expect(rule).not.toContain("γράψε μόνο το τοπωνύμιο");
        }
    });

    it("gives a region examples that show the town", () => {
        const lines = locationTextRule("region").examples.split("\n");
        expect(lines.filter(line => !line.startsWith("- Πόλη ή οικισμός")).every(line => line.includes(", "))).toBe(true);
        expect(locationTextRule("municipality").examples).toContain("«Λεωφόρος Μεσογείων 45»");
    });
});
