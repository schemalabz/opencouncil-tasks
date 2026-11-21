import { AuthorityType, CityLanguage, SubjectContext } from '../types.js';
import { DEFAULT_AUTHORITY_TYPE, authorityTerms } from './authority.js';
import { aiChat, ResultWithUsage, NO_USAGE } from './ai.js';
import { getLanguageConfig, languageDirectiveSuffix } from './language.js';

export interface SubjectContextParams {
  subjectName: string;
  subjectDescription: string;
  cityName: string;
  cityLanguage?: CityLanguage;
  administrativeBodyName: string;
  date: string;
  /** The kind of the authority. Params with none are a municipality's. */
  authorityType?: AuthorityType;
}

/**
 * The example of the output format. It is about a service of the authority, so
 * each kind of authority gets its own: the model can copy the example's words.
 */
const CONTEXT_EXAMPLE: Record<AuthorityType, string> = {
  municipality: 'Το θέμα αφορά την εφαρμογή του νόμου 4555/2018 που ρυθμίζει τη λειτουργία των δημοτικών παιδικών σταθμών. Η νομοθεσία προβλέπει συγκεκριμένες προδιαγραφές για τον αριθμό προσωπικού και την υλικοτεχνική υποδομή. Οι πρόσφατες αλλαγές στην νομοθεσία στοχεύουν στη βελτίωση της ποιότητας των παρεχόμενων υπηρεσιών.',
  region: 'Το θέμα αφορά την εφαρμογή του νόμου 4412/2016 που ρυθμίζει τις δημόσιες συμβάσεις έργων, προμηθειών και υπηρεσιών. Η νομοθεσία προβλέπει συγκεκριμένες διαδικασίες ανάθεσης και όρια ποσών για κάθε διαδικασία. Οι πρόσφατες αλλαγές στη νομοθεσία στοχεύουν στην επιτάχυνση των διαγωνισμών.',
};

/** The two prompts of the context search, apart from the call so that a test can read them. */
export function buildSubjectContextPrompts(params: SubjectContextParams): { systemPrompt: string; userPrompt: string } {
  const { promptName } = getLanguageConfig(params.cityLanguage);
  const langDirective = languageDirectiveSuffix(params.cityLanguage);
  const authorityType = params.authorityType ?? DEFAULT_AUTHORITY_TYPE;
  const authority = authorityTerms(authorityType);
  const systemPrompt = `You are a helpful assistant that provides background context for citizens reading about ${authority.en.adjective} council meeting topics.

Provide concise, factual EXTERNAL information IN ${promptName.toUpperCase()} that helps ordinary citizens understand the context. Focus on:
- What the subject is about (technical terms, regulations, policies)
- Why it's important or relevant
- Recent news or developments related to this topic
- Historical context if applicable

**IMPORTANT RESTRICTIONS:**
- Write ENTIRELY in ${promptName}
- Keep it SHORT: 2-3 paragraphs maximum (150-250 words)
- Do NOT include meta-commentary like "Θα ψάξω για..." or "Ας δούμε..."
- Do NOT discuss what was said IN THE MEETING - only provide EXTERNAL context
- Start DIRECTLY with the actual background information
- Write natural prose - citations will be added automatically by the system
- Do NOT manually add citation numbers like [1], [2], [3]
- Do NOT include a "Πηγές:" or "Sources:" section

**Example format:**
${CONTEXT_EXAMPLE[authorityType]}${langDirective}`;

  const userPrompt = `Παράθεσε ΕΞΩΤΕΡΙΚΟ πλαίσιο για πολίτες που διαβάζουν για αυτό το θέμα που συζητήθηκε σε συνεδρίαση ${params.administrativeBodyName}.

**Θέμα:** ${params.subjectName}
**Περιγραφή:** ${params.subjectDescription}
**${authority.el.label}:** ${params.cityName}
**Ημερομηνία:** ${params.date}

Παράθεσε ΣΥΝΤΟΜΗ περίληψη (2-3 παράγραφοι, 150-250 λέξεις MAX) με:
- Τεχνική/νομική πληροφόρηση
- Πρόσφατες εξελίξεις
- Γιατί είναι σημαντικό

Αν υπάρχει σχετικό υλικό στο επίσημο site ${authority.el.ofTheAuthorityBody} ${params.cityName}, προτίμησέ το.

ΜΗΝ αναφέρεις τι είπαν στη συνεδρίαση - μόνο εξωτερικό πλαίσιο.
Γράψε φυσικό κείμενο - οι πηγές θα προστεθούν αυτόματα από το σύστημα.
ΜΗΝ προσθέσεις χειροκίνητα αριθμούς αναφορών [1], [2], [3].
ΜΗΝ συμπεριλάβεις τμήμα "Πηγές:" ή "Sources:".

Ξεκίνα την απάντησή σου ΑΠΕΥΘΕΙΑΣ με το πλαίσιο - ΧΩΡΙΣ μετα-σχόλια.${langDirective}`;

  return { systemPrompt, userPrompt };
}

/**
 * Use Claude's web search capability to find relevant context about a subject
 * discussed in a council meeting.
 */
export async function getSubjectContextWithClaude(params: SubjectContextParams): Promise<ResultWithUsage<SubjectContext>> {
  try {
    const { systemPrompt, userPrompt } = buildSubjectContextPrompts(params);

    const result = await aiChat<string>({
      systemPrompt,
      userPrompt,
      parseJson: false,
      label: `subject-context-search:${params.subjectName.slice(0, 40)}`,
      tools: [{
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 3
      }] as any // web_search_20250305 is not yet fully typed in SDK
    });

    // Extract text and citations from response
    // Web search responses have multiple text blocks with citations on individual blocks
    let contextText = '';
    const citationUrls: string[] = [];

    if (result.response) {
      for (const block of result.response.content) {
        // Concatenate all text blocks to build the full response
        if (block.type === "text") {
          contextText += (block as any).text || '';

          // Extract citations from this text block
          if ('citations' in block && Array.isArray(block.citations)) {
            for (const citation of block.citations) {
              // web_search_result_location citations include the URL
              if ((citation as any).type === "web_search_result_location" && (citation as any).url) {
                const url = (citation as any).url;
                if (!citationUrls.includes(url)) {
                  citationUrls.push(url);
                }
              }
            }
          }
        }
      }
    }

    // Fallback: if response structure wasn't as expected, use the result string
    if (!contextText) {
      contextText = result.result;
    }

    // Clean up any remaining "Πηγές:" sections that might have been added
    contextText = contextText.replace(/\*\*Πηγές:\*\*[\s\S]*$/i, '');
    contextText = contextText.replace(/Πηγές:[\s\S]*$/i, '');

    return {
      result: {
        text: contextText.trim(),
        citationUrls
      },
      usage: result.usage,
      response: result.response,
      resolvedModel: result.resolvedModel,
      batchMode: result.batchMode
    };
  } catch (error) {
    console.error('Error getting subject context with Claude:', error);
    return {
      result: {
        text: "",
        citationUrls: []
      },
      usage: NO_USAGE,
      response: undefined
    };
  }
}
