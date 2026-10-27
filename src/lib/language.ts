/**
 * Central registry for content-language-dependent behavior.
 *
 * `cityLanguage` (sent by the frontend on task requests) selects one of these
 * configs, which is the single home for every value that differs between
 * languages: the ASR language code, and the language-specific snippets injected
 * into otherwise-shared LLM prompts.
 *
 * Strategy: prompt bodies stay in their original language (Greek, or English for
 * fixTranscript). For non-Greek cities we keep that structural body and inject
 * `outputDirective` to force the output language; only genuinely
 * language-specific values (ASR code, default body name, fallback strings, the
 * fixTranscript correction examples) are swapped wholesale.
 */
import { CityLanguage } from "../types.js";

export const DEFAULT_LANGUAGE: CityLanguage = 'el';

export interface LanguageConfig {
    /** ISO-639-3 code sent to ElevenLabs Scribe (e.g. 'ell', 'fra'). */
    scribeCode: string;
    /** Human name of the language, used inline in prompt prose ("Greek", "French"). */
    promptName: string;
    /**
     * Directive appended to Greek-bodied LLM system prompts to force the output
     * language. Empty for Greek (the prompt body is already Greek); a strong
     * instruction for other languages.
     */
    outputDirective: string;
    /** Fallback administrative-body name when the request omits one. */
    defaultAdministrativeBodyName: string;
    /** Localized fallback shown when a speaker-contribution summary fails. */
    summaryErrorText: string;
    /**
     * Language-specific "WHAT TO FIX / WHAT NOT TO TOUCH" block for the
     * fixTranscript system prompt. The correction examples are inherently
     * orthography-specific, so this whole block is swapped per language.
     */
    fixTranscriptNotes: string;
}

const EL_FIX_TRANSCRIPT_NOTES = `WHAT TO FIX (in priority order):

1. NAMES — the most common error. The speech-to-text often misspells names phonetically (e.g. «Ρημάκης» for «Δημάκης», «Ξυδαροπούλου» for «Ξηνταροπούλου»). Before anything else, check every person, party, and place name against the roster and agenda provided. If a name in the text is phonetically close to a roster/agenda name, use the roster/agenda spelling. If it matches nothing, keep it as transcribed.

2. HOMOPHONE MISSPELLINGS — same sound, wrong letters: «απόν»→«απών», «πολεδομία»→«πολεοδομία», «κλιματολόγιο»→«κτηματολόγιο» (context: land registry), «ονομάδων»→«ονομάτων», ο/ω, η/ι/υ, αι/ε confusions. Use sentence meaning to pick the right word.

3. HOUSE STYLE for numbers and dates — the official record uses digits: «τριακοστή πέμπτη συνεδρίαση»→«35η συνεδρίαση», «πέντε Δεκεμβρίου του 2025»→«05/12/2025» for full dates, «άρθρο εβδομήντα πέντε»→«άρθρο 75». Money and percentages also as digits («2,5 εκατομμύρια ευρώ», «15%»).

4. Greek punctuation and accents: «;» for questions (never «?»), proper τόνοι («Μαρια;»→«Μαρία;»), capitalize proper nouns normally («ΖΕΜΕΝΟ»→«Ζεμενό»).

WHAT NOT TO TOUCH:

- Never change the meaning, add content, or summarize. You fix transcription, not the speaker.
- Do not fix factual errors, grammar the speaker actually produced, or colloquial word choices («γραφούν» stays «γραφούν», not «εγγραφούν»). Spoken Greek in the record stays spoken Greek, correctly spelled.
- Do not delete short interjections or crosstalk fragments from other speakers («ναι ναι», «το γράψατε;») — they are real speech; leave them where they are.
- If you are not confident a word is a transcription error, leave it unchanged. An unfixed error is recoverable; a wrong "fix" corrupts the official record.`;

