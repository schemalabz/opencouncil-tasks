import { SubjectContext } from '../types.js';
import { aiChat } from './ai.js';

/**
 * Use Claude's web search capability to find relevant context about a subject
 * discussed in a council meeting.
 */
export async function getSubjectContextWithClaude(params: {
  subjectName: string;
  subjectDescription: string;
  cityName: string;
  administrativeBodyName: string;
  date: string;
}): Promise<SubjectContext> {
  try {
    const systemPrompt = `You are a helpful assistant that provides background context for Greek citizens reading about municipal council meeting topics.

Provide concise, factual EXTERNAL information IN GREEK that helps ordinary citizens understand the context. Focus on:
- What the subject is about (technical terms, regulations, policies)
- Why it's important or relevant
- Recent news or developments related to this topic
- Historical context if applicable

**IMPORTANT RESTRICTIONS:**
- Write ENTIRELY in Greek (Ελληνικά)
- Keep it SHORT: 2-3 paragraphs maximum (150-250 words)
- Do NOT include meta-commentary like "Θα ψάξω για..." or "Ας δούμε..."
- Do NOT discuss what was said IN THE MEETING - only provide EXTERNAL context
- Start DIRECTLY with the actual background information
- Write natural prose - citations will be added automatically by the system
- Do NOT manually add citation numbers like [1], [2], [3]
- Do NOT include a "Πηγές:" or "Sources:" section

**Example format:**
Το θέμα αφορά την εφαρμογή του νόμου 4555/2018 που ρυθμίζει τη λειτουργία των δημοτικών παιδικών σταθμών. Η νομοθεσία προβλέπει συγκεκριμένες προδιαγραφές για τον αριθμό προσωπικού και την υλικοτεχνική υποδομή. Οι πρόσφατες αλλαγές στην νομοθεσία στοχεύουν στη βελτίωση της ποιότητας των παρεχόμενων υπηρεσιών.`;

    const userPrompt = `Παράθεσε ΕΞΩΤΕΡΙΚΟ πλαίσιο για πολίτες που διαβάζουν για αυτό το θέμα που συζητήθηκε σε συνεδρίαση ${params.administrativeBodyName}.

**Θέμα:** ${params.subjectName}
**Περιγραφή:** ${params.subjectDescription}
**Πόλη:** ${params.cityName}
**Ημερομηνία:** ${params.date}

Παράθεσε ΣΥΝΤΟΜΗ περίληψη (2-3 παράγραφοι, 150-250 λέξεις MAX) με:
- Τεχνική/νομική πληροφόρηση
- Πρόσφατες εξελίξεις
- Γιατί είναι σημαντικό

ΜΗΝ αναφέρεις τι είπαν στη συνεδρίαση - μόνο εξωτερικό πλαίσιο.
Γράψε φυσικό κείμενο - οι πηγές θα προστεθούν αυτόματα από το σύστημα.
ΜΗΝ προσθέσεις χειροκίνητα αριθμούς αναφορών [1], [2], [3].
ΜΗΝ συμπεριλάβεις τμήμα "Πηγές:" ή "Sources:".

Ξεκίνα την απάντησή σου ΑΠΕΥΘΕΙΑΣ με το πλαίσιο - ΧΩΡΙΣ μετα-σχόλια.`;


    const result = await aiChat<string>({
      systemPrompt,
      userPrompt,
      parseJson: false,
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
      text: contextText.trim(),
      citationUrls
    };
  } catch (error) {
    console.error('Error getting subject context with Claude:', error);
    return {
      text: "",
      citationUrls: []
    };
  }
}
