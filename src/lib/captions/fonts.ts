import fs from 'fs';
import path from 'path';
import { getDataDir } from '../dataDir.js';

/**
 * Fonts for libass (`subtitles=...:fontsdir=`).
 *
 * Two sources feed one directory:
 *  - Inter, committed under assets/fonts, so a render can never depend on the
 *    network and can never silently fall back to a host font.
 *  - Relative Pro Book, the brand face the drawtext overlay used, fetched from
 *    our CDN at first use. It is proprietary (Colophon Foundry), so it is not
 *    committed to this public repository.
 *
 * Both are copied/cached into DATA_DIR/fonts, which is what gets handed to
 * libass — it takes a single directory.
 */

const CHIP_FONT_URL = process.env.CHIP_FONT_URL
    ?? 'https://townhalls-gr.fra1.cdn.digitaloceanspaces.com/fonts/relative-book-pro.ttf';
const CHIP_FONT_FILE = 'relative-book-pro.ttf';

/** Internal family name of the brand face, when it is available. */
export const CHIP_FONT_FAMILY = 'Relative Pro Book';
/** Family used when the brand face could not be fetched. */
export const CHIP_FONT_FALLBACK = 'Inter Medium';

/** Fonts committed to the repo. Asserted against the files in fonts.test.ts. */
export const BUNDLED_FONT_FAMILIES = ['Inter Black', 'Inter Medium'];
/** Families a preset may name: bundled, plus the brand face fetched at runtime. */
export const ALLOWED_FONT_FAMILIES = [...BUNDLED_FONT_FAMILIES, CHIP_FONT_FAMILY];

/** Committed fonts, resolved from cwd (server and CLI run from the repo root). */
export function getBundledFontsDir(): string {
    return path.resolve(process.cwd(), 'assets/fonts');
}

/** The directory handed to libass, holding both sources. */
export function getFontsDir(): string {
    return path.resolve(getDataDir(), 'fonts');
}

/**
 * Populate the fonts directory: copy the committed faces, then fetch the brand
 * face if it is not cached yet. Returns the family the speaker chip should name,
 * which falls back to a bundled face rather than letting libass substitute.
 */
export async function ensureFonts(): Promise<string> {
    const dir = getFontsDir();
    await fs.promises.mkdir(dir, { recursive: true });

    for (const file of await fs.promises.readdir(getBundledFontsDir())) {
        if (!file.endsWith('.ttf')) continue;
        const source = path.join(getBundledFontsDir(), file);
        const target = path.join(dir, file);
        // Size, not mere existence: the data volume outlives deploys, so a
        // replaced bundled font would otherwise stay stale there forever.
        const copied = fs.existsSync(target)
            && fs.statSync(target).size === fs.statSync(source).size;
        if (!copied) await fs.promises.copyFile(source, target);
    }

    const chipFont = path.join(dir, CHIP_FONT_FILE);
    if (fs.existsSync(chipFont)) {
        return CHIP_FONT_FAMILY;
    }
    try {
        const res = await fetch(CHIP_FONT_URL, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Written via a temp name so an interrupted fetch cannot leave a partial
        // font that libass would then fail to load.
        const tmp = `${chipFont}.${process.pid}.part`;
        await fs.promises.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
        await fs.promises.rename(tmp, chipFont);
        console.log(`🔤 fetched ${CHIP_FONT_FAMILY} for the speaker chip`);
        return CHIP_FONT_FAMILY;
    } catch (err) {
        console.warn(`⚠️ ${CHIP_FONT_FAMILY} unavailable (${err instanceof Error ? err.message : String(err)}); speaker chip falls back to ${CHIP_FONT_FALLBACK}`);
        return CHIP_FONT_FALLBACK;
    }
}
