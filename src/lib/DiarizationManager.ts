import { Diarization, Utterance, Word } from "../types";


export class DiarizationManager {
    private diarization: Diarization;
    private speakerMap: Map<string, number>;
    private config: { maxDriftCost: number } = { maxDriftCost: 1 };
    private totalDrift: number;

    constructor(diarization: Diarization) {
        this.diarization = diarization;
        this.speakerMap = this.buildSpeakerMap();
        this.totalDrift = 0;
    }

    private buildSpeakerMap(): Map<string, number> {
        const map = new Map<string, number>();
        let speakerNumber = 1;
        for (const d of this.diarization) {
            if (!map.has(d.speaker)) {
                map.set(d.speaker, speakerNumber++);
            }
        }
        return map;
    }

    private findDiarizationsContainingInterval(start: number, end: number): Diarization {
        return this.diarization.filter((d) => d.start <= start && d.end >= end);
    }
    public findSpeakersWithDriftForUtterance(utterance: Utterance): Array<{ speaker: number, drift: number }> {
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
                const diarizations = this.findDiarizationsContainingInterval(word.start, word.end);
                const speakerDiarization = diarizations.find(d => d.speaker === speaker);
                if (speakerDiarization) {
                    const drift = Math.pow(Math.abs(speakerDiarization.start - word.start), 2) +
                        Math.pow(Math.abs(speakerDiarization.end - word.end), 2);
                    totalDrift += drift;
                }
            }
            speakersWithDrift[speaker] = totalDrift;
        }

        return Array.from(speakersWithFullWordCoverage).map(speaker => ({
            speaker: this.speakerMap.get(speaker)!,
            drift: Math.sqrt(speakersWithDrift[speaker])
        }));
    }

    public findSpeakersForUtterance(utterance: Utterance): number[] {
        return this.findSpeakersWithDriftForUtterance(utterance).map(s => s.speaker);
    }

    public findBestSpeakerForUtterance(utterance: Utterance): number | null {
        const speakersWithDrift = this.findSpeakersWithDriftForUtterance(utterance);

        if (speakersWithDrift.length === 0) {
            return null;
        }

        if (speakersWithDrift.length === 1) {
            return speakersWithDrift[0].speaker;
        }


        const best = speakersWithDrift.reduce((best, current) =>
            current.drift < best.drift ? current : best
        );

        if (best.drift > this.config.maxDriftCost) {
            return null;
        }

        this.totalDrift += best.drift;

        console.log(`Warning: Utterance "${utterance.text}" (${formatTime(utterance.start)}-${formatTime(utterance.end)}) has ${speakersWithDrift.length} speakers, picking the best one with cost ${best.drift}`);

        return best.speaker;
    }

    public getDriftCost(): number {
        return this.totalDrift;
    }

}


function formatTime(time: number): string {
    // returns hh:mm:ss
    const hours = Math.floor(time / 3600);
    const minutes = Math.floor((time % 3600) / 60);
    const seconds = Math.floor(time % 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}