const FR_FIX_TRANSCRIPT_NOTES = `WHAT TO FIX (in priority order):

1. NAMES — the most common error. The speech-to-text often misspells names phonetically. Before anything else, check every person, party, and place name against the roster and agenda provided. If a name in the text is phonetically close to a roster/agenda name, use the roster/agenda spelling. If it matches nothing, keep it as transcribed.

2. HOMOPHONE MISSPELLINGS — same sound, wrong letters; French has many: «a»/«à», «ou»/«où», «ces»/«ses»/«c'est», «et»/«est», «on»/«ont», «son»/«sont», «-er»/«-é»/«-ez» verb endings, «quel»/«quelle»/«qu'elle». Use sentence meaning to pick the right word.

3. HOUSE STYLE for numbers and dates — the official record uses digits: «trente-cinquième séance»→«35e séance», «cinq décembre deux mille vingt-cinq»→«05/12/2025» for full dates, «article soixante-quinze»→«article 75». Money and percentages also as digits («2,5 millions d'euros», «15 %»).

4. French punctuation and accents: restore accents (é/è/ê/à/ù/ç), use apostrophes for elision («l'ordre», «d'urbanisme», «qu'il»), French quotation marks « … » with non-breaking spaces, and a space before « ; : ? ! ». Capitalize proper nouns normally.

WHAT NOT TO TOUCH:

- Never change the meaning, add content, or summarize. You fix transcription, not the speaker.
- Do not fix factual errors, grammar the speaker actually produced, or colloquial word choices. Spoken French in the record stays spoken French, correctly spelled.
- Do not delete short interjections or crosstalk fragments from other speakers («oui oui», «vous l'avez noté ?») — they are real speech; leave them where they are.
- If you are not confident a word is a transcription error, leave it unchanged. An unfixed error is recoverable; a wrong "fix" corrupts the official record.`;

const SR_FIX_TRANSCRIPT_NOTES = `WHAT TO FIX (in priority order):

1. NAMES — the most common error. The speech-to-text often misspells names phonetically. Before anything else, check every person, party, and place name against the roster and agenda provided. If a name in the text is phonetically close to a roster/agenda name, use the roster/agenda spelling. If it matches nothing, keep it as transcribed.

2. PHONETIC MISSPELLINGS — Serbian spelling is phonemic, so most errors are near-homophone letter confusions: «ч»/«ћ» («кућа», not «куча»; «општина», not «опшћина»), «џ»/«ђ» («ђубре», not «џубре»), dropped or added «х» («хиљада», not «иљада»), and wrongly split or merged words. Use sentence meaning to pick the right word.

3. HOUSE STYLE for numbers and dates — the official record uses digits: «тридесет пета седница»→«35. седница», «пети децембар две хиљаде двадесет пете»→«05.12.2025.» for full dates, «члан седамдесет пет»→«члан 75». Money and percentages also as digits («2,5 милиона евра», «15%»).

4. Serbian punctuation and orthography: quotation marks „…“, a period after ordinals written as digits («35. седница»), capitalize proper nouns normally. Keep the script (Cyrillic or Latin) exactly as the transcript already uses it — never transliterate between scripts.

WHAT NOT TO TOUCH:

- Never change the meaning, add content, or summarize. You fix transcription, not the speaker.
- Do not fix factual errors, grammar the speaker actually produced, or colloquial word choices. Spoken Serbian in the record stays spoken Serbian, correctly spelled.
- Do not delete short interjections or crosstalk fragments from other speakers («да, да», «јесте ли то записали?») — they are real speech; leave them where they are.
- If you are not confident a word is a transcription error, leave it unchanged. An unfixed error is recoverable; a wrong "fix" corrupts the official record.`;

const FR_OUTPUT_DIRECTIVE = `**LANGUE DE SORTIE — RÉDIGE EN FRANÇAIS.** Tout le texte que tu génères (noms et descriptions des sujets, résumés, contributions, tout texte libre) DOIT être rédigé en français, même si les instructions ci-dessus sont en grec. Suis les conventions françaises : utilise « M./Mme » devant les noms de famille (jamais « κ./κα. »), les guillemets français « … » et la ponctuation française. Ne produis aucun texte en grec.`;

const SR_OUTPUT_DIRECTIVE = `**ЈЕЗИК ИЗЛАЗА — ПИШИ НА СРПСКОМ.** Сав текст који генеришеш (називи и описи тема, резимеи, доприноси говорника, сваки слободан текст) МОРА бити написан на српском језику, ћириличким писмом, чак и када су упутства изнад на грчком. Прати српске конвенције: користи „г./гђа“ испред презимена (никада „κ./κα.“), српске наводнике („…“) и српску интерпункцију. Немој писати ниједан текст на грчком.`;

