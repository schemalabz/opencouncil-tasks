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
 * appended to the address string. The filter *restricts* results, so a location
 * that isn't in the country comes back as ZERO_RESULTS; appending the country
 * name only *hints*, and the geocoder happily drops the tokens it can't
 * reconcile and returns a plausible-looking place in the hinted country instead.
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
            const { lat, lng } = response.data.results[0].geometry.location;
            return { lat, lng };
        }

        return null;
    } catch (error) {
        console.error('Error geocoding location:', error);
        return null;
    }
}
