import { describe, it, expect } from 'vitest';
import path from 'path';
import * as fontkit from 'fontkit';
import { CHIP_FONT_FALLBACK, getBundledFontsDir } from './fonts.js';
import { CAPTION_PRESETS } from './presets.js';

describe('bundled fonts', () => {
    const fontsDir = getBundledFontsDir();

    const families = () => {
        const files = ['Inter-Black.ttf', 'Inter-Medium.ttf'];
        return files.map(f => fontkit.openSync(path.join(fontsDir, f)) as fontkit.Font);
    };

    // Full Greek gate: all uppercase/lowercase letters plus accented/diaeresis forms.
    // libass needs every one of these present or it silently falls back to a
    // fontconfig substitute, which is how the previous bundled fonts went unnoticed.
    const GREEK_GATE =
        'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψωςάέήίόύώΆΈΉΊΌΎΏϊϋΐΰ';

    it('every preset font family matches a bundled font internal name', () => {
        const names = families().map(f => f.familyName);
        for (const preset of Object.values(CAPTION_PRESETS)) {
            expect(names).toContain(preset.font.family);
        }
        expect(names).toContain(CHIP_FONT_FALLBACK); // chip font when the brand face is unavailable
    });

    it('bundled fonts cover Greek including accented lowercase', () => {
        for (const font of families()) {
            for (const ch of GREEK_GATE) {
                const cp = ch.codePointAt(0)!;
                expect(font.hasGlyphForCodePoint(cp)).toBe(true);
            }
        }
    });
});