// German, Dutch, Italian, Polish, Portuguese (European), Spanish and Finnish
// (the national languages of the realms added in 2026-10), and Catalan,
// Swedish and Galician (co-official where councils meet in them: Catalonia,
// the Balearic Islands, Åland and Finland's Swedish-majority municipalities,
// Galicia). Written from the French and Serbian blocks; a native speaker
// should review each one.
const notToTouch = (language: string, interjections: string) => `WHAT NOT TO TOUCH:

- Never change the meaning, add content, or summarize. You fix transcription, not the speaker.
- Do not fix factual errors, grammar the speaker actually produced, or colloquial word choices. Spoken ${language} in the record stays spoken ${language}, correctly spelled.
- Do not delete short interjections or crosstalk fragments from other speakers (${interjections}) — they are real speech; leave them where they are.
- If you are not confident a word is a transcription error, leave it unchanged. An unfixed error is recoverable; a wrong "fix" corrupts the official record.`;

const NAMES_RULE = `1. NAMES — the most common error. The speech-to-text often misspells names phonetically. Before anything else, check every person, party, and place name against the roster and agenda provided. If a name in the text is phonetically close to a roster/agenda name, use the roster/agenda spelling. If it matches nothing, keep it as transcribed.`;

const DE_FIX_TRANSCRIPT_NOTES = `WHAT TO FIX (in priority order):

${NAMES_RULE}

2. HOMOPHONE AND SPELLING ERRORS — «das»/«dass», «seid»/«seit», «wieder»/«wider», «Stadt»/«statt», «Rat»/«Rad»; capitalization of nouns and nominalized words («das Beschließen», «im Allgemeinen»); compounds written as one word («Gemeinderatssitzung», «Bebauungsplan»); umlauts and «ß» as the city's country writes them (Switzerland writes «ss»). Use sentence meaning to pick the right word.

3. HOUSE STYLE for numbers and dates — the official record uses digits: «fünfunddreißigste Sitzung»→«35. Sitzung», «fünfter Dezember zweitausendfünfundzwanzig»→«05.12.2025» for full dates, «Paragraf fünfundsiebzig»→«§ 75». Money and percentages also as digits («2,5 Millionen Euro», «15 %»).

4. German punctuation: German quotation marks „…“, a comma before subordinate clauses («…, dass», «…, weil», «…, die»), a period after ordinals written as digits («35. Sitzung»).

${notToTouch('German', '«ja, ja», «haben Sie das notiert?»')}`;

const NL_FIX_TRANSCRIPT_NOTES = `WHAT TO FIX (in priority order):

${NAMES_RULE}

2. HOMOPHONE AND SPELLING ERRORS — verb endings with d/t/dt («wordt»/«word», «gebeurt»/«gebeurd», «besteedt»/«besteed»), «ei»/«ij» («reizen»/«rijzen»), «au»/«ou», «hart»/«hard», «zei»/«zij»; compounds written as one word («gemeenteraadsvergadering», «bestemmingsplan»). Use sentence meaning to pick the right word.

3. HOUSE STYLE for numbers and dates — the official record uses digits: «vijfendertigste vergadering»→«35e vergadering», «vijf december tweeduizend vijfentwintig»→«05-12-2025» for full dates, «artikel vijfenzeventig»→«artikel 75». Money and percentages also as digits («2,5 miljoen euro», «15%»).

4. Dutch punctuation and spelling: diaeresis and accents where the word needs them («financiële», «één» for emphasis), apostrophes after a final long vowel in plurals and possessives («agenda's», «Anna's», but «Jans» without one), quotation marks “…”. Capitalize proper nouns normally.

${notToTouch('Dutch', '«ja ja», «heeft u dat genoteerd?»')}`;

const IT_FIX_TRANSCRIPT_NOTES = `WHAT TO FIX (in priority order):

${NAMES_RULE}

2. HOMOPHONE AND ACCENT ERRORS — Italian has many: «è»/«e», «là»/«la», «lì»/«li», «sì»/«si», «né»/«ne», «perché» (never «perchè»), «c'è»/«ce», «ho»/«o», «ha»/«a», «hanno»/«anno»; elision and apostrophes («un'altra», «l'ordine», but «qual è» and «un altro» without one); single and double consonants («delibera», «approvazione», «commissione»). Use sentence meaning to pick the right word.

3. HOUSE STYLE for numbers and dates — the official record uses digits: «trentacinquesima seduta»→«35ª seduta», «cinque dicembre duemilaventicinque»→«05/12/2025» for full dates, «articolo settantacinque»→«articolo 75». Money and percentages also as digits («2,5 milioni di euro», «15%»).

4. Italian punctuation and accents: the right accent («perché», «poiché» acute; «è», «così» grave), quotation marks «…», capitalize proper nouns normally.

${notToTouch('Italian', "«sì, sì», «l'avete messo a verbale?»")}`;

