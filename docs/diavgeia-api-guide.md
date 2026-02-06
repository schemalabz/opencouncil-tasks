# Diavgeia API Guide

Reference documentation for integrating with the Greek Government Transparency Portal (Diavgeia).

## API Basics

**Base URL:** `https://diavgeia.gov.gr/opendata`

**Authentication:** None required (public API)

**Response Format:** JSON

**Official Documentation:** https://diavgeia.gov.gr/api/help

## Key Concepts

### ADA (Αριθμός Διαδικτυακής Ανάρτησης)
Unique decision identifier assigned when published to Diavgeia. Format uses Greek uppercase letters and numbers (e.g., `ΨΘ82ΩΡΦ-7ΑΙ`, `624ΙΩΡΦ-ΥΕΨ`).

### Organization vs Unit
- **Organization (org):** The municipality or government body (e.g., `6104` for Δήμος Ζωγράφου)
- **Unit:** A department within the organization (e.g., `81689` for ΔΗΜΟΤΙΚΟ ΣΥΜΒΟΥΛΙΟ)

Unit filtering is critical for getting relevant results (see Filtering Strategy below).

### Protocol Number
Internal reference number assigned at meetings. Format: `N/YYYY` (e.g., `258/2024`). Numbers are sequential within each unit and reset annually.

## Endpoints

### Search Decisions
```
GET /search?org={orgId}&from_issue_date={YYYY-MM-DD}&to_issue_date={YYYY-MM-DD}&status=PUBLISHED
```

**Parameters:**
| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| `org` | Yes | Organization UID | `6104` |
| `from_issue_date` | Yes | Start date (ISO) | `2024-12-01` |
| `to_issue_date` | Yes | End date (ISO) | `2024-12-31` |
| `status` | Yes | Decision status | `PUBLISHED` |
| `unit` | No | Filter by unit UID | `81689` |
| `type` | No | Filter by decision type | `Β.1.1` |
| `q` | No | Keyword search (subject) | `προϋπολογισμού` |
| `page` | No | Page number (0-indexed) | `0` |
| `size` | No | Results per page (max 500) | `100` |

### Get Single Decision
```
GET /decisions/{ADA}
```
Example: `/decisions/ΨΧ2ΤΩΗ5-ΣΩ5`

### Get Decision Types
```
GET /types
```
Returns the full taxonomy of decision types (hierarchical).

### Get Organization Units
```
GET /organizations/{orgId}/units
```
Returns XML with all units for an organization. Parse to find unit IDs.

## Response Structure

### Search Response
```json
{
  "info": {
    "total": 132,
    "page": 0,
    "size": 100,
    "actualSize": 100
  },
  "decisions": [...]
}
```

### Decision Object
```json
{
  "ada": "6ΜΟΜΩΡΦ-56Δ",
  "subject": "ΕΓΚΡΙΣΗ ΠΡΟΫΠΟΛΟΓΙΣΜΟΥ...",
  "protocolNumber": "258/2024",
  "issueDate": 1734566400000,
  "organizationId": "6104",
  "unitIds": ["81689"],
  "decisionTypeId": "Β.1.1",
  "thematicCategoryIds": ["16"],
  "documentUrl": "https://diavgeia.gov.gr/doc/6ΜΟΜΩΡΦ-56Δ",
  "url": "https://diavgeia.gov.gr/luminapi/api/decisions/6ΜΟΜΩΡΦ-56Δ",
  "status": "PUBLISHED"
}
```

**Field Notes:**
| Field | Type | Notes |
|-------|------|-------|
| `ada` | string | Unique identifier, used in URLs |
| `subject` | string | Decision title (Greek text) |
| `protocolNumber` | string | Format varies: `N/YYYY`, `Α/1522`, `38586` |
| `issueDate` | number | **Milliseconds timestamp** (not ISO string!) |
| `documentUrl` | string | Direct link to PDF document |
| `unitIds` | string[] | May contain multiple units |

## Municipal Units

For council meeting decisions, filter by these unit types:

| Unit Type | Greek Name | Category | Description |
|-----------|------------|----------|-------------|
| Municipal Council | ΔΗΜΟΤΙΚΟ ΣΥΜΒΟΥΛΙΟ | `ORG_UNIT_OTHER` | Main council decisions |
| Municipal Committee | ΔΗΜΟΤΙΚΗ ΕΠΙΤΡΟΠΗ | `ORG_UNIT_OTHER` | Executive committee (post-2024 reform) |
| Economic Committee | ΟΙΚΟΝΟΜΙΚΗ ΕΠΙΤΡΟΠΗ | `ORG_UNIT_OTHER` | Financial/budget matters |
| Quality of Life Committee | ΕΠΙΤΡΟΠΗ ΠΟΙΟΤΗΤΑΣ ΖΩΗΣ | `ORG_UNIT_OTHER` | Urban planning, environment |

### Example: Δήμος Ζωγράφου (org: 6104)

