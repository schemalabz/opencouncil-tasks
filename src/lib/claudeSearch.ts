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
- Use numbered citations [1], [2], [3] etc. inline in the text
- At the end, include a "Πηγές:" section with numbered references

**Example format:**
Το θέμα αφορά την εφαρμογή του νόμου 4555/2018 [1] που ρυθμίζει τη λειτουργία των δημοτικών παιδικών σταθμών. Η νομοθεσία προβλέπει συγκεκριμένες προδιαγραφές για τον αριθμό προσωπικού [2]...

**Πηγές:**
1. [Νόμος 4555/2018](https://example.gov.gr)
2. [Υπουργική Απόφαση 2019](https://example.gov.gr)
3. [Ανάλυση από ΤΕΕ](https://example.org)`;

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
Χρησιμοποίησε αριθμημένες αναφορές [1], [2], [3] στο κείμενο.
Τέλειωσε με "Πηγές:" και numbered list.

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
    let contextText = result.result;
    const citationUrls: string[] = [];

    // Extract citations if available
    if (result.response) {
      for (const block of result.response.content) {
        if (block.type === "text" && 'citations' in block && Array.isArray(block.citations)) {
          for (const citation of block.citations) {
            // web_search_result_location is not yet typed in SDK, use type assertion
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

    // If no citations were found in the response, try to extract URLs from markdown links
    if (citationUrls.length === 0) {
      const urlRegex = /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g;
      let match;
      while ((match = urlRegex.exec(contextText)) !== null) {
        const url = match[2];
        if (!citationUrls.includes(url)) {
          citationUrls.push(url);
        }
      }
    }

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