const PL_FIX_TRANSCRIPT_NOTES = `WHAT TO FIX (in priority order):

${NAMES_RULE}

2. HOMOPHONE AND SPELLING ERRORS — Polish spelling pairs that sound the same: «ó»/«u» («góra», «mówić»), «rz»/«ż» («rzeka», «może»), «ch»/«h» («chory», «herbata»); the diacritics ą, ę, ś, ć, ź, ż, ł, ń, ó (restore them, never drop them); «nie» written apart from verbs («nie wiem») and together with adjectives («niejasny») unless contrasted. Use sentence meaning to pick the right word.

3. HOUSE STYLE for numbers and dates — the official record uses digits; council sessions are numbered in Roman numerals: «trzydziesta piąta sesja»→«XXXV sesja», «piąty grudnia dwa tysiące dwudziestego piątego roku»→«05.12.2025 r.» for full dates, «artykuł siedemdziesiąty piąty»→«art. 75». Money and percentages also as digits («2,5 mln zł», «15%»).

4. Polish punctuation: quotation marks „…”, a comma before subordinate clauses («…, że», «…, który», «…, ponieważ»). Capitalize proper nouns normally.

${notToTouch('Polish', '«tak, tak», «zapisała to pani?»')}`;

const PT_FIX_TRANSCRIPT_NOTES = `WHAT TO FIX (in priority order):

${NAMES_RULE}

2. HOMOPHONE AND ACCENT ERRORS — «à»/«a»/«há», «é»/«e», «está»/«esta», «pôr»/«por», «têm»/«tem» (plural), «mas»/«mais», «concelho» (municipality)/«conselho» (council); European Portuguese spelling after the 1990 agreement («ação», «ótimo», «direção»), keeping the consonants that Portugal pronounces («facto», «contacto», «receção»); never the Brazilian forms («fato», «contato»). Use sentence meaning to pick the right word.

3. HOUSE STYLE for numbers and dates — the official record uses digits: «trigésima quinta sessão»→«35.ª sessão», «cinco de dezembro de dois mil e vinte e cinco»→«05/12/2025» for full dates, «artigo setenta e cinco»→«artigo 75.º». Money and percentages also as digits («2,5 milhões de euros», «15 %»).

4. Portuguese punctuation and accents: restore accents and the cedilla (á/à/â/ã/é/ê/í/ó/ô/õ/ú/ç), quotation marks «…», capitalize proper nouns normally.

${notToTouch('Portuguese', '«sim, sim», «ficou registado?»')}`;

const ES_FIX_TRANSCRIPT_NOTES = `WHAT TO FIX (in priority order):

${NAMES_RULE}

2. HOMOPHONE AND ACCENT ERRORS — diacritic accents: «más»/«mas», «sí»/«si», «él»/«el», «tú»/«tu», «sé»/«se», «qué»/«que» and «cómo»/«como» in questions; «b»/«v», silent «h» («hay»/«ahí»/«ay», «hecho»/«echo»), «ll»/«y» («halla»/«haya»). Use sentence meaning to pick the right word.

3. HOUSE STYLE for numbers and dates — the official record uses digits: «trigésima quinta sesión»→«35.ª sesión», «cinco de diciembre de dos mil veinticinco»→«05/12/2025» for full dates, «artículo setenta y cinco»→«artículo 75». Money and percentages also as digits («2,5 millones de euros», «15 %»).

4. Spanish punctuation and accents: opening and closing question and exclamation marks («¿…?», «¡…!»), restore accents and «ñ», quotation marks «…», capitalize proper nouns normally.

${notToTouch('Spanish', '«sí, sí», «¿lo ha anotado?»')}`;