| UID | Label |
|-----|-------|
| `81689` | ΔΗΜΟΤΙΚΟ ΣΥΜΒΟΥΛΙΟ |
| `100084744` | ΔΗΜΟΤΙΚΗ ΕΠΙΤΡΟΠΗ |
| `81705` | ΟΙΚΟΝΟΜΙΚΗ ΕΠΙΤΡΟΠΗ |
| `81708` | ΕΠΙΤΡΟΠΗ ΠΟΙΟΤΗΤΑΣ ΖΩΗΣ |
| `100033074` | ΔΗΜΑΡΧΟΣ |

**Note:** Unit IDs are organization-specific. Each municipality has different UIDs for the same unit types. Always query `/organizations/{orgId}/units` to discover them.

## Decision Types Taxonomy

Hierarchical structure with parent categories containing child types.

### Relevant for Council Decisions

| UID | Label | Description |
|-----|-------|-------------|
| `2.4.7.1` | ΛΟΙΠΕΣ ΑΤΟΜΙΚΕΣ ΔΙΟΙΚΗΤΙΚΕΣ ΠΡΑΞΕΙΣ | **Most common for council decisions** |
| `Α.2` | ΚΑΝΟΝΙΣΤΙΚΗ ΠΡΑΞΗ | Regulatory acts |
| `Β.1.1` | ΕΓΚΡΙΣΗ ΠΡΟΥΠΟΛΟΓΙΣΜΟΥ | Budget approval |
| `Γ.2` | ΠΡΑΞΗ ΣΥΛΛΟΓΙΚΟΥ ΟΡΓΑΝΟΥ | Collective body acts (committees) |

### Administrative (High Volume, Usually Not Relevant)

| UID | Label | Description |
|-----|-------|-------------|
| `Β.2.2` | ΟΡΙΣΤΙΚΟΠΟΙΗΣΗ ΠΛΗΡΩΜΗΣ | Payment finalization (bulk of all decisions) |
| `Β.1.3` | ΑΝΑΛΗΨΗ ΥΠΟΧΡΕΩΣΗΣ | Budget commitment |
| `Δ.1` | ΑΝΑΘΕΣΗ ΕΡΓΩΝ/ΠΡΟΜΗΘΕΙΩΝ | Contract awards |
| `Δ.2.1` | ΠΕΡΙΛΗΨΗ ΔΙΑΚΗΡΥΞΗΣ | Tender announcements |

## Filtering Strategy

**Best approach:** Filter by unit, not by decision type.

### Why Unit Filtering Works Better

| Filter | Dec 2024 Results (Ζωγράφου) | Notes |
|--------|------------------------------|-------|
| No filter | 819 | Includes all administrative acts |
| `type=Β.1.1` | 1 | Too restrictive (only budget approval) |
| `type=2.4.7.1` | 79 | Still includes non-council decisions |
| `unit=81689` | 25 | **Exact match for council decisions** |

### Recommended Query for Council Decisions
```
/search?org=6104&unit=81689&from_issue_date=2024-12-01&to_issue_date=2024-12-31&status=PUBLISHED
```

## Pagination

For complete results, iterate until all pages fetched:

```typescript
let page = 0;
const pageSize = 100;
const allDecisions = [];

while (true) {
  const response = await fetch(
    `${baseUrl}/search?org=${orgId}&...&page=${page}&size=${pageSize}`
  );
  const data = await response.json();

  allDecisions.push(...data.decisions);

  const totalPages = Math.ceil(data.info.total / pageSize);
  if (page >= totalPages - 1) break;
  page++;
}
```

## Publication Timing

Decisions are published to Diavgeia **after** the meeting, not before. Typical delays:

- Same week: Common for routine decisions
- 1-2 weeks: Normal for most council decisions
- Up to 45 days: Occasionally for complex or delayed items

When polling for decisions, search from meeting date to meeting date + 45 days.

## Common Gotchas

1. **`issueDate` is milliseconds**, not ISO string
   ```typescript
   // Convert to ISO date
   const isoDate = new Date(decision.issueDate).toISOString().split('T')[0];
   ```

2. **Unit IDs vary per organization** - always query `/organizations/{orgId}/units` first for a new municipality

3. **Decision type `2.4.7.1`** is a catch-all used for most council decisions, but also includes non-council items

4. **The `q` parameter** searches broadly - may match partial words (e.g., "Δημοτικό" matches "Δημοτικού Κολυμβητήριου")

5. **Protocol numbers are not globally unique** - different units have separate numbering sequences

6. **Greek text normalization** - when matching subjects, account for:
   - Word inflection (different endings for same word)
   - Quote styles: `«»` (Greek) vs `""` (standard)
   - Punctuation variations

7. **Empty subjects** - some administrative decisions have minimal or formulaic subjects

## Client Implementation

See `src/lib/DiavgeiaClient.ts` for our implementation with:
- Automatic pagination
- Unit filtering
- Date normalization
- TypeScript interfaces

## Related Documentation

- **Task implementation:** `docs/pollDecisions.md` - How the pollDecisions task uses this API
- **Official API docs:** https://diavgeia.gov.gr/api/help
