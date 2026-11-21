/**
 * The kind of the authority that holds a meeting: a municipality, or a Greek
 * region (Περιφέρεια) with its regional council and committees
 * (schemalabz/opencouncil-tasks#124).
 *
 * opencouncil sends the kind on a request as `authorityType`. A request with no
 * `authorityType` is the request of a municipality.
 *
 * Every prompt that names the authority reads its words from this file, so the
 * wording of one kind is in one place. A prompt-specific sentence that differs
 * (the law articles of a meeting kind, an example) stays next to its prompt, in
 * a `Record<AuthorityType, …>` of its own.
 */
import type { AuthorityType } from '../types.js';

export type { AuthorityType };

export const DEFAULT_AUTHORITY_TYPE: AuthorityType = 'municipality';

/**
 * Read the `authorityType` of a request. A request with none is the request of
 * a municipality. Any other value that is not a kind is an error of the caller:
 * a prompt for the wrong kind of authority is worse than a refused request.
 */
export function parseAuthorityType(value: unknown): AuthorityType {
    if (value === undefined) return DEFAULT_AUTHORITY_TYPE;
    if (typeof value === 'string' && Object.hasOwn(AUTHORITY_TERMS, value)) return value as AuthorityType;
    throw new RangeError(`Unknown authority type: ${JSON.stringify(value)}. Expected one of: ${Object.keys(AUTHORITY_TERMS).join(', ')}`);
}

export function isRegion(authorityType: AuthorityType | undefined): boolean {
    return authorityType === 'region';
}

/** The words of one kind of authority. Greek prompts read `el`, English prompts read `en`. */
export interface AuthorityTerms {
    el: {
        /** The label of the line that gives the name of the authority: «Πόλη: Χαλάνδρι». */
        label: string;
        /** «της πόλης» + name. */
        ofTheAuthority: string;
        /** «του δήμου» + name, for the official website. */
        ofTheAuthorityBody: string;
        /** «όλο το δήμο»: a subject that has no place because it is about the whole authority. */
        wholeAuthority: string;
        /** «ολόκληρο το δήμο (π.χ. ο προϋπολογισμός του Δήμου)». */
        wholeAuthorityWithExample: string;
        /** «δημοτικών οργάνων». */
        bodiesGenitive: string;
        /** «δημοτικών συμβουλίων διαφόρων πόλεων». */
        councilsOfAuthoritiesGenitive: string;
        /** «ΔΗΜΟΤΙΚΟΥ ΣΥΜΒΟΥΛΙΟΥ». */
        councilGenitiveUpper: string;
        /** «ΔΗΜΟΤΙΚΗ ΕΠΙΤΡΟΠΗ». */
        committeeUpper: string;
        /** Examples of the bodies, for a sentence that starts with «π.χ.». */
        bodyExamples: string;
        /** «δήμαρχος». */
        head: string;
        /** «ΔΗΜΑΡΧΟΣ». */
        headUpper: string;
        /** «Δήμαρχος». */
        headTitle: string;
        /** «αντιδήμαρχος». */
        deputy: string;
        /** «Αντιδήμαρχος». */
        deputyTitle: string;
        /** «ΑΝΤΙΔΗΜΑΡΧΟΣ». */
        deputyUpper: string;
    };
    en: {
        /** The label of the line that gives the name of the authority: "City: Χαλάνδρι". */
        label: string;
        /** "municipality". */
        authority: string;
        /** "municipal", as in "a municipal council meeting". */
        adjective: string;
        /** The bodies that an authority of this kind has. */
        bodies: string;
        /** "κύριε Δήμαρχε": how the people at a meeting address the head. */
        headAddress: string;
        /** "the mayor or a deputy mayor". */
        headOrDeputy: string;
        /** "deputy mayors". */
        deputies: string;
    };
}