const FI_FIX_TRANSCRIPT_NOTES = `WHAT TO FIX (in priority order):

${NAMES_RULE}

2. SPELLING ERRORS — Finnish spelling is phonemic, so most errors are vowel or consonant length («tuli»/«tulli», «kansa»/«kanssa», «tapaa»/«tapa»), «ä»/«a» and «ö»/«o» («säätiö», «päätös»), and compounds split in two («kaupunginvaltuusto», «asemakaava», never «kaupungin valtuusto»). Never change a case ending the speaker used. Use sentence meaning to pick the right word.

3. HOUSE STYLE for numbers and dates — the official record uses digits: «kolmaskymmenesviides kokous»→«35. kokous», «viides joulukuuta kaksituhattakaksikymmentäviisi»→«5.12.2025» for full dates, «pykälä seitsemänkymmentäviisi»→«75 §». Money and percentages also as digits («2,5 miljoonaa euroa», «15 %»).

4. Finnish punctuation: quotation marks ”…”, a period after ordinals written as digits («35. kokous»), a comma before subordinate clauses («…, että», «…, joka»). Capitalize proper nouns normally.

${notToTouch('Finnish', '«joo joo», «kirjasitteko sen?»')}`;

const DE_OUTPUT_DIRECTIVE = `**AUSGABESPRACHE — SCHREIBE AUF DEUTSCH.** Der gesamte Text, den du erzeugst (Namen und Beschreibungen der Themen, Zusammenfassungen, Redebeiträge, jeder freie Text), MUSS auf Deutsch verfasst sein, auch wenn die Anweisungen oben auf Griechisch sind. Folge den deutschen Konventionen: verwende «Herr/Frau» vor Nachnamen (niemals «κ./κα.»), deutsche Anführungszeichen „…“ und deutsche Zeichensetzung. Schreibe keinen griechischen Text.`;

const NL_OUTPUT_DIRECTIVE = `**UITVOERTAAL — SCHRIJF IN HET NEDERLANDS.** Alle tekst die je genereert (namen en beschrijvingen van onderwerpen, samenvattingen, bijdragen van sprekers, elke vrije tekst) MOET in het Nederlands zijn geschreven, ook al zijn de instructies hierboven in het Grieks. Volg de Nederlandse conventies: gebruik «de heer/mevrouw» of de functie («wethouder», «raadslid», «de voorzitter», in België «schepen») vóór de achternaam (nooit «κ./κα.»), aanhalingstekens “…” en Nederlandse interpunctie. Schrijf geen Griekse tekst.`;

const IT_OUTPUT_DIRECTIVE = `**LINGUA DI OUTPUT — SCRIVI IN ITALIANO.** Tutto il testo che generi (nomi e descrizioni degli argomenti, riassunti, interventi, qualsiasi testo libero) DEVE essere scritto in italiano, anche se le istruzioni qui sopra sono in greco. Segui le convenzioni italiane: usa «il consigliere/la consigliera» o «il sig./la sig.ra» davanti ai cognomi (mai «κ./κα.»), le virgolette «…» e la punteggiatura italiana. Non scrivere alcun testo in greco.`;

const PL_OUTPUT_DIRECTIVE = `**JĘZYK WYJŚCIOWY — PISZ PO POLSKU.** Cały generowany przez ciebie tekst (nazwy i opisy tematów, streszczenia, wystąpienia, każdy tekst swobodny) MUSI być napisany po polsku, nawet jeśli powyższe instrukcje są po grecku. Stosuj polskie konwencje: odnoś się do osób imieniem i nazwiskiem z funkcją («radny Jan Kowalski», «radna», «burmistrz», «przewodniczący rady»); formy «pan/pani» używaj tylko z funkcją lub pełnym imieniem i nazwiskiem (nigdy «κ./κα.»). Stosuj polskie cudzysłowy „…” i polską interpunkcję. Nie pisz żadnego tekstu po grecku.`;

const PT_OUTPUT_DIRECTIVE = `**LÍNGUA DE SAÍDA — ESCREVE EM PORTUGUÊS EUROPEU.** Todo o texto que gerares (nomes e descrições dos assuntos, resumos, intervenções, qualquer texto livre) TEM de ser escrito em português europeu, mesmo que as instruções acima estejam em grego. Segue as convenções portuguesas: usa o cargo com o nome («o Senhor Presidente da Câmara», «o vereador João Silva», «a deputada municipal Ana Costa»); não uses «Sr./Sr.ª» seguido só do apelido (nunca «κ./κα.»); as aspas «…» e a pontuação portuguesa. Não escrevas nenhum texto em grego.`;

const ES_OUTPUT_DIRECTIVE = `**IDIOMA DE SALIDA — ESCRIBE EN ESPAÑOL.** Todo el texto que generes (nombres y descripciones de los asuntos, resúmenes, intervenciones, cualquier texto libre) DEBE estar escrito en español, aunque las instrucciones anteriores estén en griego. Sigue las convenciones españolas: usa «el Sr./la Sra.» o el cargo («el concejal», «la concejala», «el alcalde») antes de los apellidos (nunca «κ./κα.»), las comillas «…» y la puntuación española, con «¿» y «¡» de apertura. No escribas ningún texto en griego.`;

