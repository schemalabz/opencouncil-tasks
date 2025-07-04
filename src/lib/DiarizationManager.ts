import { Diarization, Utterance, SpeakerIdentificationResult, DiarizationSpeaker } from "../types.js";

export class DiarizationManager {
    private diarization: Diarization;
    private speakerMap: Map<string, number>;  // Maps diarization speaker IDs to numeric IDs
    private speakerIdentificationMap: Map<number, SpeakerIdentificationResult>;  // Maps numeric IDs to speaker info
    private config: { maxDriftCost: number } = { maxDriftCost: Number.POSITIVE_INFINITY };
    private totalDrift: number;

    constructor(diarization: Diarization, speakers: DiarizationSpeaker[]) {
        this.diarization = diarization;
        this.speakerIdentificationMap = new Map();
        this.speakerMap = this.buildSpeakerMaps(speakers);
        this.totalDrift = 0;
    }

    /**
     * Builds a mapping from diarization speaker IDs to sequential numbers
     * 
     * This ensures consistent speaker numbering regardless of
     * the speaker IDs returned by the diarization API
     */
    private buildSpeakerMaps(speakers: DiarizationSpeaker[]): Map<string, number> {
        const map = new Map<string, number>();
        let speakerNumber = 1;
        for (const speaker of speakers) {
            const speakerKey = speaker.match ?? speaker.speaker;
            if (!map.has(speakerKey)) {
                map.set(speakerKey, speakerNumber);
                // Store speaker identification info with the numeric ID as the speaker identifier
                this.speakerIdentificationMap.set(speakerNumber, { ...speaker, speaker: speakerNumber });
                speakerNumber++;
            }
        }
        return map;
    }

    private findDiarizationsContainingInterval(start: number, end: number): Diarization {
        return this.diarization.filter((d) => d.start <= start && d.end >= end);
    }

    private findClosestDiarizationForSpeaker(speaker: string, wordStart: number, wordEnd: number): { start: number; end: number; speaker: string; } {
        const diarizations = this.diarization.filter(d => d.speaker === speaker);

        const closest = diarizations.reduce((closest, current) => {
            if (current.start <= wordStart && current.end >= wordEnd) {
                // the diarization fully contains the word
                return current;
            }

            const closestTimeDifference = Math.abs(closest.start - wordStart) + Math.abs(closest.end - wordEnd);
            const currentTimeDifference = Math.abs(current.start - wordStart) + Math.abs(current.end - wordEnd);
            return currentTimeDifference < closestTimeDifference ? current : closest;
        });

        return closest;
    }

    private findSpeakersWithDriftForUtterance(utterance: Utterance): Array<{ speaker: number, drift: number }> {
        const speakersWithFullWordCoverage = new Set<string>();
        const speakersWithDrift: { [speaker: string]: number } = {};

        // Step 1: Find speakers with full word coverage
        for (const word of utterance.words) {
            const diarizations = this.findDiarizationsContainingInterval(word.start, word.end);
            for (const d of diarizations) {
                speakersWithFullWordCoverage.add(d.speaker);
            }
        }

        // Step 2: Compute drift for speakers with full word coverage
        for (const speaker of speakersWithFullWordCoverage) {
            let totalDrift = 0;
            for (const word of utterance.words) {
                const speakerDiarization = this.findClosestDiarizationForSpeaker(speaker, word.start, word.end);
                if (speakerDiarization.start <= word.start && speakerDiarization.end >= word.end) {
                    continue;
                }
                const drift = Math.pow(Math.abs(speakerDiarization.start - word.start), 2) +
                    Math.pow(Math.abs(speakerDiarization.end - word.end), 2);
                totalDrift += drift;
            }
            speakersWithDrift[speaker] = totalDrift;
        }

        return Array.from(speakersWithFullWordCoverage).map(speaker => ({
            speaker: this.speakerMap.get(speaker)!,
            drift: Math.sqrt(speakersWithDrift[speaker])
        }));
    }

    private findSpeakersForUtterance(utterance: Utterance): { speaker: number, drift: number }[] {
        return this.findSpeakersWithDriftForUtterance(utterance);
    }

    public findBestSpeakerForUtterance(utterance: Utterance): { speaker: number, drift: number } | null {
        // First check for simple case - utterance overlaps with exactly one diarization segment
        const overlappingDiarizations = this.diarization.filter((d) => {
            return (d.start <= utterance.end && d.start >= utterance.start) || // starts in utterance 
                (d.end <= utterance.end && d.end >= utterance.start) || // ends in utterance
                (d.start <= utterance.start && d.end >= utterance.end); // contains utterance
        });

        if (overlappingDiarizations.length === 1) {
            return {
                speaker: this.speakerMap.get(overlappingDiarizations[0].speaker)!,
                drift: 0
            };
        }

        // Complex case - compute drift for potential speaker matches
        const speakersWithDrift = this.findSpeakersWithDriftForUtterance(utterance);

        if (speakersWithDrift.length === 0) {
            return null;
        }

        if (speakersWithDrift.length === 1) {
            return speakersWithDrift[0];
        }

        const best = speakersWithDrift.reduce((best, current) =>
            current.drift < best.drift ? current : best
        );

        if (best.drift > this.config.maxDriftCost) {
            return null;
        }

        this.totalDrift += best.drift;

        console.log(`Warning: Utterance "${utterance.text}" (${formatTime(utterance.start)}-${formatTime(utterance.end)}) has ${speakersWithDrift.length} speakers, picking the best one with cost ${best.drift}`);

        return best;
    }

    public getDriftCost(): number {
        return this.totalDrift;
    }

    public getSpeakerInfo(): SpeakerIdentificationResult[] {
        return Array.from(this.speakerIdentificationMap.values());
    }
}

function formatTime(time: number): string {
    // returns hh:mm:ss
    const hours = Math.floor(time / 3600);
    const minutes = Math.floor((time % 3600) / 60);
    const seconds = Math.floor(time % 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}