const AUTHORITY_TERMS: Record<AuthorityType, AuthorityTerms> = {
    municipality: {
        el: {
            label: 'Πόλη',
            ofTheAuthority: 'της πόλης',
            ofTheAuthorityBody: 'του δήμου',
            wholeAuthority: 'όλο το δήμο',
            wholeAuthorityWithExample: 'ολόκληρο το δήμο (π.χ. ο προϋπολογισμός του Δήμου)',
            bodiesGenitive: 'δημοτικών οργάνων',
            councilsOfAuthoritiesGenitive: 'δημοτικών συμβουλίων διαφόρων πόλεων',
            councilGenitiveUpper: 'ΔΗΜΟΤΙΚΟΥ ΣΥΜΒΟΥΛΙΟΥ',
            committeeUpper: 'ΔΗΜΟΤΙΚΗ ΕΠΙΤΡΟΠΗ',
            bodyExamples: 'δημοτικά συμβούλια, δημοτικές επιτροπές, δημοτικές κοινότητες',
            head: 'δήμαρχος',
            headUpper: 'ΔΗΜΑΡΧΟΣ',
            headTitle: 'Δήμαρχος',
            deputy: 'αντιδήμαρχος',
            deputyTitle: 'Αντιδήμαρχος',
            deputyUpper: 'ΑΝΤΙΔΗΜΑΡΧΟΣ',
        },
        en: {
            label: 'City',
            authority: 'municipality',
            adjective: 'municipal',
            bodies: 'the council, committees, community councils',
            headAddress: '"κύριε Δήμαρχε"',
            headOrDeputy: 'the mayor or a deputy mayor',
            deputies: 'deputy mayors',
        },
    },
    region: {
        el: {
            label: 'Περιφέρεια',
            ofTheAuthority: 'της περιφέρειας',
            ofTheAuthorityBody: 'της περιφέρειας',
            wholeAuthority: 'όλη την περιφέρεια',
            wholeAuthorityWithExample: 'ολόκληρη την περιφέρεια (π.χ. ο προϋπολογισμός της Περιφέρειας)',
            bodiesGenitive: 'περιφερειακών οργάνων',
            councilsOfAuthoritiesGenitive: 'περιφερειακών συμβουλίων διαφόρων περιφερειών',
            councilGenitiveUpper: 'ΠΕΡΙΦΕΡΕΙΑΚΟΥ ΣΥΜΒΟΥΛΙΟΥ',
            committeeUpper: 'ΠΕΡΙΦΕΡΕΙΑΚΗ ΕΠΙΤΡΟΠΗ',
            bodyExamples: 'περιφερειακά συμβούλια, περιφερειακές επιτροπές',
            head: 'περιφερειάρχης',
            headUpper: 'ΠΕΡΙΦΕΡΕΙΑΡΧΗΣ',
            headTitle: 'Περιφερειάρχης',
            deputy: 'αντιπεριφερειάρχης',
            deputyTitle: 'Αντιπεριφερειάρχης',
            deputyUpper: 'ΑΝΤΙΠΕΡΙΦΕΡΕΙΑΡΧΗΣ',
        },
        en: {
            label: 'Region',
            authority: 'region',
            adjective: 'regional',
            bodies: 'the regional council and its committees',
            headAddress: '"κύριε Περιφερειάρχα" or "κύριε Περιφερειάρχη"',
            headOrDeputy: 'the regional governor (Περιφερειάρχης) or a deputy regional governor (Αντιπεριφερειάρχης)',
            deputies: 'deputy regional governors',
        },
    },
};

export function authorityTerms(authorityType: AuthorityType = DEFAULT_AUTHORITY_TYPE): AuthorityTerms {
    return AUTHORITY_TERMS[authorityType];
}

/**
 * How a prompt asks for the place of a subject. The pipeline geocodes the place
 * with the name of the authority after it. For a municipality that is enough.
 * A region has many towns, and several of them have a street or a square with
 * the same name, so the model must write the town too. A place of a region with
 * no town gets no pin: the geocoder would put it in any town of the region that
 * has the name, and the boundary check of opencouncil cannot see that error.
 *
 * `examples` are the example lines of the transcript prompt. The examples of a
 * region show the town, as its rule asks.
 */