const FI_OUTPUT_DIRECTIVE = `**TULOSTEEN KIELI — KIRJOITA SUOMEKSI.** Kaikki tuottamasi teksti (aiheiden nimet ja kuvaukset, tiivistelmät, puheenvuorot, kaikki vapaa teksti) ON kirjoitettava suomeksi, vaikka yllä olevat ohjeet ovat kreikaksi. Noudata suomalaisia käytäntöjä: viittaa henkilöihin koko nimellä tai tehtävänimikkeellä («valtuutettu», «puheenjohtaja», «kunnanjohtaja», «kaupunginjohtaja», «pormestari»), älä koskaan käytä «κ./κα.», käytä lainausmerkkejä ”…” ja noudata suomen välimerkkisääntöjä. Älä kirjoita mitään tekstiä kreikaksi.`;

const CA_FIX_TRANSCRIPT_NOTES = `WHAT TO FIX (in priority order):

${NAMES_RULE}

2. HOMOPHONE AND ACCENT ERRORS — diacritic accents: «més»/«mes», «sí»/«si», «són»/«son», «què»/«que», «té»/«te», «déu»/«deu», «és»/«es»; the geminated l («col·legi», «il·lustre»); apostrophes and contractions («l'Ajuntament», «d'acord», «al», «del», «pel»). Use sentence meaning to pick the right word.

3. HOUSE STYLE for numbers and dates — the official record uses digits: «trenta-cinquena sessió»→«35a sessió», «cinc de desembre de dos mil vint-i-cinc»→«05/12/2025» for full dates, «article setanta-cinc»→«article 75». Money and percentages also as digits («2,5 milions d'euros», «15 %»).

4. Catalan punctuation and accents: open and closed accents as the word needs them (à/è/é/í/ò/ó/ú), «ç», quotation marks «…», capitalize proper nouns normally. Valencian and Balearic forms («este», «eixe», «vosté»; «jo cant», the article «es/sa») are correct in those councils; do not change them to central Catalan. Never change a Spanish word that the speaker actually said («bueno», «vale»).

${notToTouch('Catalan', '«sí, sí», «ho ha anotat?»')}`;

const SV_FIX_TRANSCRIPT_NOTES = `WHAT TO FIX (in priority order):

${NAMES_RULE}

2. SPELLING ERRORS — «de»/«dem», «och»/«att», «sj»/«stj»/«skj» («sjuk», «stjärna», «skjuta»), «j»/«hj»/«lj»/«g» («hjälp», «ljus», «gärna»), «å»/«ä»/«ö» («område», «ärende», «förslag»), and compounds split in two («kommunfullmäktige», «detaljplan», never «kommun fullmäktige»). Finland-Swedish words and spellings are correct in a Finnish municipality; do not change them to Sweden-Swedish. Use sentence meaning to pick the right word.

3. HOUSE STYLE for numbers and dates — the official record uses digits: «trettiofemte sammanträdet»→«35:e sammanträdet», full dates as the city's country writes them («5.12.2025» in Finland, «2025-12-05» in Sweden), «paragraf sjuttiofem»→«75 §» in Finland and «§ 75» in Sweden. Money and percentages also as digits («2,5 miljoner euro», «15 %»).

4. Swedish punctuation: quotation marks ”…”, capitalize proper nouns normally, lower-case month and weekday names.

${notToTouch('Swedish', '«ja, ja», «har ni antecknat det?»')}`;

const GL_FIX_TRANSCRIPT_NOTES = `WHAT TO FIX (in priority order):

${NAMES_RULE}

2. HOMOPHONE AND ACCENT ERRORS — diacritic accents: «é»/«e», «á»/«a», «máis»/«mais», «nós»/«nos», «vós»/«vos», «dó»/«do», «cómpre»/«compre»; Galician spelling with «x» where Spanish has «j»/«g» («xunta», «xeral», «xestión»), «ll» where Spanish has «j» («traballo», «concello»), «nh» in «unha», «algunha». Never replace a Galician word with its Spanish form, and never change a Spanish word that the speaker actually said. Use sentence meaning to pick the right word.

3. HOUSE STYLE for numbers and dates — the official record uses digits: «trixésima quinta sesión»→«35.ª sesión», «cinco de decembro de dous mil vinte e cinco»→«05/12/2025» for full dates, «artigo setenta e cinco»→«artigo 75». Money and percentages also as digits («2,5 millóns de euros», «15 %»).

4. Galician punctuation: quotation marks «…», capitalize proper nouns normally. Question and exclamation marks may open with «¿» and «¡» as the source does; do not add or remove them.

${notToTouch('Galician', '«si, si», «quedou anotado?»')}`;

