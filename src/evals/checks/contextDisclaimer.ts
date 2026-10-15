import { callCheck, fail, foldGreek, pass } from './check.js';

// Matched against foldGreek(text), hence no accents and σ for ς. From #75's production query.
const DISCLAIMER = /^\s*(δυστυχωσ|λυπαμαι|δεν (βρεθηκαν|μπορεσα|υπαρχουν|εντοπισα)|με βαση τ(α αποτελεσματα|ισ αναζητησεισ)|βλεπω οτι|θα ψαξω|ασ ψαξω)/;

export default callCheck('context_disclaimer_preamble', ['subject-context-search*'], call => {
    const text = call.response.text.normalize('NFC');
    const match = DISCLAIMER.exec(foldGreek(text));
    return match ? fail(text.trimStart().slice(0, 120)) : pass();
});
