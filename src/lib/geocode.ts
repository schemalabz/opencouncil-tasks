import axios from 'axios';

interface LatLng {
    lat: number;
    lng: number;
}

/** Fallback country when a request omits one. ISO 3166-1 alpha-2. */
export const DEFAULT_COUNTRY = 'GR';

/**
 * Geocode a free-text location, restricted to a single country.
 *
 * The country goes into Google's `components=country:` filter rather than being
 * appended to the address string, which only *hints*: the geocoder drops the
 * tokens it can't reconcile and returns a plausible-looking place in the hinted
 * country. The filter genuinely restricts the result set.
 *
 * It does not, however, produce ZERO_RESULTS for an address outside the country
 * — the country itself satisfies the filter, so an unmatchable address comes
 * back `status: OK` with a country-level result at the country's centroid.
 * That is the one case we reject: real addresses resolve to `route`,
 * `street_address` or `locality`, so a `country`-typed result means the address
 * isn't in `country` at all, and a centroid pin is indistinguishable from a
 * real one downstream.
 */
export async function geocodeLocation(location: string, country: string = DEFAULT_COUNTRY): Promise<LatLng | null> {
    try {
        const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
            params: {
                address: location,
                components: `country:${country}`,
                key: process.env.GOOGLE_API_KEY
            }
        });

        if (response.data.status === 'OK' && response.data.results.length > 0) {
            const top = response.data.results[0];

            if (top.types?.includes('country')) {
                console.warn(`Geocode fell back to the country for "${location}" (country:${country}) — discarding`);
                return null;
            }

            const { lat, lng } = top.geometry.location;
            return { lat, lng };
        }

        return null;
    } catch (error) {
        console.error('Error geocoding location:', error);
        return null;
    }
}

/** The point that the geocoder gives for the name of a region alone, per `name|country`. */
const regionPoints = new Map<string, Promise<LatLng | null>>();

function regionPoint(regionName: string, country: string): Promise<LatLng | null> {
    const key = `${regionName}|${country}`;
    let point = regionPoints.get(key);
    if (!point) {
        point = geocodeLocation(regionName, country);
        regionPoints.set(key, point);
        // A failed lookup is not an answer: the next subject asks again.
        void point.then(found => { if (!found) regionPoints.delete(key); });
    }
    return point;
}

/**
 * Geocode a place of a region. The query is the place and then the name of the
 * region, as it is the place and then the name of the city for a municipality.
 *
 * When the geocoder cannot match the place, it can answer with the region
 * itself, as it answers with the country in `geocodeLocation`. That pin is the
 * centre of the region. It is inside the boundary of the region, so nothing
 * later can tell it from a real place. The answer for the name of the region
 * alone shows this fallback: a place that gets the same point gets no pin.
 */
export async function geocodeInRegion(place: string, regionName: string, country: string = DEFAULT_COUNTRY): Promise<LatLng | null> {
    const point = await geocodeLocation(`${place}, ${regionName}`, country);
    if (!point) return null;
    const fallback = await regionPoint(regionName, country);
    if (fallback && fallback.lat === point.lat && fallback.lng === point.lng) {
        console.warn(`Geocode fell back to the region for "${place}, ${regionName}" (country:${country}) — discarding`);
        return null;
    }
    return point;
}
