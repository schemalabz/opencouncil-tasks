import { describe, it, expect } from 'vitest';
import { isAllowedSheetUrl } from './readAttendanceSheet.js';

describe('isAllowedSheetUrl', () => {
    it('accepts the bucket host under the configured endpoint, and the endpoint itself', () => {
        expect(isAllowedSheetUrl('https://opencouncil.fra1.digitaloceanspaces.com/attendance-sheets/c/m/x.webp?X-Amz-Signature=a', 'https://fra1.digitaloceanspaces.com')).toBe(true);
        expect(isAllowedSheetUrl('https://fra1.digitaloceanspaces.com/opencouncil/x.webp', 'fra1.digitaloceanspaces.com')).toBe(true);
    });

    it('with the bucket known, accepts only our bucket, virtual-hosted or path-style', () => {
        const endpoint = 'https://fra1.digitaloceanspaces.com';
        expect(isAllowedSheetUrl('https://opencouncil.fra1.digitaloceanspaces.com/attendance-sheets/x.webp', endpoint, undefined, 'opencouncil')).toBe(true);
        expect(isAllowedSheetUrl('https://fra1.digitaloceanspaces.com/opencouncil/attendance-sheets/x.webp', endpoint, undefined, 'opencouncil')).toBe(true);
        expect(isAllowedSheetUrl('https://someone-else.fra1.digitaloceanspaces.com/x.webp', endpoint, undefined, 'opencouncil')).toBe(false);
        expect(isAllowedSheetUrl('https://fra1.digitaloceanspaces.com/someone-else/x.webp', endpoint, undefined, 'opencouncil')).toBe(false);
    });

    it('refuses another host, a plain http URL and a URL that is not one', () => {
        expect(isAllowedSheetUrl('https://169.254.169.254/latest/meta-data', 'https://fra1.digitaloceanspaces.com')).toBe(false);
        expect(isAllowedSheetUrl('https://evil.example/fra1.digitaloceanspaces.com/x.webp', 'https://fra1.digitaloceanspaces.com')).toBe(false);
        expect(isAllowedSheetUrl('http://opencouncil.fra1.digitaloceanspaces.com/x.webp', 'https://fra1.digitaloceanspaces.com')).toBe(false);
        expect(isAllowedSheetUrl('not a url', 'https://fra1.digitaloceanspaces.com')).toBe(false);
    });

    it('accepts the dev proxy base of a MinIO setup, over http, and only objects under it', () => {
        const base = 'http://localhost:3000/dev/files/opencouncil-dev';
        expect(isAllowedSheetUrl('http://localhost:3000/dev/files/opencouncil-dev/attendance-sheets/c/m/x.webp', 'http://minio:9000', base)).toBe(true);
        expect(isAllowedSheetUrl('http://localhost:3000/dev/files/other-bucket/x.webp', 'http://minio:9000', base)).toBe(false);
        expect(isAllowedSheetUrl('http://localhost:3000/api/private', 'http://minio:9000', base)).toBe(false);
    });

    it('checks only the scheme when no endpoint is configured', () => {
        expect(isAllowedSheetUrl('https://anywhere.example/x.webp', undefined)).toBe(true);
        expect(isAllowedSheetUrl('http://anywhere.example/x.webp', undefined)).toBe(false);
    });
});