const LOCATION_TEXT_RULE: Record<AuthorityType, { examples: string; spoken: string; written: string }> = {
    municipality: {
        examples: `- Διεύθυνση: «Λεωφόρος Μεσογείων 45», «Rue de la République 12»
- Γειτονιά: «Εξάρχεια», «Novi Beograd»
- Επώνυμος δημόσιος χώρος: «Πλατεία Συντάγματος», «Trg republike»`,
        spoken: 'Γράψε ΜΟΝΟ το τοπωνύμιο, όπως ακριβώς ειπώθηκε. ΜΗΝ προσθέτεις πόλη, περιοχή ή χώρα — μπαίνουν αυτόματα αργότερα',
        written: 'Γράψε ΜΟΝΟ το τοπωνύμιο· ΜΗΝ προσθέτεις πόλη, περιοχή ή χώρα — μπαίνουν αυτόματα αργότερα.',
    },
    region: {
        examples: `- Διεύθυνση: «Οδός Κύπρου 12, Λάρισα»
- Γειτονιά: «Νεάπολη, Λάρισα»
- Επώνυμος δημόσιος χώρος: «Πλατεία Ρήγα Φεραίου, Βόλος»
- Πόλη ή οικισμός: «Καλαμπάκα»`,
        spoken: 'Γράψε το τοπωνύμιο όπως ακριβώς ειπώθηκε και, μετά από κόμμα, την πόλη ή τον οικισμό της περιφέρειας όπου βρίσκεται: «Πλατεία Ηρώων, Τρίκαλα», «Οδός Κύπρου 12, Λάρισα». Πολλές πόλεις της ίδιας περιφέρειας έχουν δρόμο ή πλατεία με το ίδιο όνομα, και χωρίς την πόλη το σημείο μπαίνει σε λάθος τόπο. Αν η πόλη δεν ειπώθηκε και δεν προκύπτει καθαρά από τη συζήτηση, βάλε null: ένα τοπωνύμιο χωρίς πόλη δεν δίνει σωστό σημείο σε μια περιφέρεια. Όταν ο τόπος είναι ο ίδιος μια πόλη ή ένας οικισμός, γράψε μόνο το όνομά του. ΜΗΝ προσθέτεις το όνομα της περιφέρειας ή τη χώρα — μπαίνουν αυτόματα αργότερα',
        written: 'Γράψε το τοπωνύμιο και, μετά από κόμμα, την πόλη ή τον οικισμό της περιφέρειας όπου βρίσκεται: «Πλατεία Ηρώων, Τρίκαλα», «Οδός Κύπρου 12, Λάρισα». Πολλές πόλεις της ίδιας περιφέρειας έχουν δρόμο ή πλατεία με το ίδιο όνομα, και χωρίς την πόλη το σημείο μπαίνει σε λάθος τόπο. Αν το έγγραφο δεν γράφει την πόλη και αυτή δεν προκύπτει καθαρά από το θέμα, βάλε null: ένα τοπωνύμιο χωρίς πόλη δεν δίνει σωστό σημείο σε μια περιφέρεια. Όταν ο τόπος είναι ο ίδιος μια πόλη ή ένας οικισμός, γράψε μόνο το όνομά του. ΜΗΝ προσθέτεις το όνομα της περιφέρειας ή τη χώρα — μπαίνουν αυτόματα αργότερα.',
    },
};

/** The place rule of a transcript prompt (`examples` and `spoken`) or of an agenda prompt (`written`). */
export function locationTextRule(authorityType: AuthorityType = DEFAULT_AUTHORITY_TYPE): { examples: string; spoken: string; written: string } {
    return LOCATION_TEXT_RULE[authorityType];
}