const CA_OUTPUT_DIRECTIVE = `**LLENGUA DE SORTIDA — ESCRIU EN CATALÀ.** Tot el text que generis (noms i descripcions dels assumptes, resums, intervencions, qualsevol text lliure) HA d'estar escrit en català, encara que les instruccions anteriors siguin en grec. Segueix les convencions catalanes: fes servir «el Sr./la Sra.» o el càrrec («el regidor», «la regidora», «l'alcalde») davant dels cognoms (mai «κ./κα.»), les cometes «…» i la puntuació catalana. No escriguis cap text en grec.`;

const SV_OUTPUT_DIRECTIVE = `**UTDATASPRÅK — SKRIV PÅ SVENSKA.** All text som du genererar (namn och beskrivningar av ärenden, sammanfattningar, inlägg, all fri text) SKA vara skriven på svenska, även om instruktionerna ovan är på grekiska. Följ svenska konventioner (finlandssvenska i en finländsk kommun): hänvisa till personer med fullständigt namn eller med uppdrag («ledamoten», «ordföranden», «kommundirektören») och aldrig med «κ./κα.», använd citattecknen ”…” och svensk interpunktion. Skriv ingen text på grekiska.`;

const GL_OUTPUT_DIRECTIVE = `**LINGUA DE SAÍDA — ESCRIBE EN GALEGO.** Todo o texto que xeres (nomes e descricións dos asuntos, resumos, intervencións, calquera texto libre) TEN que estar escrito en galego, aínda que as instrucións anteriores estean en grego. Segue as convencións galegas: usa «o Sr./a Sra.» ou o cargo («o concelleiro», «a concelleira», «o alcalde») diante dos apelidos (nunca «κ./κα.»), as comiñas «…» e a puntuación galega. Non escribas ningún texto en grego.`;

