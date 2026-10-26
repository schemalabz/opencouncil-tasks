"""Live-sync matrix for PGSync: for every indexed field and every table that feeds it,
change the source in PostgreSQL and record whether the search document follows.

Run through scripts/pgsync-matrix.sh, which guards the targets, bootstraps a test index
and starts the daemon. This script writes probe rows and changes names, release flags and
roles: point it only at a disposable seeded database.

Outcomes: `live` (the document followed, with the delay), `not live` (it did not within
the wait), `invalid` (the expectation held before the change, so the probe proves
nothing: fix the probe), `error` (the probe could not run), `n/a` (no data for it)."""
import base64, json, os, subprocess, sys, time, urllib.request

PG = os.environ["PSQL_URL"]
U = os.environ["ELASTICSEARCH_URL"]
AUTH = "ApiKey " + base64.b64encode(f'{os.environ["ELASTICSEARCH_API_KEY_ID"]}:{os.environ["ELASTICSEARCH_API_KEY"]}'.encode()).decode()
IDX = os.environ["TEST_INDEX"]
OUT = os.environ["OUT"]
WAIT = int(os.environ.get("MATRIX_WAIT", "25"))


def sql(q):
    r = subprocess.run(["psql", PG, "-At", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-c", q], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr.strip())
    return [line.split("\t") for line in r.stdout.strip().splitlines() if line]


def one(q):
    rows = sql(q)
    return rows[0] if rows else None


def val(q):
    """The first column of the first row, or None when the query finds no row."""
    row = one(q)
    return row[0] if row else None


def doc(sid):
    req = urllib.request.Request(f"{U}/{IDX}/_doc/{sid}", headers={"Authorization": AUTH})
    try:
        return json.load(urllib.request.urlopen(req, timeout=30)).get("_source")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


results = []


def record(field, source, change, outcome, detail=""):
    row = {"field": field, "source": source, "change": change, "outcome": outcome, "detail": detail}
    results.append(row)
    print(f"{outcome:9} {field:34} {source:22} {change:38} {detail}", flush=True)
    # Saved after each row, so a run that stops early keeps what it measured.
    json.dump(results, open(OUT, "w"), ensure_ascii=False, indent=1)


def probe(field, source, change, sid, mutate, expect, wait=WAIT, needs=()):
    """mutate() changes the database; expect(doc) is true once the document follows.
    `needs` holds the seed values the probe uses: a missing one makes the probe n/a."""
    if any(v is None for v in needs):
        record(field, source, change, "n/a", "the seed has no data for this probe")
        return
    try:
        if expect(doc(sid)):
            record(field, source, change, "invalid", "expectation already true before the change")
            return
        mutate()
    except Exception as e:  # a probe that cannot run is a finding, not a crash
        record(field, source, change, "error", str(e)[:120])
        return
    try:
        for i in range(1, wait + 1):
            time.sleep(1)
            if expect(doc(sid)):
                record(field, source, change, "live", f"{i}s")
                return
    except Exception as e:
        record(field, source, change, "error", str(e)[:120])
        return
    record(field, source, change, "not live", f"after {wait}s")


def nested(d, key):
    return [c.get(key) for c in ((d or {}).get("speaker_contributions") or [])]


# A subject with a released meeting, a topic, an introducer, a location and contributions.
SUBJECT = one('''
  SELECT s.id, s."councilMeetingId", s."cityId", s."topicId", s."personId", s."locationId"
  FROM "Subject" s JOIN "CouncilMeeting" m ON m.id = s."councilMeetingId" AND m."cityId" = s."cityId"
  WHERE m.released AND s."topicId" IS NOT NULL AND s."personId" IS NOT NULL AND s."locationId" IS NOT NULL
    AND EXISTS (SELECT 1 FROM "SpeakerContribution" c WHERE c."subjectId" = s.id AND c."speakerId" IS NOT NULL)
  LIMIT 1''')
if not SUBJECT:
    sys.exit("no released subject with a topic, an introducer, a location and a linked contribution: seed the database first")
S, MID, CITY, TOPIC, PERSON, LOC = SUBJECT
print(f"subject {S} meeting {MID} city {CITY} topic {TOPIC} person {PERSON} location {LOC}", flush=True)

# --- Subject (root) columns ---------------------------------------------------------
probe("name", "Subject", "update name", S, lambda: sql(f'''UPDATE "Subject" SET name = name || ' N' WHERE id = '{S}' '''),
      lambda d: d and d.get("name", "").endswith(" N"))
probe("description", "Subject", "update description", S, lambda: sql(f'''UPDATE "Subject" SET description = description || ' D' WHERE id = '{S}' '''),
      lambda d: d and d.get("description", "").endswith(" D"))
probe("context", "Subject", "update context", S, lambda: sql(f'''UPDATE "Subject" SET context = 'Πλαίσιο δοκιμής' WHERE id = '{S}' '''),
      lambda d: d and d.get("context") == "Πλαίσιο δοκιμής")
OTHER_TOPIC = val(f'''SELECT id FROM "Topic" WHERE id <> '{TOPIC}' LIMIT 1''')
probe("topic_id + topic_name", "Subject", "re-link topic", S, lambda: sql(f'''UPDATE "Subject" SET "topicId" = '{OTHER_TOPIC}' WHERE id = '{S}' '''),
      lambda d: d and d.get("topic_id") == OTHER_TOPIC and d.get("topic_name") == one(f'''SELECT name FROM "Topic" WHERE id = '{OTHER_TOPIC}' ''')[0], needs=(OTHER_TOPIC,))
OTHER_PERSON = val(f'''SELECT p.id FROM "Person" p WHERE p."cityId" = '{CITY}' AND p.id <> '{PERSON}' LIMIT 1''')
probe("introduced_by_person_* + party", "Subject", "re-link introducer", S, lambda: sql(f'''UPDATE "Subject" SET "personId" = '{OTHER_PERSON}' WHERE id = '{S}' '''),
      lambda d: d and d.get("introduced_by_person_id") == OTHER_PERSON
      and d.get("introduced_by_party_id") == (one(f'''SELECT party_id FROM "IntroducedByPartyView" WHERE id = '{S}' ''') or [None])[0], needs=(OTHER_PERSON,))
OTHER_LOC = val(f'''SELECT id FROM "Location" WHERE id <> '{LOC}' LIMIT 1''')
probe("location_text (re-link)", "Subject", "re-link location", S, lambda: sql(f'''UPDATE "Subject" SET "locationId" = '{OTHER_LOC}' WHERE id = '{S}' '''),
      lambda d: d and d.get("location_text") == one(f'''SELECT text FROM "Location" WHERE id = '{OTHER_LOC}' ''')[0], needs=(OTHER_LOC,))
LOC = OTHER_LOC

# --- CouncilMeeting -------------------------------------------------------------------
probe("meeting_released", "CouncilMeeting", "released true -> false", S,
      lambda: sql(f'''UPDATE "CouncilMeeting" SET released = false WHERE id = '{MID}' AND "cityId" = '{CITY}' '''),
      lambda d: d and d.get("meeting_released") is False)
probe("meeting_name", "CouncilMeeting", "update name", S,
      lambda: sql(f'''UPDATE "CouncilMeeting" SET name = name || ' M' WHERE id = '{MID}' AND "cityId" = '{CITY}' '''),
      lambda d: d and d.get("meeting_name", "").endswith(" M"))
NEW_DATE = val(f'''SELECT to_char(("dateTime" + interval '1 day') AT TIME ZONE 'UTC', 'YYYY-MM-DD') FROM "CouncilMeeting" WHERE id = '{MID}' AND "cityId" = '{CITY}' ''')
probe("meeting_date", "CouncilMeeting", "move dateTime by 1 day", S,
      lambda: sql(f'''UPDATE "CouncilMeeting" SET "dateTime" = "dateTime" + interval '1 day' WHERE id = '{MID}' AND "cityId" = '{CITY}' '''),
      lambda d: d and (d.get("meeting_date") or "")[:10] == NEW_DATE, needs=(NEW_DATE,))
BODY = val(f'''SELECT "administrativeBodyId" FROM "CouncilMeeting" WHERE id = '{MID}' AND "cityId" = '{CITY}' ''')
OTHER_BODY, OTHER_TYPE = one(f'''SELECT id, type::text FROM "AdministrativeBody" WHERE "cityId" = '{CITY}' AND id IS DISTINCT FROM '{BODY}' AND type::text <> (SELECT type::text FROM "AdministrativeBody" WHERE id = '{BODY}') LIMIT 1''') or (None, None)
if OTHER_BODY:
    probe("administrative_body_id + _type", "CouncilMeeting", "move meeting to another body", S,
          lambda: sql(f'''UPDATE "CouncilMeeting" SET "administrativeBodyId" = '{OTHER_BODY}' WHERE id = '{MID}' AND "cityId" = '{CITY}' '''),
          lambda d: d and d.get("administrative_body_id") == OTHER_BODY and d.get("administrative_body_type") == OTHER_TYPE)
    probe("administrative_body_type", "AdministrativeBody", "change the body's type", S,
          lambda: sql(f'''UPDATE "AdministrativeBody" SET type = (SELECT type FROM "AdministrativeBody" WHERE id = '{BODY}') WHERE id = '{OTHER_BODY}' '''),
          lambda d: d and d.get("administrative_body_type") == one(f'''SELECT type::text FROM "AdministrativeBody" WHERE id = '{BODY}' ''')[0])
else:
    record("administrative_body_id + _type", "CouncilMeeting", "move meeting to another body", "n/a", "no second body of another type in this city")

# --- City, Topic, Person ------------------------------------------------------------
probe("city_name", "City", "update name", S, lambda: sql(f'''UPDATE "City" SET name = name || ' C' WHERE id = '{CITY}' '''),
      lambda d: d and d.get("city_name", "").endswith(" C"))
probe("city_name_en", "City", "update name_en", S, lambda: sql(f'''UPDATE "City" SET name_en = name_en || ' C' WHERE id = '{CITY}' '''),
      lambda d: d and d.get("city_name_en", "").endswith(" C"))
REALM = val(f'''SELECT realm::text FROM "City" WHERE id = '{CITY}' ''')
NEW_REALM = val(f'''SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'Realm' AND e.enumlabel <> '{REALM}' LIMIT 1''')
probe("city_realm", "City", f"realm {REALM} -> {NEW_REALM}", S, lambda: sql(f'''UPDATE "City" SET realm = '{NEW_REALM}' WHERE id = '{CITY}' '''),
      lambda d: d and d.get("city_realm") == NEW_REALM, needs=(NEW_REALM,))
TOPIC = OTHER_TOPIC
probe("topic_name", "Topic", "update name", S, lambda: sql(f'''UPDATE "Topic" SET name = name || ' T' WHERE id = '{TOPIC}' '''),
      lambda d: d and d.get("topic_name", "").endswith(" T"), needs=(TOPIC,))
probe("topic_name_en", "Topic", "update name_en", S, lambda: sql(f'''UPDATE "Topic" SET name_en = name_en || ' T' WHERE id = '{TOPIC}' '''),
      lambda d: d and d.get("topic_name_en", "").endswith(" T"), needs=(TOPIC,))
PERSON = OTHER_PERSON
probe("introduced_by_person_name", "Person", "update name", S, lambda: sql(f'''UPDATE "Person" SET name = name || ' P' WHERE id = '{PERSON}' '''),
      lambda d: d and d.get("introduced_by_person_name", "").endswith(" P"), needs=(PERSON,))
probe("introduced_by_person_name_en", "Person", "update name_en", S, lambda: sql(f'''UPDATE "Person" SET name_en = name_en || ' P' WHERE id = '{PERSON}' '''),
      lambda d: d and d.get("introduced_by_person_name_en", "").endswith(" P"), needs=(PERSON,))

# --- Location ---------------------------------------------------------------------------
probe("location_text", "Location", "update text", S, lambda: sql(f'''UPDATE "Location" SET text = text || ' L' WHERE id = '{LOC}' '''),
      lambda d: d and (d.get("location_text") or "").endswith(" L"))
NEW_GEO = json.dumps(json.loads(one(f'''SELECT ST_AsGeoJSON(ST_Translate(coordinates, 0.01, 0)) FROM "Location" WHERE id = '{LOC}' ''')[0]), sort_keys=True)
probe("location_geojson", "Location", "move coordinates", S,
      lambda: sql(f'''UPDATE "Location" SET coordinates = ST_Translate(coordinates, 0.01, 0) WHERE id = '{LOC}' '''),
      lambda d: d and json.dumps(d.get("location_geojson"), sort_keys=True) == NEW_GEO)

# --- Party fields (introducer) -----------------------------------------------------------
X = (one(f'''SELECT party_id FROM "IntroducedByPartyView" WHERE id = '{S}' ''') or [None])[0]
Y = val(f'''SELECT id FROM "Party" WHERE "cityId" = '{CITY}' AND id IS DISTINCT FROM '{X}' LIMIT 1''')
probe("introduced_by_party_id", "Role", "backdated role (correction)", S,
      lambda: sql(f'''INSERT INTO "Role" (id, "personId", "partyId", "cityId", "isHead", "startDate", "createdAt", "updatedAt") VALUES ('test-mx-role', '{PERSON}', '{Y}', '{CITY}', true, '2000-01-01', now(), now())'''),
      lambda d: d and d.get("introduced_by_party_id") == Y, needs=(Y,))
probe("introduced_by_party_name", "Party", "rename party", S,
      lambda: sql(f'''UPDATE "Party" SET name = name || ' Π' WHERE id = '{Y}' '''),
      lambda d: d and (d.get("introduced_by_party_name") or "").endswith(" Π"), needs=(Y,))

# --- Contributions -----------------------------------------------------------------------
C_SPEAKER = val(f'''SELECT "speakerId" FROM "SpeakerContribution" WHERE "subjectId" = '{S}' AND "speakerId" IS NOT NULL LIMIT 1''')
COUNT_AFTER = int(one(f'''SELECT count(*) FROM "SpeakerContribution" WHERE "subjectId" = '{S}' ''')[0]) + 1
probe("speaker_contributions + contributor_count", "SpeakerContribution", "insert, unlinked speaker", S,
      lambda: sql(f'''INSERT INTO "SpeakerContribution" (id, text, "subjectId", "speakerId", "speakerName", "createdAt", "updatedAt") VALUES ('test-mx-c1', 'Νέα τοποθέτηση', '{S}', NULL, 'Γεώργιος Δοκιμαστής', now(), now())'''),
      lambda d: "Γεώργιος Δοκιμαστής" in nested(d, "speaker_name") and (d or {}).get("contributor_count") == COUNT_AFTER)
probe("speaker_contributions (edit text)", "SpeakerContribution", "update text in place", S,
      lambda: sql('''UPDATE "SpeakerContribution" SET text = 'Αλλαγμένη τοποθέτηση' WHERE id = 'test-mx-c1' '''),
      lambda d: "Αλλαγμένη τοποθέτηση" in nested(d, "text"))
probe("speaker_contributions (delete)", "SpeakerContribution", "delete one contribution", S,
      lambda: sql('''DELETE FROM "SpeakerContribution" WHERE id = 'test-mx-c1' '''),
      lambda d: "Γεώργιος Δοκιμαστής" not in nested(d, "speaker_name"))
probe("speaker_person_name", "Person", "rename a speaker", S,
      lambda: sql(f'''UPDATE "Person" SET name = name || ' Σ' WHERE id = '{C_SPEAKER}' '''),
      lambda d: any((n or "").endswith(" Σ") for n in nested(d, "speaker_person_name")), needs=(C_SPEAKER,))
SEG = one(f'''SELECT u.id FROM "Utterance" u WHERE u."discussionSubjectId" = '{S}' AND u."discussionStatus"::text = 'SUBJECT_DISCUSSION' LIMIT 1''')
if SEG:
    before = (doc(S) or {}).get("discussion_speaking_seconds")
    probe("discussion_speaking_seconds", "Utterance", "untag one discussion utterance", S,
          lambda: sql(f'''UPDATE "Utterance" SET "discussionStatus" = NULL WHERE id = '{SEG[0]}' '''),
          lambda d: d and d.get("discussion_speaking_seconds") != before)
else:
    record("discussion_speaking_seconds", "Utterance", "untag one discussion utterance", "n/a", "subject has no tagged utterance")

# --- Root lifecycle ------------------------------------------------------------------------
probe("document (delete)", "Subject", "delete the subject", S, lambda: sql(f'''DELETE FROM "Subject" WHERE id = '{S}' '''),
      lambda d: d is None)

json.dump(results, open(OUT, "w"), ensure_ascii=False, indent=1)
print(f"done: {OUT}")