export const LANGUAGES: Record<CityLanguage, LanguageConfig> = {
    el: {
        scribeCode: 'ell',
        promptName: 'Greek',
        outputDirective: '',
        defaultAdministrativeBodyName: 'Δημοτικό Συμβούλιο',
        summaryErrorText: 'Σφάλμα κατά τη δημιουργία περίληψης.',
        fixTranscriptNotes: EL_FIX_TRANSCRIPT_NOTES,
    },
    fr: {
        scribeCode: 'fra',
        promptName: 'French',
        outputDirective: FR_OUTPUT_DIRECTIVE,
        defaultAdministrativeBodyName: 'Conseil Municipal',
        summaryErrorText: 'Erreur lors de la génération du résumé.',
        fixTranscriptNotes: FR_FIX_TRANSCRIPT_NOTES,
    },
    // Generated output uses Cyrillic — the official script for Serbian
    // government records. The transcript itself keeps whatever script the ASR
    // produced (see SR_FIX_TRANSCRIPT_NOTES).
    sr: {
        scribeCode: 'srp',
        promptName: 'Serbian',
        outputDirective: SR_OUTPUT_DIRECTIVE,
        defaultAdministrativeBodyName: 'Скупштина града',
        summaryErrorText: 'Грешка при генерисању резимеа.',
        fixTranscriptNotes: SR_FIX_TRANSCRIPT_NOTES,
    },
    de: {
        scribeCode: 'deu',
        promptName: 'German',
        outputDirective: DE_OUTPUT_DIRECTIVE,
        defaultAdministrativeBodyName: 'Gemeinderat',
        summaryErrorText: 'Fehler beim Erstellen der Zusammenfassung.',
        fixTranscriptNotes: DE_FIX_TRANSCRIPT_NOTES,
    },
    nl: {
        scribeCode: 'nld',
        promptName: 'Dutch',
        outputDirective: NL_OUTPUT_DIRECTIVE,
        defaultAdministrativeBodyName: 'Gemeenteraad',
        summaryErrorText: 'Fout bij het maken van de samenvatting.',
        fixTranscriptNotes: NL_FIX_TRANSCRIPT_NOTES,
    },
    it: {
        scribeCode: 'ita',
        promptName: 'Italian',
        outputDirective: IT_OUTPUT_DIRECTIVE,
        defaultAdministrativeBodyName: 'Consiglio comunale',
        summaryErrorText: 'Errore durante la generazione del riepilogo.',
        fixTranscriptNotes: IT_FIX_TRANSCRIPT_NOTES,
    },
    pl: {
        scribeCode: 'pol',
        promptName: 'Polish',
        outputDirective: PL_OUTPUT_DIRECTIVE,
        defaultAdministrativeBodyName: 'Rada Gminy',
        summaryErrorText: 'Błąd podczas generowania podsumowania.',
        fixTranscriptNotes: PL_FIX_TRANSCRIPT_NOTES,
    },
    pt: {
        scribeCode: 'por',
        promptName: 'Portuguese',
        outputDirective: PT_OUTPUT_DIRECTIVE,
        defaultAdministrativeBodyName: 'Assembleia Municipal',
        summaryErrorText: 'Erro ao gerar o resumo.',
        fixTranscriptNotes: PT_FIX_TRANSCRIPT_NOTES,
    },
    es: {
        scribeCode: 'spa',
        promptName: 'Spanish',
        outputDirective: ES_OUTPUT_DIRECTIVE,
        defaultAdministrativeBodyName: 'Pleno del Ayuntamiento',
        summaryErrorText: 'Error al generar el resumen.',
        fixTranscriptNotes: ES_FIX_TRANSCRIPT_NOTES,
    },
    fi: {
        scribeCode: 'fin',
        promptName: 'Finnish',
        outputDirective: FI_OUTPUT_DIRECTIVE,
        defaultAdministrativeBodyName: 'Valtuusto',
        summaryErrorText: 'Virhe yhteenvedon luomisessa.',
        fixTranscriptNotes: FI_FIX_TRANSCRIPT_NOTES,
    },
    ca: {
        scribeCode: 'cat',
        promptName: 'Catalan',
        outputDirective: CA_OUTPUT_DIRECTIVE,
        defaultAdministrativeBodyName: 'Ple de l\'Ajuntament',
        summaryErrorText: 'Error en generar el resum.',
        fixTranscriptNotes: CA_FIX_TRANSCRIPT_NOTES,
    },
    sv: {
        scribeCode: 'swe',
        promptName: 'Swedish',
        outputDirective: SV_OUTPUT_DIRECTIVE,
        defaultAdministrativeBodyName: 'Fullmäktige',
        summaryErrorText: 'Fel när sammanfattningen skapades.',
        fixTranscriptNotes: SV_FIX_TRANSCRIPT_NOTES,
    },
    gl: {
        scribeCode: 'glg',
        promptName: 'Galician',
        outputDirective: GL_OUTPUT_DIRECTIVE,
        defaultAdministrativeBodyName: 'Pleno do Concello',
        summaryErrorText: 'Erro ao xerar o resumo.',
        fixTranscriptNotes: GL_FIX_TRANSCRIPT_NOTES,
    },
};

/** Every supported content language, in registry order. */
export const CITY_LANGUAGES = Object.keys(LANGUAGES) as CityLanguage[];

export function isCityLanguage(value: string): value is CityLanguage {
    return Object.prototype.hasOwnProperty.call(LANGUAGES, value);
}

/**
 * The content language whose Scribe code is `code` ("ell" → "el"), or the code
 * itself when no registered language uses it (Scribe detected something else).
 */
export function cityLanguageForScribeCode(code: string): string {
    return CITY_LANGUAGES.find((language) => LANGUAGES[language].scribeCode === code) ?? code;
}

/**
 * Resolve a language's config, defaulting to Greek when the field is missing —
 * a defensive fallback for older clients that omit `cityLanguage`.
 */
export function getLanguageConfig(language: CityLanguage | undefined): LanguageConfig {
    return LANGUAGES[language ?? DEFAULT_LANGUAGE] ?? LANGUAGES[DEFAULT_LANGUAGE];
}

/**
 * The output-language directive formatted for appending to the end of a prompt:
 * a leading blank line plus the directive, or an empty string for the default
 * language (which needs no directive). Keeps the `\n\n` convention in one place.
 */
export function languageDirectiveSuffix(language: CityLanguage | undefined): string {
    const { outputDirective } = getLanguageConfig(language);
    return outputDirective ? `\n\n${outputDirective}` : '';
}
